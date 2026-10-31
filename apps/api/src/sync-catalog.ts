import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  parseErpEnvironment,
  parsePostgresEnvironment,
} from "@b2b-portal/config/server";
import { checkedTarget } from "./demo/seed.js";
import { createMockCatalogSource } from "./infrastructure/mock-catalog-adapter.js";
import { createJsonCatalogCache } from "./infrastructure/json/catalog-cache.js";
import { createPostgresCatalogCache } from "./infrastructure/postgres-catalog-cache.js";
import { createCatalogSync } from "./services/catalog-sync.js";
import type { CatalogCacheRepository } from "./repositories/catalog-sync.js";
let pool: Pool | undefined,
  result: { products: number; access: number; prices: number } | undefined,
  failed = false;
try {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      directory: { type: "string" },
      "confirm-target": { type: "string" },
      offline: { type: "boolean" },
    },
    strict: true,
  });
  const erp = parseErpEnvironment(process.env);
  if (!erp || !values["confirm-target"]) throw new Error();
  let cache: CatalogCacheRepository;
  if (values.provider === "json" && values.directory)
    cache = createJsonCatalogCache(
      values.directory,
      values["confirm-target"],
      values.offline === true,
    );
  else if (
    values.provider === "postgresql" &&
    !values.directory &&
    !values.offline
  ) {
    const config = parsePostgresEnvironment(process.env);
    if (!config) throw new Error();
    const url = new URL(config.connectionString);
    checkedTarget(decodeURIComponent(url.pathname.slice(1)), {
      mode: "reset",
      confirmTarget: values["confirm-target"],
    });
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error();
    pool = new Pool({
      ...config,
      query_timeout: 0,
      application_name: "b2b-portal-catalog-sync",
    });
    pool.on("error", () => {
      failed = true;
    });
    const {
      rows: [server],
    } = await pool.query("SELECT host(inet_server_addr()) AS address");
    if (!["127.0.0.1", "::1"].includes(server.address)) throw new Error();
    cache = createPostgresCatalogCache(pool);
  } else throw new Error();
  result = await createCatalogSync(
    createMockCatalogSource(erp),
    cache,
    randomUUID,
  ).synchronize(new AbortController().signal);
} catch {
  failed = true;
} finally {
  if (pool)
    await pool.end().catch(() => {
      failed = true;
    });
}
if (failed || !result) {
  console.error(JSON.stringify({ event: "catalog.sync_failed" }));
  process.exitCode = 1;
} else console.log(JSON.stringify({ event: "catalog.synced", ...result }));
