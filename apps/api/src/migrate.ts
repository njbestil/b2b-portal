import { Client } from "pg";
import {
  EnvironmentConfigurationError,
  parsePostgresEnvironment,
} from "@b2b-portal/config/server";
import { loadMigrations, runMigrations } from "./infrastructure/migrations.js";
import { createLogger } from "./logging.js";

const logger = createLogger();
let client: Client | undefined;
let failure: "invalid_environment" | "migration_failed" | undefined;
let result: { applied: number; skipped: number } | undefined;
try {
  const config = parsePostgresEnvironment(process.env);
  if (!config)
    throw new EnvironmentConfigurationError([
      "DATABASE_URL is required for migrations",
    ]);
  if (process.argv.length !== 2)
    throw new Error("Migration arguments are not supported");
  const migrations = await loadMigrations(
    new URL("../migrations/", import.meta.url),
  );
  client = new Client({
    ...config,
    application_name: "b2b-portal-migrate",
    // Let PostgreSQL's configured statement_timeout abort the transaction. A
    // driver read timeout alone could return while COMMIT is still in flight.
    query_timeout: 0,
  });
  client.on("error", () => {
    failure = "migration_failed";
  });
  await client.connect();
  await client.query("SET search_path TO public");
  result = await runMigrations(client, migrations);
} catch (error) {
  failure =
    error instanceof EnvironmentConfigurationError
      ? "invalid_environment"
      : "migration_failed";
} finally {
  if (client) {
    try {
      await client.end();
    } catch {
      failure = "migration_failed";
    }
  }
}
if (failure || !result) {
  logger("error", {
    event: "migrations.failed",
    reason: failure ?? "migration_failed",
  });
  process.exitCode = 1;
} else {
  logger("info", { event: "migrations.completed", ...result });
}
