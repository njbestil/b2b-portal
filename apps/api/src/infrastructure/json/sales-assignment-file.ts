import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SalesAssignment } from "../../repositories/sales-assignments.js";
import { checkedAssignments } from "../../services/sales-assignments.js";
import type { JsonSecurityCoordinator } from "./security.js";
import type { FileIo } from "./session-file.js";
/** Shared private file/model for policy readers and the coordinated admin writer. */
export function createJsonSalesAssignmentFile(
  security: JsonSecurityCoordinator,
  io: FileIo = fs,
) {
  const path = join(security.directory, "customer_sales_assignments.json");
  async function read() {
    let rows: SalesAssignment[];
    try {
      const stat = await io.lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 2 * 1024 * 1024
      )
        throw new Error();
      rows = checkedAssignments(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await io.readFile(path),
          ),
        ),
      );
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") rows = [];
      else throw e;
    }
    const users = await security.store.read("users"),
      companies = await security.store.read("companies");
    if (
      rows.some(
        (r) =>
          !companies.some((c) => c.id === r.companyId) ||
          !users.some((u) => u.id === r.salesStaffUserId) ||
          !users.some((u) => u.id === r.assignedByUserId),
      )
    )
      throw new Error();
    return { rows, users, companies };
  }
  async function publish(rows: SalesAssignment[], beforePublish: () => void) {
    const text = JSON.stringify(checkedAssignments(rows), null, 2) + "\n";
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error();
    const temporary = join(
      security.directory,
      ".customer_sales_assignments." + randomUUID() + ".tmp",
    );
    try {
      const handle = await io.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      beforePublish();
      await io.rename(temporary, path);
    } finally {
      await io.unlink(temporary).catch(() => {});
    }
  }
  return { read, publish };
}
