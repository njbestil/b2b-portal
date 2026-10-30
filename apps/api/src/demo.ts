import { Client } from "pg";
import { parseArgs } from "node:util";
import { parsePostgresEnvironment } from "@b2b-portal/config/server";
import { checkedTarget, seedJson, seedPostgres } from "./demo/seed.js";
let client: Client | undefined;
let failed = false;
try {
  const { values, positionals } = parseArgs({
    options: {
      provider: { type: "string" },
      directory: { type: "string" },
      "confirm-target": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const mode = positionals[0];
  if (
    positionals.length !== 1 ||
    (mode !== "seed" && mode !== "reset") ||
    !values["confirm-target"]
  )
    throw new Error();
  const options = { mode, confirmTarget: values["confirm-target"] } as const;
  if (values.provider === "json" && values.directory)
    await seedJson(values.directory, options);
  else if (values.provider === "postgresql" && !values.directory) {
    const config = parsePostgresEnvironment(process.env);
    if (!config) throw new Error();
    const url = new URL(config.connectionString);
    checkedTarget(decodeURIComponent(url.pathname.slice(1)), options);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error();
    client = new Client({
      ...config,
      query_timeout: 0,
      application_name: "b2b-portal-demo",
    });
    client.on("error", () => {
      failed = true;
    });
    await client.connect();
    await seedPostgres(client, options);
  } else throw new Error();
} catch {
  failed = true;
} finally {
  if (client)
    await client.end().catch(() => {
      failed = true;
    });
}
if (failed) {
  console.error(
    JSON.stringify({
      event: "demo.failed",
      reason: "invalid_or_unsafe_target_or_operation_failed",
    }),
  );
  process.exitCode = 1;
} else console.log(JSON.stringify({ event: "demo.completed" }));
