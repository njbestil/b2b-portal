import { Client } from "pg";
import { parseArgs } from "node:util";
import { parsePostgresEnvironment } from "@b2b-portal/config/server";
import {
  DemoAccountsError,
  demoMode,
  selectedAccounts,
} from "./demo/accounts.js";
import { provisionJsonAccounts } from "./demo/accounts-json.js";
import { provisionPostgresAccounts } from "./demo/accounts-postgres.js";
let client: Client | undefined,
  failed = false;
try {
  const target = demoMode(process.env);
  if (!target) throw new DemoAccountsError();
  const { values } = parseArgs({
    strict: true,
    options: {
      provider: { type: "string" },
      directory: { type: "string" },
      "confirm-target": { type: "string" },
      account: { type: "string", default: "all" },
      offline: { type: "boolean" },
    },
  });
  if (values["confirm-target"] !== target || values.offline !== true)
    throw new DemoAccountsError();
  const selected = selectedAccounts(values.account),
    secrets: Record<string, string | undefined> = {};
  for (const account of selected)
    secrets[account.secret] = process.env[account.secret];
  const postgres = parsePostgresEnvironment(process.env);
  if (values.provider === "json" && values.directory && !postgres) {
    await provisionJsonAccounts(
      values.directory,
      target,
      values.account,
      secrets,
      true,
    );
  } else if (
    values.provider === "postgresql" &&
    postgres &&
    !values.directory
  ) {
    if (
      decodeURIComponent(
        new URL(postgres.connectionString).pathname.slice(1),
      ) !== target
    )
      throw new DemoAccountsError();
    client = new Client({
      ...postgres,
      application_name: "b2b-portal-demo-accounts",
    });
    client.on("error", () => {
      failed = true;
    });
    await client.connect();
    await provisionPostgresAccounts(
      client,
      target,
      values.account,
      secrets,
      true,
    );
  } else throw new DemoAccountsError();
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
      event: "demo.accounts_failed",
      reason: "invalid_or_unsafe_configuration_or_operation_failed",
    }),
  );
  process.exitCode = 1;
} else console.log(JSON.stringify({ event: "demo.accounts_completed" }));
