import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AuditRecord, AuditRepository } from "../../repositories/audit.js";
import { AuditError, checkedAudit } from "../../services/audit.js";
import { JsonFileStore } from "./store.js";

/** One instance/process per trusted directory. No public/customer read surface. */
export function createJsonAudit(directory: string): AuditRepository {
  const root = resolve(directory),
    path = join(root, "audit_logs.json"),
    store = new JsonFileStore(root);
  let queue = Promise.resolve();
  async function read(): Promise<AuditRecord[]> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
    const input: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)),
    );
    if (!Array.isArray(input)) throw new Error();
    const rows = Array.from(input, (row: AuditRecord) => checkedAudit(row));
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new Error();
    return rows;
  }
  return {
    async append(input) {
      const record = checkedAudit(input);
      const result = queue.then(async () => {
        const temporary = join(root, `.audit_logs.${randomUUID()}.tmp`);
        try {
          if (
            record.actorUserId &&
            !(await store.read("users")).some(
              (user) => user.id === record.actorUserId,
            )
          )
            throw new Error();
          if (
            record.companyId &&
            !(await store.read("companies")).some(
              (company) => company.id === record.companyId,
            )
          )
            throw new Error();
          const rows = await read();
          if (rows.some((row) => row.id === record.id)) throw new Error();
          rows.push(record);
          await mkdir(root, { recursive: true });
          const handle = await open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(
              JSON.stringify(rows, null, 2) + "\n",
              "utf8",
            );
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, path);
          return checkedAudit(record);
        } catch {
          throw new AuditError("storage_failed");
        } finally {
          await unlink(temporary).catch(() => {});
        }
      });
      queue = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
}
