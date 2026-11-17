import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { open, lstat, readFile, realpath, unlink } from "node:fs/promises";
import { resolve, basename, dirname, join } from "node:path";
import {
  parseErpEnvironment,
  parsePostgresEnvironment,
} from "@b2b-portal/config/server";
import { checkedTarget } from "./demo/seed.js";
import { createInvoiceSync } from "./services/invoices.js";
import { createJsonInvoices } from "./infrastructure/json/invoices.js";
import { JsonSecurityCoordinator } from "./infrastructure/json/security.js";
import { createPostgresInvoices } from "./infrastructure/postgres-invoices.js";
import { createMockInvoiceSource } from "./infrastructure/mock-invoice-adapter.js";
import type { InvoiceRepository } from "./repositories/invoices.js";
let pool: Pool | undefined,
  lock: Awaited<ReturnType<typeof open>> | undefined,
  lockPath: string | undefined,
  result: { available: boolean } | undefined,
  failed = false;
try {
  const { values } = parseArgs({
    strict: true,
    options: {
      provider: { type: "string" },
      directory: { type: "string" },
      "confirm-target": { type: "string" },
      offline: { type: "boolean" },
      order: { type: "string" },
    },
  });
  const erp = parseErpEnvironment(process.env),
    postgres = parsePostgresEnvironment(process.env);
  if (
    !["development", "test"].includes(process.env.NODE_ENV ?? "") ||
    !erp ||
    !values["confirm-target"] ||
    !values.order ||
    values.offline !== true
  )
    throw new Error();
  let repository: InvoiceRepository;
  if (values.provider === "json" && values.directory && !postgres) {
    const directory = resolve(values.directory),
      parent = dirname(directory),
      target = basename(directory);
    checkedTarget(target, {
      mode: "reset",
      confirmTarget: values["confirm-target"],
    });
    if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase())
      throw new Error();
    const stat = await lstat(directory),
      marker = await lstat(join(directory, ".b2b-demo"));
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !marker.isFile() ||
      marker.isSymbolicLink() ||
      marker.size > 100
    )
      throw new Error();
    lockPath = join(parent, `.${target}.lock`);
    lock = await open(lockPath, "wx", 0o600);
    if (
      (await readFile(join(directory, ".b2b-demo"), "utf8")) !==
      "b2b-portal-demo:v1"
    )
      throw new Error();
    repository = createJsonInvoices(new JsonSecurityCoordinator(directory));
  } else if (
    values.provider === "postgresql" &&
    postgres &&
    !values.directory
  ) {
    const url = new URL(postgres.connectionString);
    checkedTarget(decodeURIComponent(url.pathname.slice(1)), {
      mode: "reset",
      confirmTarget: values["confirm-target"],
    });
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error();
    pool = new Pool({ ...postgres, query_timeout: 0 });
    pool.on("error", () => {
      failed = true;
    });
    const row = (
      await pool.query(
        "SELECT host(inet_server_addr()) AS address,obj_description('public'::regnamespace) AS marker",
      )
    ).rows[0];
    if (
      !["127.0.0.1", "::1"].includes(row.address) ||
      row.marker !== "b2b-portal-demo:v1"
    )
      throw new Error();
    repository = createPostgresInvoices(pool);
  } else throw new Error();
  result = await createInvoiceSync(
    createMockInvoiceSource(erp),
    repository,
    randomUUID,
  ).synchronize(values.order, new AbortController().signal);
} catch {
  failed = true;
} finally {
  if (pool)
    await pool.end().catch(() => {
      failed = true;
    });
  if (lock) {
    await lock.close().catch(() => {
      failed = true;
    });
    await unlink(lockPath!).catch(() => {
      failed = true;
    });
  }
}
if (failed || !result) {
  console.error(JSON.stringify({ event: "invoice.sync_failed" }));
  process.exitCode = 1;
} else console.log(JSON.stringify({ event: "invoice.synced", ...result }));
