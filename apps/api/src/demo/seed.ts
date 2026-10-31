import type { Client } from "pg";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { JsonFileStore } from "../infrastructure/json/store.js";
import { collectionFiles } from "../infrastructure/json/schema.js";
import type { JsonCollection } from "../infrastructure/json/models.js";
import { createDemoData, demoId, demoTimestamp } from "./dataset.js";

const marker = "b2b-portal-demo:v1";
const markerFile = ".b2b-demo";
const files = [...Object.values(collectionFiles), markerFile];
const privateNoteFile = "order_internal_notes.json";
const privateAuditFile = "audit_logs.json";
const privateNotificationFile = "notifications.json";
export class DemoSeedError extends Error {
  constructor() {
    super(
      "Demo operation refused or failed. Check the dedicated target and runbook.",
    );
    this.name = "DemoSeedError";
  }
}
export interface DemoOptions {
  readonly mode: "seed" | "reset";
  readonly confirmTarget: string;
}
export function checkedTarget(name: string, options: DemoOptions): void {
  if (
    !/^b2b_demo_[a-z0-9_]{1,40}$/.test(name) ||
    options.confirmTarget !== name ||
    !["seed", "reset"].includes(options.mode)
  )
    throw new DemoSeedError();
}
async function checkedDirectory(directory: string) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DemoSeedError();
  const names = await readdir(directory);
  if (
    files.some((name) => !names.includes(name)) ||
    names.some(
      (name) =>
        name !== privateNoteFile &&
        name !== privateAuditFile &&
        name !== privateNotificationFile &&
        name !== "delivery_addresses.json" &&
        !files.includes(name as (typeof files)[number]),
    )
  )
    throw new DemoSeedError();
  for (const name of names) {
    const item = await lstat(join(directory, name));
    if (!item.isFile() || item.isSymbolicLink()) throw new DemoSeedError();
  }
  if ((await readFile(join(directory, markerFile), "utf8")) !== marker)
    throw new DemoSeedError();
  return names;
}
async function removeOwnedDirectory(directory: string) {
  const names = await checkedDirectory(directory);
  for (const file of names) await unlink(join(directory, file));
  await rmdir(directory);
}
/** Offline only. Stage a complete snapshot; preserve the old target until swap. */
export async function seedJson(
  directory: string,
  options: DemoOptions,
): Promise<void> {
  const target = resolve(directory),
    name = basename(target),
    parent = dirname(target);
  checkedTarget(name, options);
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  const lockPath = join(parent, `.${name}.lock`);
  const staging = join(parent, `.${name}.stage-${randomUUID()}`);
  const backup = join(parent, `.${name}.backup-${randomUUID()}`);
  let staged = false,
    moved = false;
  try {
    // Existing parent must resolve exactly, rejecting symlink/junction ancestry.
    if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase())
      throw new DemoSeedError();
    lock = await open(lockPath, "wx", 0o600);
    if (options.mode === "seed") {
      try {
        await lstat(target);
        throw new DemoSeedError();
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
    } else await checkedDirectory(target);
    await mkdir(staging);
    staged = true;
    const store = new JsonFileStore(staging),
      data = createDemoData();
    for (const collection of Object.keys(collectionFiles) as JsonCollection[])
      await store.replace(collection, data[collection]);
    await writeFile(join(staging, markerFile), marker, {
      flag: "wx",
      mode: 0o600,
    });
    if (options.mode === "reset") {
      await rename(target, backup);
      moved = true;
    }
    try {
      await rename(staging, target);
      staged = false;
    } catch (error) {
      if (moved) {
        await rename(backup, target);
        moved = false;
      }
      throw error;
    }
    if (moved) {
      await removeOwnedDirectory(backup);
      moved = false;
    }
  } catch {
    throw new DemoSeedError();
  } finally {
    // Never recursively delete an unknown path or a recovery backup.
    if (staged) {
      for (const file of files)
        await unlink(join(staging, file)).catch(() => {});
      await rmdir(staging).catch(() => {});
    }
    if (lock) {
      await lock.close();
      await unlink(lockPath);
    }
    // A backup may remain only after a failed restore/cleanup. Do not erase it.
  }
}

