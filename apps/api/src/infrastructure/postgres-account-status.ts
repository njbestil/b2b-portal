import type { Pool, PoolClient } from "pg";
import type { LoginCredential } from "../repositories/authentication.js";
import type {
  AccountStatusRepository,
  StatusActor,
  StatusTarget,
  StatusTargetKind,
} from "../repositories/account-status.js";
import { AccountStatusError, statusId } from "../services/account-status.js";
import { SessionError } from "../services/session-state.js";
import { lockedSession } from "./postgres-sessions.js";
import { statusActor } from "./account-status-state.js";
type UserRow = Omit<LoginCredential, "companyStatus">;
export function createPostgresAccountStatus(
  pool: Pool,
  now = Date.now,
): AccountStatusRepository {
  async function run<T>(
    actor: StatusActor,
    kind: StatusTargetKind,
    id: string,
    write: boolean,
    work: (client: PoolClient, target: StatusTarget) => Promise<T>,
  ): Promise<T> {
    statusId(actor.userId);
    statusId(actor.sessionId);
    statusId(id);
    if (kind !== "user" && kind !== "company")
      throw new AccountStatusError("invalid_input");
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      throw new AccountStatusError("unavailable");
    }
    let broken = false;
    const onError = () => {
      broken = true;
    };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      const before =
        kind === "user"
          ? (
              await client.query<{ companyId: string | null }>(
                'SELECT company_id AS "companyId" FROM users WHERE id=$1',
                [id],
              )
            ).rows[0]
          : null;
      const companyId = kind === "company" ? id : (before?.companyId ?? null);
      // Same global order as session/credential writers: company, users, session.
      const company = companyId
        ? (
            await client.query<{ id: string; status: StatusTarget["status"] }>(
              "SELECT id,status FROM companies WHERE id=$1 FOR " +
                (kind === "company" && write ? "UPDATE" : "SHARE"),
              [companyId],
            )
          ).rows[0]
        : null;
      const ids = kind === "user" ? [actor.userId, id] : [actor.userId];
      const users = (
        await client.query<UserRow>(
          `SELECT id,company_id AS "companyId",display_name AS "displayName",role,status,password_hash AS "passwordHash",must_change_password AS "mustChangePassword"
        FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
          [ids],
        )
      ).rows;
      const admin = users.find((u) => u.id === actor.userId);
      statusActor(
        actor,
        admin ? { ...admin, companyStatus: null } : null,
        await lockedSession(client, actor.sessionId),
        now(),
      );
      const user = kind === "user" ? users.find((u) => u.id === id) : null;
      if (
        kind === "user" &&
        user &&
        (!before || user.companyId !== before.companyId)
      )
        throw new AccountStatusError("conflict");
      if ((kind === "company" && !company) || (kind === "user" && !user))
        throw new AccountStatusError("not_found");
      if (companyId && !company) throw new AccountStatusError("unavailable");
      const target: StatusTarget = {
        id,
        kind,
        status: kind === "company" ? company!.status : user!.status,
        companyId,
      };
      const result = await work(client, target);
      if (broken) throw new AccountStatusError("unavailable");
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      if (e instanceof AccountStatusError || e instanceof SessionError) throw e;
      throw new AccountStatusError("unavailable");
    } finally {
      client.off("error", onError);
      client.release(broken);
    }
  }
  return {
    current: (actor, kind, id) =>
      run(actor, kind, id, false, async (_client, target) => target),
    change: (actor, kind, id, expected, next) =>
      run(actor, kind, id, true, async (client, target) => {
        if (kind === "user" && id === actor.userId)
          throw new AccountStatusError("forbidden");
        if (
          !["ACTIVE", "SUSPENDED"].includes(expected) ||
          !["ACTIVE", "SUSPENDED"].includes(next) ||
          expected === next
        )
          throw new AccountStatusError("invalid_input");
        if (target.status !== expected)
          throw new AccountStatusError("conflict");
        await client.query(
          kind === "user"
            ? "UPDATE users SET status=$1,updated_at=$2 WHERE id=$3"
            : "UPDATE companies SET status=$1,updated_at=$2 WHERE id=$3",
          [next, new Date(now()).toISOString(), id],
        );
        await client.query(
          kind === "user"
            ? "UPDATE user_sessions SET revoked_at=COALESCE(revoked_at,$1) WHERE user_id=$2"
            : "UPDATE user_sessions SET revoked_at=COALESCE(revoked_at,$1) WHERE user_id IN (SELECT id FROM users WHERE company_id=$2)",
          [new Date(now()).toISOString(), id],
        );
        return { ...target, status: next };
      }),
  };
}
