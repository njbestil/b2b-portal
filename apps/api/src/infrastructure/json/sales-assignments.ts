import { createJsonSalesAssignmentFile } from "./sales-assignment-file.js";
import type { SalesAssignmentRepository } from "../../repositories/sales-assignments.js";
import {
  assignmentId,
  SalesAssignmentError,
  checkedSalesPage,
} from "../../services/sales-assignments.js";
import type { JsonSecurityCoordinator } from "./security.js";
import { createJsonSessionFile } from "./session-file.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { salesListingActor } from "../sales-list-state.js";
import { SessionError } from "../../services/session-state.js";
export function createJsonSalesAssignments(
  security: JsonSecurityCoordinator,
  now = Date.now,
): SalesAssignmentRepository {
  const { read } = createJsonSalesAssignmentFile(security);
  const sessions = createJsonSessionFile(security.directory);
  const run = <T>(operation: () => Promise<T>) =>
    security.run(async () => {
      try {
        return await operation();
      } catch (e) {
        if (
          e instanceof SessionError ||
          (e instanceof SalesAssignmentError && e.code === "forbidden")
        )
          throw e;
        throw new SalesAssignmentError("unavailable");
      }
    });
  return {
    listAssigned: (actor, input) => {
      const page = checkedSalesPage(input);
      return run(async () => {
        const { rows, companies } = await read(),
          proofs = await sessions.read(),
          account = await readJsonSecurityAccount(security, actor.userId),
          at = now();
        salesListingActor(
          actor,
          account,
          proofs.find((r) => r.id === actor.sessionId) ?? null,
          at,
        );
        const granted = new Set(
          rows
            .filter(
              (a) =>
                a.salesStaffUserId === actor.userId &&
                a.active &&
                a.isPrimary &&
                a.endedAt === null &&
                Date.parse(a.createdAt) <= at,
            )
            .map((a) => a.companyId),
        );
        const matching = companies
          .filter((c) => c.status === "ACTIVE" && granted.has(c.id))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return {
          items: matching
            .slice(page.offset, page.offset + page.limit)
            .map(
              ({ id, legalName, tradeName, status, erpCustomerReference }) => ({
                id,
                legalName,
                tradeName,
                status,
                erpCustomerReference,
              }),
            ),
          total: matching.length,
        };
      });
    },
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
