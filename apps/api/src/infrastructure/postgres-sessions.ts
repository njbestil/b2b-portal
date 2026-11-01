import { bound, credentialFingerprint } from "./session-crypto.js";
import type { Pool, PoolClient } from "pg";
import type {
  SessionRecord,
  SessionRepository,
} from "../repositories/sessions.js";
import type { LoginCredential } from "../repositories/authentication.js";
import {
  SessionError,
  eligible,
  principal,
  sessionId,
  tokenHash,
} from "../services/session-state.js";
import { withSecurityAccount } from "./postgres-security.js";

const projection = `id, user_id AS "userId", refresh_token_hash AS "refreshTokenHash",
  credential_fingerprint AS "credentialFingerprint", created_at AS "createdAt", expires_at AS "expiresAt", revoked_at AS "revokedAt"`;
type SqlSession = Omit<
  SessionRecord,
  "createdAt" | "expiresAt" | "revokedAt"
> & { createdAt: Date; expiresAt: Date; revokedAt: Date | null };
const record = (row: SqlSession): SessionRecord => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  revokedAt: row.revokedAt?.toISOString() ?? null,
});
export function createPostgresSessions(
  pool: Pool,
  now: () => number = Date.now,
): SessionRepository {
  const admission = (row: SessionRecord, user: LoginCredential) => ({
    user: principal(user),
    sessionId: row.id,
    expiresAt: row.expiresAt,
  });
  async function run<T>(
    userId: string,
    op: (client: PoolClient, user: LoginCredential) => Promise<T>,
  ) {
    try {
      return await withSecurityAccount(pool, userId, (client, account) =>
        op(client, eligible(account)),
      );
    } catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError("unavailable");
    }
  }
  async function existing<T>(
    id: string,
    userId: string | undefined,
    op: (
      client: PoolClient,
      row: SessionRecord,
      user: LoginCredential,
    ) => Promise<T>,
    allowRevoked = false,
  ) {
    if (!sessionId(id) || (userId !== undefined && !sessionId(userId)))
      throw new SessionError("invalid_proof");
    try {
      // Unlocked lookup identifies the lock key only; ownership is rechecked under locks.
      const owner =
        userId ??
        (
          await pool.query<{ userId: string }>(
            'SELECT user_id AS "userId" FROM user_sessions WHERE id=$1',
            [id],
          )
        ).rows[0]?.userId;
      if (!owner) throw new SessionError("invalid_proof");
      return await run(owner, async (client, user) => {
        const row = (
          await client.query<SqlSession>(
            `SELECT ${projection} FROM user_sessions WHERE id=$1 FOR UPDATE`,
            [id],
          )
        ).rows[0];
        const current = bound(
          row ? record(row) : null,
          user,
          now(),
          allowRevoked,
        );
        return op(client, current, user);
      });
    } catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError("unavailable");
    }
  }
  return {
    create: (proof, id, hash, lifetime) =>
      run(proof.userId, async (client, user) => {
        if (
          !sessionId(proof.userId) ||
          !sessionId(id) ||
          !tokenHash(hash) ||
          !Number.isInteger(lifetime) ||
          lifetime < 1 ||
          lifetime > 604800
        )
          throw new SessionError("unavailable");
        if (proof.passwordHash !== user.passwordHash)
          throw new SessionError("invalid_proof");
        const time = now();
        if (!Number.isFinite(time)) throw new SessionError("unavailable");
        const row: SessionRecord = {
          id,
          userId: user.id,
          refreshTokenHash: hash,
          credentialFingerprint: credentialFingerprint(
            user.id,
            proof.passwordHash,
          ),
          createdAt: new Date(time).toISOString(),
          expiresAt: new Date(time + lifetime * 1000).toISOString(),
          revokedAt: null,
        };
        await client.query(
          "INSERT INTO user_sessions(id,user_id,refresh_token_hash,credential_fingerprint,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
          [
            row.id,
            row.userId,
            row.refreshTokenHash,
            row.credentialFingerprint,
            row.createdAt,
            row.expiresAt,
          ],
        );
        return admission(row, user);
      }),
    admit: (id, userId) =>
      existing(id, userId, async (_client, row, user) => admission(row, user)),
    rotate: (id, oldHash, newHash) =>
      existing(id, undefined, async (client, row, user) => {
        if (
          !tokenHash(oldHash) ||
          !tokenHash(newHash) ||
          row.refreshTokenHash !== oldHash
        )
          throw new SessionError("invalid_proof");
        const result = await client.query(
          "UPDATE user_sessions SET refresh_token_hash=$1 WHERE id=$2 AND refresh_token_hash=$3 AND revoked_at IS NULL",
          [newHash, id, oldHash],
        );
        if (result.rowCount !== 1) throw new SessionError("invalid_proof");
        return admission(row, user);
      }),
    revoke: (id, userId) =>
      existing(
        id,
        userId,
        async (client, row, user) => {
          if (row.revokedAt === null)
            await client.query(
              "UPDATE user_sessions SET revoked_at=$1 WHERE id=$2",
              [new Date(now()).toISOString(), id],
            );
          return admission(row, user);
        },
        true,
      ),
    ready: async () => {
      try {
        await pool.query(`SELECT ${projection} FROM user_sessions LIMIT 0`);
        return true;
      } catch {
        return false;
      }
    },
  };
}
