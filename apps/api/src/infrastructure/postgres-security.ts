import type { Pool, PoolClient } from "pg";
import type { LoginCredential } from "../repositories/authentication.js";
import { SessionError } from "../services/session-state.js";

/** Common lock order: company (if any), user, then session. Credential/account
 * writers must use this boundary and recheck association after locks. */
export async function withSecurityAccount<T>(
  pool: Pool,
  userId: string,
  operation: (
    client: PoolClient,
    account: LoginCredential | null,
  ) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  const onError = () => {
    broken = true;
  };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const before = (
      await client.query<{ companyId: string | null }>(
        'SELECT company_id AS "companyId" FROM users WHERE id=$1',
        [userId],
      )
    ).rows[0];
    const company = before?.companyId
      ? (
          await client.query<{ status: LoginCredential["companyStatus"] }>(
            "SELECT status FROM companies WHERE id=$1 FOR SHARE",
            [before.companyId],
          )
        ).rows[0]
      : null;
    const user = (
      await client.query<LoginCredential>(
        `SELECT id, company_id AS "companyId", display_name AS "displayName", role, status,
      password_hash AS "passwordHash", must_change_password AS "mustChangePassword"
      FROM users WHERE id=$1 FOR UPDATE`,
        [userId],
      )
    ).rows[0];
    if (user && (!before || user.companyId !== before.companyId))
      throw new SessionError("invalid_proof");
    const result = await operation(
      client,
      user ? { ...user, companyStatus: company?.status ?? null } : null,
    );
    if (broken) throw new SessionError("unavailable");
    // A COMMIT failure is ambiguous: never claim rollback or blindly retry.
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      broken = true;
    });
    throw error;
  } finally {
    client.off("error", onError);
    client.release(broken);
  }
}
