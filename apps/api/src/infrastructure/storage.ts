import type { StorageProvider } from "@b2b-portal/contracts";
import type { PostgresEnvironment } from "@b2b-portal/config/server";
import type { HealthProbe } from "../health.js";
import type { Logger } from "../logging.js";
import type { RepositoryPorts } from "../repositories/index.js";
import { createPostgres } from "./postgres.js";
import {
  createPostgresRepositories,
  postgresReadinessSql,
} from "./postgres-repositories.js";
import { JsonFileStore } from "./json/store.js";
import { createJsonRepositories } from "./json/repositories.js";
import { collectionFiles } from "./json/schema.js";
import type { JsonCollection } from "./json/models.js";

export interface StorageRuntime {
  readonly provider: StorageProvider;
  readonly repositories: RepositoryPorts;
  readonly health: HealthProbe;
  close(): Promise<void>;
}

async function reachable(
  probe: HealthProbe,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => probe(controller.signal))
        .then(
          (up) => up === true,
          () => false,
        ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Select exactly once. Repository errors and health checks never reselect. */
export async function selectStorage(
  options: {
    postgres?: PostgresEnvironment;
    jsonDirectory: string;
    startupTimeoutMs: number;
    logger: Logger;
  },
  makePostgres: typeof createPostgres = createPostgres,
): Promise<StorageRuntime> {
  if (
    !Number.isInteger(options.startupTimeoutMs) ||
    options.startupTimeoutMs < 1 ||
    options.startupTimeoutMs > 60_000
  )
    throw new RangeError("Storage startup timeout must be 1–60000 ms.");
  let retirement = Promise.resolve();
  if (options.postgres) {
    const postgres = makePostgres(options.postgres, options.logger);
    if (await reachable(postgres.health, options.startupTimeoutMs)) {
      options.logger("info", {
        event: "storage.selected",
        provider: "postgresql",
        reason: "postgres_reachable",
      });
      return Object.freeze({
        provider: "postgresql",
        repositories: createPostgresRepositories(postgres.pool),
        health: (signal: AbortSignal) =>
          postgres.probe(signal, postgresReadinessSql),
        close: () => postgres.close(),
      });
    }
    // Start cleanup immediately, but a late bounded pg acquisition must not keep
    // JSON startup waiting. Shutdown still owns/awaits this same retirement.
    retirement = Promise.resolve().then(() => postgres.close());
    void retirement.catch(() =>
      options.logger("error", { event: "storage.cleanup_failed" }),
    );
  }
  const store = new JsonFileStore(options.jsonDirectory);
  const health: HealthProbe = async (signal) => {
    if (signal.aborted) return false;
    try {
      await Promise.all(
        (Object.keys(collectionFiles) as JsonCollection[]).map((name) =>
          store.read(name),
        ),
      );
      return !signal.aborted;
    } catch {
      return false;
    }
  };
  options.logger(options.postgres ? "warn" : "info", {
    event: "storage.selected",
    provider: "json",
    reason: options.postgres ? "postgres_unavailable" : "postgres_unconfigured",
  });
  return Object.freeze({
    provider: "json",
    repositories: createJsonRepositories(store),
    health,
    close: () => retirement,
  });
}
