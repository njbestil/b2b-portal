import type { Pool, PoolClient } from "pg";
import {
  integrationErrorCodes,
  type IntegrationMonitorActor,
  type IntegrationMonitorRepository,
  type IntegrationTransactionSummary,
} from "../repositories/integration-monitor.js";
import type { LoginCredential } from "../repositories/authentication.js";
import {
  checkedMonitorQuery,
  checkedMonitorRecord,
  IntegrationMonitorError,
  monitorId,
  monitorExpiry,
} from "../services/integration-monitor.js";
import { integrationMonitorActor } from "./integration-monitor-state.js";
import { SessionError } from "../services/session-state.js";
const fields = `t.id,t.company_id AS "companyId",t.order_id AS "orderId",CASE WHEN t.operation='ORDER_SUBMISSION' THEN 'ORDER_SUBMISSION' ELSE 'OTHER' END AS operation,t.status,t.retryable,t.retry_count AS "retryCount",t.next_retry_at AS "nextRetryAt",CASE WHEN t.error_code IS NULL THEN NULL WHEN t.error_code=ANY($1::text[]) THEN t.error_code ELSE 'UNRECOGNIZED' END AS "errorCode",t.created_at AS "createdAt",t.updated_at AS "updatedAt"`;
const listSql = `WITH projected AS MATERIALIZED (
 SELECT ${fields} FROM integration_transactions t
 WHERE ($2::text IS NULL OR t.status=$2) AND ($3::uuid IS NULL OR t.company_id=$3) AND ($4::uuid IS NULL OR t.order_id=$4)
), matching AS MATERIALIZED (
 SELECT * FROM projected WHERE $5::text IS NULL OR strpos(lower(concat_ws(' ',id::text,"companyId"::text,"orderId"::text,operation,status,"errorCode")),$5)>0
)
SELECT total.n AS "__total",page.* FROM (SELECT count(*)::text AS n FROM matching) total
LEFT JOIN LATERAL (SELECT * FROM matching ORDER BY "createdAt" DESC,id ASC LIMIT $6 OFFSET $7) page ON true
ORDER BY page."createdAt" DESC,page.id ASC`;
type TransactionRow = Omit<
  IntegrationTransactionSummary,
  "createdAt" | "updatedAt" | "nextRetryAt"
> & { createdAt: Date; updatedAt: Date; nextRetryAt: Date | null };
const record = (row: TransactionRow) =>
  checkedMonitorRecord({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
  });
type Authority = Omit<LoginCredential, "companyStatus"> & {
  sessionUserId: string | null;
  sessionId: string | null;
  refreshTokenHash: string | null;
  credentialFingerprint: string | null;
  sessionCreatedAt: Date | null;
  sessionExpiresAt: Date | null;
  revokedAt: Date | null;
};
async function authorize(
  client: PoolClient,
  actor: IntegrationMonitorActor,
  now: () => number,
  signal: AbortSignal,
) {
  monitorExpiry(actor, now(), signal);
  const row = (
    await client.query<Authority>(
      `SELECT u.id,u.company_id AS "companyId",u.display_name AS "displayName",u.role,u.status,u.password_hash AS "passwordHash",u.must_change_password AS "mustChangePassword",s.id AS "sessionId",s.user_id AS "sessionUserId",s.refresh_token_hash AS "refreshTokenHash",s.credential_fingerprint AS "credentialFingerprint",s.created_at AS "sessionCreatedAt",s.expires_at AS "sessionExpiresAt",s.revoked_at AS "revokedAt" FROM users u LEFT JOIN user_sessions s ON s.id=$2 AND s.user_id=u.id WHERE u.id=$1`,
      [actor.userId, actor.sessionId],
    )
  ).rows[0];
  const account = row
    ? {
        id: row.id,
        companyId: row.companyId,
        displayName: row.displayName,
        role: row.role,
        status: row.status,
        passwordHash: row.passwordHash,
        mustChangePassword: row.mustChangePassword,
        companyStatus: null,
      }
    : null;
  const session = row?.sessionId
    ? {
        id: row.sessionId,
        userId: row.sessionUserId!,
        refreshTokenHash: row.refreshTokenHash!,
        credentialFingerprint: row.credentialFingerprint,
        createdAt: row.sessionCreatedAt!.toISOString(),
        expiresAt: row.sessionExpiresAt!.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
      }
    : null;
  integrationMonitorActor(actor, account, session, now(), signal);
}
export function createPostgresIntegrationMonitor(
  pool: Pool,
  now = Date.now,
): IntegrationMonitorRepository {
  async function run<T>(
    actor: IntegrationMonitorActor,
    signal: AbortSignal,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    monitorId(actor.userId);
    monitorId(actor.sessionId);
    monitorExpiry(actor, now(), signal);
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      throw new IntegrationMonitorError("unavailable");
    }
    let broken = false;
    const onError = () => {
      broken = true;
    };
    client.on("error", onError);
    try {
      monitorExpiry(actor, now(), signal);
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
      await client.query("SET LOCAL statement_timeout='2s'");
      await client.query("SET LOCAL lock_timeout='1s'");
      await authorize(client, actor, now, signal);
      const result = await work(client);
      await authorize(client, actor, now, signal);
      monitorExpiry(actor, now(), signal);
      if (broken) throw new IntegrationMonitorError("unavailable");
      await client.query("COMMIT");
      monitorExpiry(actor, now(), signal);
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      if (e instanceof IntegrationMonitorError || e instanceof SessionError)
        throw e;
      throw new IntegrationMonitorError("unavailable");
    } finally {
      client.off("error", onError);
      client.release(broken);
    }
  }
  return {
    list: (actor, value, signal) => {
      const query = checkedMonitorQuery(value);
      return run(actor, signal, async (client) => {
        const rows = (
          await client.query<TransactionRow & { __total: string }>(listSql, [
            integrationErrorCodes,
            query.status ?? null,
            query.companyId ?? null,
            query.orderId ?? null,
            query.q?.toLowerCase() ?? null,
            query.limit,
            query.offset,
          ])
        ).rows;
        if (!rows.length) throw new IntegrationMonitorError("unavailable");
        const total = Number(rows[0]!.__total);
        if (!Number.isSafeInteger(total) || total < 0)
          throw new IntegrationMonitorError("unavailable");
        return { items: rows.filter((r) => r.id !== null).map(record), total };
      });
    },
    find: (actor, value, signal) => {
      const id = monitorId(value);
      return run(actor, signal, async (client) => {
        const row = (
          await client.query<TransactionRow>(
            `SELECT ${fields} FROM integration_transactions t WHERE t.id=$2`,
            [integrationErrorCodes, id],
          )
        ).rows[0];
        return row ? record(row) : null;
      });
    },
  };
}
