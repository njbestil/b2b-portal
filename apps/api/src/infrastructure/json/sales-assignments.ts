import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SalesAssignmentRepository } from "../../repositories/sales-assignments.js";
import {
  checkedAssignments,
  assignmentId,
  SalesAssignmentError,
} from "../../services/sales-assignments.js";
import type { JsonSecurityCoordinator } from "./security.js";
export function createJsonSalesAssignments(
  security: JsonSecurityCoordinator,
  now = Date.now,
): SalesAssignmentRepository {
  const path = join(security.directory, "customer_sales_assignments.json");
  async function read() {
    let rows: ReturnType<typeof checkedAssignments>;
    try {
      const s = await lstat(path);
      if (!s.isFile() || s.isSymbolicLink() || s.size > 2 * 1024 * 1024)
        throw new Error();
      rows = checkedAssignments(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await readFile(path),
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
  const run = <T>(operation: () => Promise<T>) =>
    security.run(async () => {
      try {
        return await operation();
      } catch {
        throw new SalesAssignmentError("unavailable");
      }
    });
  return {
    allows: (staffId, companyId) => {
      const staff = assignmentId(staffId),
        company = assignmentId(companyId);
      return run(async () => {
        const { rows, users, companies } = await read(),
          user = users.find((u) => u.id === staff),
          tenant = companies.find((c) => c.id === company);
        if (
          user?.role !== "SALES_STAFF" ||
          user.status !== "ACTIVE" ||
          user.companyId !== null ||
          user.mustChangePassword !== false ||
          tenant?.status !== "ACTIVE"
        )
          return false;
        return rows.some(
          (r) =>
            r.companyId === company &&
            r.salesStaffUserId === staff &&
            r.active &&
            r.isPrimary &&
            r.endedAt === null &&
            Date.parse(r.createdAt) <= now(),
        );
      });
    },
    ready: () =>
      run(async () => {
        await read();
        return true;
      }).catch(() => false),
  };
}
