import type { Pool, PoolClient } from "pg";
import type {
  ApplicationReviewRepository,
  ReviewActor,
  ApplicationDecision,
} from "../repositories/application-reviews.js";
import type { LoginCredential } from "../repositories/authentication.js";
import {
  reviewActor,
  pendingReview,
  checkedDecision,
  newDecision,
  replay,
} from "./application-review-state.js";
import { lockedSession } from "./postgres-sessions.js";
import { ReviewError } from "../services/application-decisions.js";
import { SessionError } from "../services/session-state.js";
import { checkedPending } from "../services/applications.js";

const bundle = `SELECT c.id AS "companyId",c.created_at AS "createdAt",u.id AS "administratorUserId",d.id AS "deliveryAddressId",
  c.legal_name AS "companyName",c.trade_license_reference AS "tradeLicenseReference",c.contact_email AS "businessEmail",c.contact_phone AS phone,c.billing_address->>'line1' AS "billingAddress",
  d.address->>'line1' AS "deliveryAddress",u.display_name AS "administratorName",u.email AS "administratorEmail",u.mobile AS "administratorMobile"
  FROM companies c JOIN users u ON u.id=c.initial_admin_user_id AND u.company_id=c.id
  JOIN delivery_addresses d ON d.id=c.initial_delivery_address_id AND d.company_id=c.id AND d.active AND d.is_default
  WHERE c.status='PENDING' AND u.status='PENDING' AND u.role='CUSTOMER_ADMIN' AND u.must_change_password=true AND u.password_hash ~ '^scrypt-v1\\$[a-f0-9]{32}\\$[a-f0-9]{64}$'`;
export function createPostgresApplicationReviews(
  pool: Pool,
  now = Date.now,
): ApplicationReviewRepository {
  async function run<T>(
    actor: ReviewActor,
    target: string | null,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      throw new ReviewError("unavailable");
    }
    let broken = false;
    const onError = () => {
      broken = true;
    };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      // Same company -> sorted users -> actor session order as other account writers.
      let initialAdmin: string | null = null;
      if (target)
        initialAdmin =
          (
            await client.query(
              "SELECT initial_admin_user_id AS id FROM companies WHERE id=$1 FOR UPDATE",
              [target],
            )
          ).rows[0]?.id ?? null;
      const users = (
        await client.query<LoginCredential>(
          `SELECT id,company_id AS "companyId",display_name AS "displayName",role,status,password_hash AS "passwordHash",must_change_password AS "mustChangePassword",NULL::text AS "companyStatus" FROM users WHERE id=$1 OR id=$2 ORDER BY id FOR UPDATE`,
          [actor.userId, initialAdmin],
        )
      ).rows;
      const account = users.find((u) => u.id === actor.userId) ?? null;
      const session = await lockedSession(client, actor.sessionId);
      reviewActor(actor, account, session, now());
      const result = await work(client);
      reviewActor(actor, account, session, now());
      if (broken) throw new ReviewError("unavailable");
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      if (e instanceof ReviewError || e instanceof SessionError) throw e;
      throw new ReviewError("unavailable");
    } finally {
      client.off("error", onError);
      client.release(broken);
    }
  }
  async function decision(client: PoolClient, id: string) {
    const row = (
      await client.query(
        "SELECT record FROM application_reviews WHERE company_id=$1",
        [id],
      )
    ).rows[0];
    if (!row) return null;
    const record = checkedDecision(row.record as ApplicationDecision);
    if (record.application.companyId !== id)
      throw new ReviewError("unavailable");
    return record;
  }
  async function pending(client: PoolClient, id: string) {
    const row = (await client.query(bundle + " AND c.id=$1", [id])).rows[0];
    return row
      ? pendingReview(
          checkedPending({ ...row, createdAt: row.createdAt.toISOString() }),
        )
      : null;
  }
  return {
    list: (actor, offset, limit) =>
      run(actor, null, async (client) => {
        // Filter and validate complete bundles before count/page; one statement snapshot.
        const rows = (await client.query(bundle + " ORDER BY c.id")).rows.map(
          (row) =>
            pendingReview(
              checkedPending({
                ...row,
                createdAt: row.createdAt.toISOString(),
              }),
            ),
        );
        return {
          items: rows.slice(offset, offset + limit),
          total: rows.length,
        };
      }),
    detail: (actor, id) =>
      run(
        actor,
        id,
        async (client) =>
          (await decision(client, id))?.application ??
          (await pending(client, id)),
      ),
    decide: (actor, id, command) =>
      run(actor, id, async (client) => {
        const existing = await decision(client, id);
        if (existing) return replay(existing, command);
        const application = await pending(client, id);
        if (!application) throw new ReviewError("not_found");
        const record = newDecision(application, actor, command, now()),
          status = command.decision === "approve" ? "ACTIVE" : "REJECTED";
        await client.query(
          "UPDATE companies SET status=$1,rejection_reason=$2,updated_at=$3 WHERE id=$4",
          [status, command.reason, record.decidedAt, id],
        );
        await client.query(
          "UPDATE users SET status=$1,updated_at=$2 WHERE id=$3 AND company_id=$4",
          [status, record.decidedAt, application.administratorUserId, id],
        );
        await client.query(
          "INSERT INTO application_reviews(company_id,record) VALUES($1,$2::jsonb)",
          [id, JSON.stringify(record)],
        );
        return record;
      }),
    effect: (actor, id, key, expected, next) =>
      run(actor, id, async (client) => {
        const record = await decision(client, id);
        if (!record || record.application[key] !== expected) return false;
        await client.query(
          "UPDATE application_reviews SET record=$1::jsonb WHERE company_id=$2",
          [
            JSON.stringify({
              ...record,
              application: { ...record.application, [key]: next },
            }),
            id,
          ],
        );
        return true;
      }),
  };
}
