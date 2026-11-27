import * as fs from "node:fs/promises";
import { join } from "node:path";
import type {
  SalesStaffActor,
  SalesStaffRepository,
  ManagedSalesStaff,
} from "../../repositories/sales-staff.js";
import type { JsonUser } from "./models.js";
import type { JsonSecurityCoordinator } from "./security.js";
import { createJsonSessionFile, type FileIo } from "./session-file.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { salesStaffActor } from "../sales-staff-state.js";
import {
  checkedNewSalesStaff,
  salesStaffId,
  SalesStaffError,
  validSalesStaffTransition,
  checkedStaffPage,
} from "../../services/sales-staff.js";
import { SessionError } from "../../services/session-state.js";
const view = (row: JsonUser): ManagedSalesStaff => ({
  id: row.id,
  companyId: null,
  displayName: row.displayName,
  email: row.email ?? null,
  role: "SALES_STAFF",
  status: row.status as ManagedSalesStaff["status"],
  mustChangePassword: row.mustChangePassword ?? false,
});
export function createJsonSalesStaff(
  security: JsonSecurityCoordinator,
  now = Date.now,
  options: {
    io?: FileIo;
    writeUsers?: (rows: readonly JsonUser[]) => Promise<void>;
  } = {},
): SalesStaffRepository {
  const sessions = createJsonSessionFile(security.directory, options.io ?? fs);
  const write =
    options.writeUsers ??
    ((rows: readonly JsonUser[]) => security.store.replace("users", rows));
  const run = <T>(work: () => Promise<T>) =>
    security.run(async () => {
      try {
        return await work();
      } catch (e) {
        if (e instanceof SalesStaffError || e instanceof SessionError) throw e;
        throw new SalesStaffError("unavailable");
      }
    });
  async function state(actor: SalesStaffActor) {
    // Do not claim an email reserved by an interrupted application publication.
    try {
      await fs.lstat(join(security.directory, "application_intent.json"));
      throw new SalesStaffError("unavailable");
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
    const users = await security.store.read("users"),
      rows = await sessions.read(),
      account = await readJsonSecurityAccount(security, actor.userId);
    const authorize = () =>
      salesStaffActor(
        actor,
        account,
        rows.find((s) => s.id === actor.sessionId) ?? null,
        now(),
      );
    authorize();
    return { users, rows, authorize };
  }
  return {
    list: (actor, input) => {
      const page = checkedStaffPage(input);
      return run(async () => {
        const { users, authorize } = await state(actor),
          matching = users
            .filter((u) => u.companyId === null && u.role === "SALES_STAFF")
            .sort((a, b) => a.id.localeCompare(b.id));
        authorize();
        return {
          items: matching
            .slice(page.offset, page.offset + page.limit)
            .map(view),
          total: matching.length,
        };
      });
    },
    create: (actor, value) =>
      run(async () => {
        const input = checkedNewSalesStaff(value),
          { users, authorize } = await state(actor);
        if (users.some((u) => u.id === input.id || u.email === input.email))
          throw new SalesStaffError("conflict");
        const row: JsonUser = {
          ...input,
          companyId: null,
          role: "SALES_STAFF",
          status: "ACTIVE",
          mustChangePassword: true,
        };
        authorize();
        await write([...users, row]);
        return view(row);
      }),
    change: (actor, id, expected, nextStatus) =>
      run(async () => {
        const key = salesStaffId(id);
        if (!validSalesStaffTransition(expected, nextStatus))
          throw new SalesStaffError("invalid_input");
        const { users, rows, authorize } = await state(actor),
          target = users.find(
            (u) =>
              u.id === key && u.companyId === null && u.role === "SALES_STAFF",
          );
        if (!target) throw new SalesStaffError("not_found");
        if (target.status !== expected) throw new SalesStaffError("conflict");
        const next = { ...target, status: nextStatus };
        const revoke = () =>
          sessions.publish(
            rows.map((r) =>
              r.userId === key && r.revokedAt === null
                ? { ...r, revokedAt: new Date(now()).toISOString() }
                : r,
            ),
          );
        // Inactive state first on deactivation; cleanup first on activation.
        // Old proofs cannot revive after interrupted deactivation cleanup.
        if (nextStatus === "ACTIVE") await revoke();
        authorize();
        await write(users.map((u) => (u.id === key ? next : u)));
        if (nextStatus === "DEACTIVATED") await revoke();
        return view(next);
      }),
  };
}
