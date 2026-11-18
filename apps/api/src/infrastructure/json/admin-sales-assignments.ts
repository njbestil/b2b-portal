import * as fs from "node:fs/promises";
import type { AdminSalesAssignmentRepository } from "../../repositories/admin-sales-assignments.js";
import type { JsonSecurityCoordinator } from "./security.js";
import { createJsonSessionFile, type FileIo } from "./session-file.js";
import { createJsonSalesAssignmentFile } from "./sales-assignment-file.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { assignmentAdminActor } from "../assignment-admin-state.js";
import {
  AssignmentManagementError,
  checkedAssignmentChange,
  managementId,
} from "../../services/admin-sales-assignments.js";
import { SessionError } from "../../services/session-state.js";
export function createJsonAdminSalesAssignments(
  security: JsonSecurityCoordinator,
  now = Date.now,
  io: FileIo = fs,
): AdminSalesAssignmentRepository {
  const file = createJsonSalesAssignmentFile(security, io),
    sessions = createJsonSessionFile(security.directory);
  const run = <T>(work: () => Promise<T>) =>
    security.run(async () => {
      try {
        return await work();
      } catch (e) {
        if (e instanceof AssignmentManagementError || e instanceof SessionError)
          throw e;
        throw new AssignmentManagementError("unavailable");
      }
    });
  async function state(
    actor: Parameters<AdminSalesAssignmentRepository["current"]>[0],
    id: string,
  ) {
    const data = await file.read(),
      account = await readJsonSecurityAccount(security, actor.userId),
      proofs = await sessions.read();
    const authorize = () =>
      assignmentAdminActor(
        actor,
        account,
        proofs.find((s) => s.id === actor.sessionId) ?? null,
        now(),
      );
    authorize();
    const company = data.companies.find((c) => c.id === id);
    if (!company) throw new AssignmentManagementError("not_found");
    const active = data.rows.filter((r) => r.companyId === id && r.active);
    if (active.some((r) => Date.parse(r.createdAt) > now()))
      throw new AssignmentManagementError("unavailable");
    return {
      ...data,
      company,
      active,
      current: active.find((r) => r.isPrimary) ?? null,
      authorize,
    };
  }
  return {
    current: (actor, id) =>
      run(async () => {
        managementId(id);
        const s = await state(actor, id);
        s.authorize();
        return s.current;
      }),
    assign: (actor, value) =>
      run(async () => {
        const input = checkedAssignmentChange(value),
          s = await state(actor, input.companyId);
        const staff = s.users.find(
          (u) =>
            u.id === input.salesStaffUserId &&
            u.role === "SALES_STAFF" &&
            u.companyId === null,
        );
        if (!staff) throw new AssignmentManagementError("not_found");
        if (
          !["ACTIVE", "SUSPENDED"].includes(s.company.status) ||
          staff.status !== "ACTIVE"
        )
          throw new AssignmentManagementError("conflict");
        if (
          (s.current?.id ?? null) !== input.expectedAssignmentId ||
          s.current?.salesStaffUserId === staff.id
        )
          throw new AssignmentManagementError("conflict");
        if (s.rows.some((r) => r.id === input.id))
          throw new AssignmentManagementError("conflict");
        const time = new Date(now()).toISOString(),
          row = {
            id: input.id,
            companyId: input.companyId,
            salesStaffUserId: staff.id,
            assignedByUserId: actor.userId,
            isPrimary: true,
            active: true,
            createdAt: time,
            endedAt: null,
          };
        const rows = s.rows.map((r) =>
          r.companyId === input.companyId && r.active
            ? { ...r, active: false, endedAt: time }
            : r,
        );
        await file.publish([...rows, row], s.authorize);
        return row;
      }),
  };
}
