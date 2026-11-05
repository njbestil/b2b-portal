import * as fs from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { JsonFileStore } from "../infrastructure/json/store.js";
import { collectionFiles } from "../infrastructure/json/schema.js";
import {
  accountPlan,
  demoMarker,
  DemoAccountsError,
  demoTarget,
  ownedAccounts,
} from "./accounts.js";

const allowed = new Set([
  ...Object.values(collectionFiles),
  ".b2b-demo",
  "customer_sales_assignments.json",
  "user_sessions.json",
  "password_reset_tokens.json",
  "delivery_addresses.json",
  "order_internal_notes.json",
  "audit_logs.json",
  "notifications.json",
  "application_reviews.json",
]);
async function inspect(directory: string, target: string) {
  const path = resolve(directory),
    parent = dirname(path);
  if (
    !demoTarget(target) ||
    basename(path) !== target ||
    (await fs.realpath(parent)).toLowerCase() !== parent.toLowerCase()
  )
    throw new DemoAccountsError();
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new DemoAccountsError();
  const names = await fs.readdir(path);
  if (
    [...Object.values(collectionFiles), ".b2b-demo"].some(
      (name) => !names.includes(name),
    ) ||
    names.some((name) => !allowed.has(name))
  )
    throw new DemoAccountsError();
  for (const name of names) {
    const item = await fs.lstat(join(path, name));
    if (!item.isFile() || item.isSymbolicLink() || item.size > 16 * 1024 * 1024)
      throw new DemoAccountsError();
  }
  if ((await fs.readFile(join(path, ".b2b-demo"), "utf8")) !== demoMarker)
    throw new DemoAccountsError();
  const store = new JsonFileStore(path),
    users = await store.read("users"),
    companies = await store.read("companies");
  // Refuse unknown or noncanonical user data before a normalized read could
  // erase/alter fields on an unrelated record during whole-file publication.
  const wireUsers: unknown = JSON.parse(
    await fs.readFile(join(path, "users.json"), "utf8"),
  );
  if (
    !Array.isArray(wireUsers) ||
    wireUsers.length !== users.length ||
    wireUsers.some((value: unknown, index: number) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return true;
      const raw = value as Record<string, unknown>;
      const parsed = users[index]! as unknown as Record<string, unknown>;
      return Object.keys(raw).some(
        (key) => !Object.hasOwn(parsed, key) || raw[key] !== parsed[key],
      );
    })
  )
    throw new DemoAccountsError();
  const assignments = names.includes("customer_sales_assignments.json")
    ? JSON.parse(
        await fs.readFile(
          join(path, "customer_sales_assignments.json"),
          "utf8",
        ),
      )
    : [];
  ownedAccounts(users, companies, assignments);
  return { path, parent, names, users, companies, assignments };
}
export async function inspectJsonDemo(directory: string, target: string) {
  await inspect(directory, target);
}
/** Offline only: credential and assignment publication is a single directory swap. */
export async function provisionJsonAccounts(
  directory: string,
  target: string,
  selection: unknown,
  secrets: Readonly<Record<string, string | undefined>>,
  offline: boolean,
  io = fs,
) {
  if (offline !== true) throw new DemoAccountsError();
  const path = resolve(directory),
    parent = dirname(path);
  if (!demoTarget(target) || basename(path) !== target)
    throw new DemoAccountsError();
  let lock: Awaited<ReturnType<typeof fs.open>> | undefined,
    staged = false,
    moved = false;
  const stage = join(parent, "." + target + ".accounts-stage-" + randomUUID()),
    backup = join(parent, "." + target + ".accounts-backup-" + randomUUID()),
    lockPath = join(parent, "." + target + ".lock");
  let names: string[] = [];
  try {
    // Verify trusted ancestry before creating even a lock file.
    if ((await fs.realpath(parent)).toLowerCase() !== parent.toLowerCase())
      throw new DemoAccountsError();
    lock = await fs.open(lockPath, "wx", 0o600);
    const current = await inspect(path, target);
    const plan = await accountPlan(
      current.users,
      current.companies,
      current.assignments,
      selection,
      secrets,
    );
    names = [...new Set([...current.names, "customer_sales_assignments.json"])];
    await io.mkdir(stage, { mode: 0o700 });
    staged = true;
    for (const name of current.names) {
      await io.copyFile(join(path, name), join(stage, name));
      await io.chmod(join(stage, name), 0o600);
    }
    await new JsonFileStore(stage).replace("users", plan.users);
    await io.writeFile(
      join(stage, "customer_sales_assignments.json"),
      JSON.stringify(plan.assignments),
      { mode: 0o600 },
    );
    await io.rename(path, backup);
    moved = true;
    try {
      await io.rename(stage, path);
      staged = false;
    } catch (error) {
      await io.rename(backup, path);
      moved = false;
      throw error;
    }
    // Delete only the already-validated known files in our generated backup.
    for (const name of current.names) await io.unlink(join(backup, name));
    await io.rmdir(backup);
    moved = false;
  } catch {
    throw new DemoAccountsError();
  } finally {
    if (staged) {
      for (const name of names)
        await fs.unlink(join(stage, name)).catch(() => {});
      await fs.rmdir(stage).catch(() => {});
    }
    if (lock) {
      await lock.close();
      await fs.unlink(lockPath);
    }
    // Preserve a backup after failed restoration/cleanup for operator recovery.
    void moved;
  }
}
