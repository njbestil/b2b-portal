import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { resolve, isAbsolute, basename } from "node:path";
import { checkedTarget } from "./demo/seed.js";
import { parsePostgresEnvironment } from "@b2b-portal/config/server";
import { createPasswordReset } from "./services/password-reset.js";
import { resetProofs } from "./infrastructure/reset-crypto.js";
import { protectedResetDelivery } from "./infrastructure/reset-handoff.js";
import { createJsonPasswordReset } from "./infrastructure/json/password-reset.js";
import { JsonSecurityCoordinator } from "./infrastructure/json/security.js";
import { createPostgresPasswordReset } from "./infrastructure/postgres-password-reset.js";
import { createJsonAudit } from "./infrastructure/json/audit.js";
import { createPostgresAudit } from "./infrastructure/postgres-audit.js";
import { createAudit } from "./services/audit.js";
import { hashPassword, verifyPassword } from "./infrastructure/passwords.js";
let pool: Pool | undefined,
  failed = false;
try {
  const { values } = parseArgs({
    strict: true,
    options: {
      provider: { type: "string" },
      directory: { type: "string" },
      "confirm-target": { type: "string" },
      offline: { type: "boolean" },
      "identity-verified": { type: "boolean" },
      email: { type: "string" },
      output: { type: "string" },
    },
  });
  if (
    process.env.AUTH_LOCAL_RESET_ENABLED !== "true" ||
    process.env.NODE_ENV === "production" ||
    !values["identity-verified"] ||
    !values.email ||
    !values.output ||
    !values["confirm-target"]
  )
    throw new Error();
  const deliver = await protectedResetDelivery(values.output);
  let repository, auditRepository;
  if (
    values.provider === "json" &&
    values.directory &&
    isAbsolute(values.directory) &&
    values.offline &&
    resolve(values.directory) === values["confirm-target"]
  ) {
    const security = new JsonSecurityCoordinator(values.directory);
    checkedTarget(basename(values.directory), {
      mode: "reset",
      confirmTarget: basename(values.directory),
    });
    repository = createJsonPasswordReset(security);
    auditRepository = createJsonAudit(values.directory);
  } else if (
    values.provider === "postgresql" &&
    !values.directory &&
    !values.offline
  ) {
    const config = parsePostgresEnvironment(process.env);
    if (!config) throw new Error();
    const url = new URL(config.connectionString);
    checkedTarget(values["confirm-target"], {
      mode: "reset",
      confirmTarget: values["confirm-target"],
    });
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      decodeURIComponent(url.pathname.slice(1)) !== values["confirm-target"]
    )
      throw new Error();
    pool = new Pool({ ...config, application_name: "b2b-reset-operator" });
    pool.on("error", () => {
      failed = true;
    });
    const server = (
      await pool.query("SELECT host(inet_server_addr()) AS address")
    ).rows[0];
    if (!["127.0.0.1", "::1"].includes(server.address)) throw new Error();
    repository = createPostgresPasswordReset(pool);
    auditRepository = createPostgresAudit(pool);
  } else throw new Error();
  const audit = createAudit(auditRepository, randomUUID);
  await createPasswordReset(
    repository,
    hashPassword,
    verifyPassword,
    (input) => audit.record(input),
    resetProofs,
  ).issue(values.email, randomUUID(), deliver);
} catch {
  failed = true;
} finally {
  await pool?.end().catch(() => {
    failed = true;
  });
}
if (failed) {
  console.error(JSON.stringify({ event: "reset.handoff_failed" }));
  process.exitCode = 1;
} else console.log(JSON.stringify({ event: "reset.handoff_completed" }));