const tables = [
  "companies",
  "users",
  "customer_sales_assignments",
  "delivery_addresses",
  "products",
  "customer_product_access",
  "customer_product_prices",
  "orders",
  "order_items",
  "order_confirmations",
  "order_cancellation_requests",
  "integration_transactions",
  "invoices",
  "notifications",
  "audit_logs",
  "user_sessions",
  "password_reset_tokens",
];
/** Dedicated local demo database only, pre-migrated with the existing command. */
export async function seedPostgres(
  client: Pick<Client, "query">,
  options: DemoOptions,
): Promise<void> {
  let began = false;
  try {
    const {
      rows: [target],
    } = await client.query<{ name: string; address: string }>(
      "SELECT current_database() AS name, host(inet_server_addr()) AS address",
    );
    checkedTarget(target.name, options);
    if (!["127.0.0.1", "::1"].includes(target.address))
      throw new DemoSeedError();
    await client.query("BEGIN");
    began = true;
    await client.query("SELECT pg_advisory_xact_lock(1937825, 13)");
    await client.query("SET LOCAL search_path TO public, pg_catalog");
    const { rows } = await client.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    );
    const managedTables = [
      ...tables,
      ...(rows.some((row) => row.name === "order_internal_notes")
        ? ["order_internal_notes"]
        : []),
    ];
    if (
      rows.length !== managedTables.length + 1 ||
      rows.some(
        (row) => ![...managedTables, "schema_migrations"].includes(row.name),
      )
    )
      throw new DemoSeedError();
    await client.query(
      `LOCK TABLE ${managedTables.map((table) => `public.${table}`).join(",")} IN ACCESS EXCLUSIVE MODE`,
    );
    const {
      rows: [state],
    } = await client.query<{ marker: string | null }>(
      "SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname='public'",
    );
    if (options.mode === "seed") {
      if (state.marker !== null && state.marker !== "standard public schema")
        throw new DemoSeedError();
      for (const table of managedTables) {
        if (
          (await client.query(`SELECT 1 FROM public.${table} LIMIT 1`))
            .rowCount !== 0
        )
          throw new DemoSeedError();
      }
    } else {
      if (state.marker !== marker) throw new DemoSeedError();
      await client.query(
        `TRUNCATE ${managedTables.map((table) => `public.${table}`).join(",")}`,
      );
    }
    const data = createDemoData();
    for (const r of data.companies)
      await client.query(
        "INSERT INTO companies(id,legal_name,trade_name,status,erp_customer_reference,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)",
        [
          r.id,
          r.legalName,
          r.tradeName,
          r.status,
          r.erpCustomerReference,
          demoTimestamp,
        ],
      );
    for (const r of data.users)
      await client.query(
        "INSERT INTO users(id,company_id,display_name,role,status,email,password_hash,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'!DISABLED_DEMO_LOGIN!',$7,$7)",
        [
          r.id,
          r.companyId,
          r.displayName,
          r.role,
          r.status,
          `${r.id}@example.test`,
          demoTimestamp,
        ],
      );
    for (const r of data.products)
      await client.query(
        "INSERT INTO products(id,erp_product_reference,sku,name,selling_uom,minimum_order_quantity,active,default_price,currency) VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8)",
        [
          r.id,
          r.sku,
          r.name,
          r.sellingUom,
          r.minimumOrderQuantity,
          r.active,
          r.defaultPrice?.amount,
          r.defaultPrice?.currency,
        ],
      );
    let n = 300;
    for (const r of data.customer_product_access)
      await client.query(
        "INSERT INTO customer_product_access(id,company_id,product_id,eligible) VALUES($1,$2,$3,$4)",
        [demoId(n++), r.companyId, r.productId, r.eligible],
      );
    for (const r of data.customer_product_prices)
      await client.query(
        "INSERT INTO customer_product_prices(id,company_id,product_id,amount,currency) VALUES($1,$2,$3,$4,$5)",
        [
          demoId(n++),
          r.companyId,
          r.productId,
          r.price.amount,
          r.price.currency,
        ],
      );
    for (const r of data.orders)
      await client.query(
        "INSERT INTO orders(id,company_id,order_number,created_by_user_id,created_at,updated_at,order_status,integration_status) VALUES($1,$2,$3,$4,$5,$5,$6,$7)",
        [
          r.id,
          r.companyId,
          r.orderNumber,
          r.createdByUserId,
          r.createdAt,
          r.status,
          r.integrationStatus,
        ],
      );
    await client.query("COMMENT ON SCHEMA public IS 'b2b-portal-demo:v1'");
    await client.query("COMMIT");
    began = false;
  } catch {
    if (began) await client.query("ROLLBACK").catch(() => {});
    throw new DemoSeedError();
  }
}
