import type { Pool, PoolClient } from "pg";
import type {
  SalesStaffActor,
  SalesStaffRepository,
  ManagedSalesStaff,
} from "../repositories/sales-staff.js";
import type { LoginCredential } from "../repositories/authentication.js";
import {
  checkedNewSalesStaff,
  salesStaffId,
  SalesStaffError,
  validSalesStaffTransition,
  checkedStaffPage,
} from "../services/sales-staff.js";
import { SessionError } from "../services/session-state.js";
import { salesStaffActor } from "./sales-staff-state.js";
import { lockedSession } from "./postgres-sessions.js";
type UserRow = Omit<LoginCredential, "companyStatus"> & { email: string };
const projection =
  'id,company_id AS "companyId",display_name AS "displayName",email,role,status,password_hash AS "passwordHash",must_change_password AS "mustChangePassword"';
const view = (row: UserRow): ManagedSalesStaff => ({
  id: row.id,
  companyId: null,
  displayName: row.displayName,
  email: row.email,
  role: "SALES_STAFF",
  status: row.status as ManagedSalesStaff["status"],
  mustChangePassword: row.mustChangePassword,
});
export function createPostgresSalesStaff(
  pool: Pool,
  now = Date.now,
): SalesStaffRepository {
  async function run<T>(
    identity: SalesStaffActor,
    targetId: string | undefined,
    work: (client: PoolClient, users: UserRow[]) => Promise<T>,
  ): Promise<T> {
    salesStaffId(identity.userId);
    salesStaffId(identity.sessionId);
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      throw new SalesStaffError("unavailable");
    }
    let broken = false;
    const onError = () => {
      broken = true;
    };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      const users = (
        await client.query<UserRow>(
          `SELECT ${projection} FROM users WHERE id=$1 OR (id=$2 AND company_id IS NULL AND role='SALES_STAFF') ORDER BY id FOR UPDATE`,
          [identity.userId, targetId ?? null],
        )
      ).rows;
      const user = users.find((u) => u.id === identity.userId),
        account = user ? { ...user, companyStatus: null } : null;
      const session = await lockedSession(client, identity.sessionId);
      salesStaffActor(identity, account, session, now());
      const result = await work(client, users);
      salesStaffActor(identity, account, session, now());
      if (broken) throw new SalesStaffError("unavailable");
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      if (e instanceof SalesStaffError || e instanceof SessionError) throw e;
      if (e && typeof e === "object" && "code" in e && e.code === "23505")
        throw new SalesStaffError("conflict");
      throw new SalesStaffError("unavailable");
    } finally {
      client.off("error", onError);
      client.release(broken);
    }
  }
  return {
    list: (actor, input) => {
      const page = checkedStaffPage(input);
      return run(actor, undefined, async (client) => {
        const result = await client.query<{
          total: number;
          items: ManagedSalesStaff[];
        }>(
          `WITH matching AS MATERIALIZED (SELECT id,company_id AS "companyId",display_name AS "displayName",email,role,status,must_change_password AS "mustChangePassword" FROM users WHERE company_id IS NULL AND role='SALES_STAFF'), page AS (SELECT * FROM matching ORDER BY id LIMIT $1 OFFSET $2) SELECT (SELECT count(*)::integer FROM matching) AS total, COALESCE((SELECT jsonb_agg(p ORDER BY p.id) FROM page p),'[]'::jsonb) AS items`,
          [page.limit, page.offset],
        );
        if (!result.rows[0]) throw new SalesStaffError("unavailable");
        return result.rows[0];
      });
    },
    create: (actor, value) => {
      const input = checkedNewSalesStaff(value);
      return run(actor, undefined, async (client) => {
        const row = (
          await client.query<UserRow>(
            `INSERT INTO users(id,company_id,email,password_hash,display_name,role,status,must_change_password) VALUES($1,NULL,$2,$3,$4,'SALES_STAFF','ACTIVE',true) RETURNING ${projection}`,
            [input.id, input.email, input.passwordHash, input.displayName],
          )
        ).rows[0]!;
        return view(row);
      });
    },
    change: (actor, id, expected, next) => {
      const key = salesStaffId(id);
      if (!validSalesStaffTransition(expected, next))
        throw new SalesStaffError("invalid_input");
      return run(actor, key, async (client, users) => {
        const target = users.find(
          (u) =>
            u.id === key && u.companyId === null && u.role === "SALES_STAFF",
        );
        if (!target) throw new SalesStaffError("not_found");
        if (target.status !== expected) throw new SalesStaffError("conflict");
        const row = (
          await client.query<UserRow>(
            `UPDATE users SET status=$3,updated_at=$1 WHERE id=$2 RETURNING ${projection}`,
            [new Date(now()).toISOString(), key, next],
          )
        ).rows[0]!;
        await client.query(
          "UPDATE user_sessions SET revoked_at=COALESCE(revoked_at,$1) WHERE user_id=$2",
          [new Date(now()).toISOString(), key],
        );
        return view(row);
      });
    },
  };
}
