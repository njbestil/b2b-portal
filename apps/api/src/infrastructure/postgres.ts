import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { PostgresEnvironment } from "@b2b-portal/config/server";
import type { HealthProbe } from "../health.js";
import type { Logger } from "../logging.js";

/** Infrastructure only: application services must depend on repository ports. */
export function createPostgres(
  config: PostgresEnvironment,
  logger: Logger,
  makePool: (options: PoolConfig) => Pool = (options) => new Pool(options),
) {
  const pool = makePool({ ...config, application_name: "b2b-portal-api" });
  // Idle connection errors otherwise become unhandled EventEmitter errors.
  pool.on("error", () => logger("error", { event: "postgres.pool_error" }));
  let closing: Promise<void> | undefined;

  const probe = async (signal: AbortSignal, sql: string): Promise<boolean> => {
    if (closing || signal.aborted) return false;
    let client: PoolClient | undefined;
    let released = false;
    let connectionFailed = false;
    const release = (destroy: boolean) => {
      if (client && !released) {
        released = true;
        client.release(destroy);
      }
    };
    const abort = () => release(true);
    const connectionError = () => {
      connectionFailed = true;
      release(true);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      client = await pool.connect();
      // pg removes the pool's idle-error listener during checkout. Own errors
      // until release so socket loss during SELECT cannot crash the process.
      client.on("error", connectionError);
      // pg acquisition cannot be cancelled; discard a late acquired client.
      if (signal.aborted || closing) {
        release(true);
        return false;
      }
      await client.query(sql);
      return !signal.aborted && !closing && !connectionFailed;
    } catch {
      release(true);
      return false;
    } finally {
      signal.removeEventListener("abort", abort);
      release(signal.aborted);
      client?.off("error", connectionError);
    }
  };

  const health: HealthProbe = (signal) => probe(signal, "SELECT 1");
  return {
    pool,
    health,
    /** Infrastructure-owned read-only SQL only; never HTTP caller input. */
    probe,
    close(): Promise<void> {
      closing ??= pool.end();
      return closing;
    },
  };
}
