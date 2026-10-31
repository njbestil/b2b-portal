import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { CatalogCacheRepository } from "../../repositories/catalog-sync.js";
import { CatalogSyncError } from "../../services/catalog-sync.js";
import { checkedTarget } from "../../demo/seed.js";
import { collectionFiles } from "./schema.js";
import { JsonFileStore } from "./store.js";
/** Explicit offline refresh of a confirmed disposable demo directory only. */
export function createJsonCatalogCache(
  directory: string,
  confirmTarget: string,
  offline: boolean,
): CatalogCacheRepository {
  const target = resolve(directory),
    name = basename(target),
    parent = dirname(target);
  const required = [...Object.values(collectionFiles), ".b2b-demo"],
    allowed: string[] = [
      ...required,
      "order_internal_notes.json",
      "audit_logs.json",
    ];
  return {
    async refresh(build) {
      let lock: Awaited<ReturnType<typeof open>> | undefined,
        staged = false;
      const stage = join(parent, `.${name}.sync-stage-${randomUUID()}`),
        backup = join(parent, `.${name}.sync-backup-${randomUUID()}`),
        lockPath = join(parent, `.${name}.lock`);
      let names: string[] = [];
      async function removeOwned(path: string) {
        for (const file of names) await unlink(join(path, file));
        await rmdir(path);
      }
      try {
        if (offline !== true) throw new CatalogSyncError();
        checkedTarget(name, { mode: "reset", confirmTarget });
        if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase())
          throw new CatalogSyncError();
        lock = await open(lockPath, "wx", 0o600);
        const stat = await lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new CatalogSyncError();
        names = await readdir(target);
        if (
          required.some((file) => !names.includes(file)) ||
          names.some((file) => !allowed.includes(file)) ||
          (await readFile(join(target, ".b2b-demo"), "utf8")) !==
            "b2b-portal-demo:v1"
        )
          throw new CatalogSyncError();
        for (const file of names) {
          const item = await lstat(join(target, file));
          if (!item.isFile() || item.isSymbolicLink())
            throw new CatalogSyncError();
        }
        const original = new JsonFileStore(target),
          cache = build({
            companies: await original.read("companies"),
            products: await original.read("products"),
          });
        await mkdir(stage);
        staged = true;
        for (const file of names) {
          await copyFile(join(target, file), join(stage, file));
          await chmod(join(stage, file), 0o600);
        }
        const staging = new JsonFileStore(stage);
        await staging.replace("products", cache.products);
        await staging.replace(
          "customer_product_access",
          cache.customer_product_access,
        );
        await staging.replace(
          "customer_product_prices",
          cache.customer_product_prices,
        );
        await rename(target, backup);
        try {
          await rename(stage, target);
          staged = false;
        } catch (error) {
          await rename(backup, target);
          throw error;
        }
        await removeOwned(backup);
        return {
          products: cache.products.length,
          access: cache.customer_product_access.length,
          prices: cache.customer_product_prices.length,
        };
      } catch {
        throw new CatalogSyncError();
      } finally {
        if (staged) {
          for (const file of names)
            await unlink(join(stage, file)).catch(() => {});
          await rmdir(stage).catch(() => {});
        }
        if (lock) {
          await lock.close();
          await unlink(lockPath);
        }
        // Never delete a recovery backup after a failed restore/cleanup.
      }
    },
  };
}
