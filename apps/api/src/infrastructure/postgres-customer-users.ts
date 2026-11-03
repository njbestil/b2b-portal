import type { Pool, PoolClient } from "pg";
import type {
  CustomerUserActor,
  CustomerUserRepository,
  ManagedCustomerUser,
} from "../repositories/customer-users.js";
import type { LoginCredential } from "../repositories/authentication.js";
import {
  checkedNewCustomerUser,
  customerUserId,
  CustomerUserError,
} from "../services/customer-users.js";
import { SessionError } from "../services/session-state.js";
import { customerUserActor } from "./customer-user-state.js";
import { lockedSession } from "./postgres-sessions.js";
type UserRow = Omit<LoginCredential, "companyStatus"> & { email: string };
const projection =
  'id,company_id AS "companyId",display_name AS "displayName",email,role,status,password_hash AS "passwordHash",must_change_password AS "mustChangePassword"';
const view = (row: UserRow): ManagedCustomerUser => ({
  id: row.id,
  companyId: row.companyId!,
  displayName: row.displayName,
  email: row.email,
  role: "CUSTOMER_USER",
  status: row.status as ManagedCustomerUser["status"],
  mustChangePassword: row.mustChangePassword,
});
export function createPostgresCustomerUsers(
  pool: Pool,
  now = Date.now,
): CustomerUserRepository {
  async function run<T>(
    identity: CustomerUserActor,
    targetId: string | undefined,
    work: (client: PoolClient, users: UserRow[]) => Promise<T>,
  ): Promise<T> {
    customerUserId(identity.userId);
    customerUserId(identity.companyId);
    customerUserId(identity.sessionId);
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      throw new CustomerUserError("unavailable");
    }
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
          "SELECT status FROM companies WHERE id=$1 FOR SHARE",
          [identity.companyId],
        )
      ).rows[0];
      const users = (
        await client.query<UserRow>(
          `SELECT ${projection} FROM users WHERE id=$1 OR (id=$2 AND company_id=$3 AND role='CUSTOMER_USER') ORDER BY id FOR UPDATE`,
          [identity.userId, targetId ?? null, identity.companyId],
        )
      ).rows;
      const user = users.find((u) => u.id === identity.userId),
        account = user
          ? { ...user, companyStatus: company?.status ?? null }
          : null;
      const session = await lockedSession(client, identity.sessionId);
      customerUserActor(identity, account, session, now());
      const result = await work(client, users);
      customerUserActor(identity, account, session, now());
      if (broken) throw new CustomerUserError("unavailable");
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      if (e instanceof CustomerUserError || e instanceof SessionError) throw e;
      if (e && typeof e === "object" && "code" in e && e.code === "23505")
        throw new CustomerUserError("conflict");
      throw new CustomerUserError("unavailable");
    } finally {
      client.off("error", onError);
      client.release(broken);
    }
  }
  return {
    create: (actor, value) => {
      const input = checkedNewCustomerUser(value);
      return run(actor, undefined, async (client) => {
        const row = (
          await client.query<UserRow>(
            `INSERT INTO users(id,company_id,email,password_hash,display_name,role,status,must_change_password) VALUES($1,$2,$3,$4,$5,'CUSTOMER_USER','ACTIVE',true) RETURNING ${projection}`,
            [
              input.id,
              actor.companyId,
              input.email,
              input.passwordHash,
              input.displayName,
            ],
          )
        ).rows[0]!;
        return view(row);
      });
    },
    deactivate: (actor, id, expected) => {
      const key = customerUserId(id);
      if (!["ACTIVE", "SUSPENDED"].includes(expected))
        throw new CustomerUserError("invalid_input");
      return run(actor, key, async (client, users) => {
        const target = users.find(
          (u) =>
            u.id === key &&
            u.companyId === actor.companyId &&
            u.role === "CUSTOMER_USER",
        );
        if (!target) throw new CustomerUserError("not_found");
        if (target.status !== expected) throw new CustomerUserError("conflict");
        const row = (
          await client.query<UserRow>(
            `UPDATE users SET status='DEACTIVATED',updated_at=$1 WHERE id=$2 RETURNING ${projection}`,
            [new Date(now()).toISOString(), key],
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
