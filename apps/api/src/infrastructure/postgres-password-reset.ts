import type { Pool, PoolClient } from "pg";
import type {
  PasswordResetRepository,
  ResetRecord,
} from "../repositories/password-reset.js";
import type { LoginCredential } from "../repositories/authentication.js";
import { withSecurityAccount } from "./postgres-security.js";
import {
  eligible,
  principal,
  SessionError,
  sessionId,
  tokenHash,
} from "../services/session-state.js";
import { PasswordResetError } from "../services/password-reset.js";
import { credentialFingerprint } from "./session-crypto.js";
import { resetBound } from "./reset-state.js";
import { publishPostgresCredential } from "./postgres-credential-writer.js";
const projection = `id,user_id AS "userId",token_hash AS "tokenHash",credential_fingerprint AS "credentialFingerprint",
to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt",
to_char(used_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "usedAt"`;
export function createPostgresPasswordReset(
  pool: Pool,
  now = Date.now,
): PasswordResetRepository {
  async function controlled<T>(op: () => Promise<T>) {
    try {
      return await op();
    } catch (e) {
      if (e instanceof PasswordResetError) throw e;
      if (e instanceof SessionError && e.code === "invalid_proof")
        throw new PasswordResetError("invalid_proof");
      throw new PasswordResetError("unavailable");
    }
  }
  async function current<T>(
    id: string,
    digest: string,
    op: (
      client: PoolClient,
      user: LoginCredential,
      row: ResetRecord,
    ) => Promise<T>,
  ) {
    return controlled(async () => {
      if (!sessionId(id) || !tokenHash(digest))
        throw new PasswordResetError("invalid_proof");
      const owner = (
        await pool.query<{ userId: string }>(
          'SELECT user_id AS "userId" FROM password_reset_tokens WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!owner) throw new PasswordResetError("invalid_proof");
      return withSecurityAccount(
        pool,
        owner.userId,
        async (client, account) => {
          const user = eligible(account);
          const row = (
            await client.query<ResetRecord>(
              `SELECT ${projection} FROM password_reset_tokens WHERE id=$1 FOR UPDATE`,
              [id],
            )
          ).rows[0];
          return op(client, user, resetBound(row, user, digest, now()));
        },
      );
    });
  }
  return {
    ready: async () => {
      try {
        await pool.query(
          `SELECT ${projection} FROM password_reset_tokens LIMIT 0`,
        );
        return true;
      } catch {
        return false;
      }
    },
    issue: (email, id, digest) =>
      controlled(async () => {
        if (!sessionId(id) || !tokenHash(digest))
          throw new PasswordResetError("invalid_input");
        const owner = (
          await pool.query<{ id: string }>(
            "SELECT id FROM users WHERE email=$1",
            [email],
          )
        ).rows[0];
        if (!owner) return null;
        return withSecurityAccount(pool, owner.id, async (client, account) => {
          let user;
          try {
            user = eligible(account);
          } catch (e) {
            if (e instanceof SessionError && e.code === "invalid_proof")
              return null;
            throw e;
          }
          if (
            (
              await client.query("SELECT email FROM users WHERE id=$1", [
                user.id,
              ])
            ).rows[0]?.email !== email
          )
            return null;
          const time = now(),
            expiresAt = new Date(time + 1800000).toISOString();
          await client.query(
            "UPDATE password_reset_tokens SET used_at=COALESCE(used_at,$1) WHERE user_id=$2",
            [new Date(time).toISOString(), user.id],
          );
          await client.query(
            "INSERT INTO password_reset_tokens(id,user_id,token_hash,credential_fingerprint,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
            [
              id,
              user.id,
              digest,
              credentialFingerprint(user.id, user.passwordHash),
              new Date(time).toISOString(),
              expiresAt,
            ],
          );
          return { userId: user.id, expiresAt };
        });
      }),
    inspect: (id, digest) =>
      current(id, digest, async (_client, user) => ({
        userId: user.id,
        passwordHash: user.passwordHash,
      })),
    consume: (id, digest, proof, newHash) =>
      current(id, digest, async (client, user, row) => {
        if (
          user.id !== proof.userId ||
          user.passwordHash !== proof.passwordHash
        )
          throw new PasswordResetError("invalid_proof");
        await publishPostgresCredential(client, user, newHash, now());
        await client.query(
          "UPDATE password_reset_tokens SET used_at=$1 WHERE id=$2",
          [new Date(now()).toISOString(), row.id],
        );
        return principal({
          ...user,
          passwordHash: newHash,
          mustChangePassword: false,
        });
      }),
  };
}
