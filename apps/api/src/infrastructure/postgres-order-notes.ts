import type { Pool } from "pg";
import type { OrderNotesRepository } from "../repositories/order-notes.js";
import type { LoginCredential } from "../repositories/authentication.js";
import { InternalNoteError } from "../services/internal-notes.js";
import { SessionError } from "../services/session-state.js";
import { CompanyProfileError } from "../services/company-profiles.js";
import { checkedAssignments } from "../services/sales-assignments.js";
import { profileActor } from "./company-profile-state.js";
import { lockedSession } from "./postgres-sessions.js";
import { createPostgresInternalNotes } from "./postgres-internal-notes.js";
export function createPostgresOrderNotes(
  pool: Pool,
  now = Date.now,
): OrderNotesRepository {
  return {
    async run(actor, companyId, operation) {
      const client = await pool.connect().catch(() => {
        throw new InternalNoteError("storage_failed");
      });
      let broken = false;
      const onError = () => {
        broken = true;
      };
      client.on("error", onError);
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='5s'");
        const company = (
          await client.query(
            "SELECT status FROM companies WHERE id=$1 FOR UPDATE",
            [companyId],
          )
        ).rows[0];
        const account =
          (
            await client.query<LoginCredential>(
              'SELECT id,company_id AS "companyId",display_name AS "displayName",role,status,password_hash AS "passwordHash",must_change_password AS "mustChangePassword" FROM users WHERE id=$1 FOR UPDATE',
              [actor.userId],
            )
          ).rows[0] ?? null;
        const session = await lockedSession(client, actor.sessionId);
        let assigned = false;
        if (actor.role === "SALES_STAFF") {
          const rows = (
            await client.query(
              'SELECT id,company_id AS "companyId",sales_staff_user_id AS "salesStaffUserId",assigned_by_user_id AS "assignedByUserId",is_primary AS "isPrimary",active,created_at AS "createdAt",ended_at AS "endedAt" FROM customer_sales_assignments WHERE company_id=$1 FOR SHARE',
              [companyId],
            )
          ).rows;
          assigned = checkedAssignments(
            rows.map((r) => ({
              ...r,
              createdAt: r.createdAt.toISOString(),
              endedAt: r.endedAt?.toISOString() ?? null,
            })),
          ).some(
            (r) =>
              r.salesStaffUserId === actor.userId &&
              r.active &&
              r.isPrimary &&
              r.endedAt === null &&
              Date.parse(r.createdAt) <= now(),
          );
        }
        const check = () =>
          profileActor(
            actor,
            account
              ? {
                  ...account,
                  companyStatus:
                    account.companyId === companyId
                      ? (company?.status ?? null)
                      : null,
                }
              : null,
            session,
            companyId,
            company?.status ?? null,
            assigned,
            false,
            now(),
          );
        check();
        const result = await operation(createPostgresInternalNotes(client));
        check();
        if (broken) throw new InternalNoteError("storage_failed");
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {
          broken = true;
        });
        if (
          e instanceof InternalNoteError ||
          e instanceof SessionError ||
          e instanceof CompanyProfileError
        )
          throw e;
        throw new InternalNoteError("storage_failed");
      } finally {
        client.off("error", onError);
        client.release(broken);
      }
    },
  };
}
