import * as fs from "node:fs/promises";
import { join } from "node:path";
import type {
  CustomerUserActor,
  CustomerUserRepository,
  ManagedCustomerUser,
} from "../../repositories/customer-users.js";
import type { JsonUser } from "./models.js";
import type { JsonSecurityCoordinator } from "./security.js";
import { createJsonSessionFile, type FileIo } from "./session-file.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { customerUserActor } from "../customer-user-state.js";
import {
  checkedNewCustomerUser,
  customerUserId,
  CustomerUserError,
} from "../../services/customer-users.js";
import { SessionError } from "../../services/session-state.js";
const view = (row: JsonUser): ManagedCustomerUser => ({
  id: row.id,
  companyId: row.companyId!,
  displayName: row.displayName,
  email: row.email ?? null,
  role: "CUSTOMER_USER",
  status: row.status as ManagedCustomerUser["status"],
  mustChangePassword: row.mustChangePassword ?? false,
});
export function createJsonCustomerUsers(
  security: JsonSecurityCoordinator,
  now = Date.now,
  options: {
    io?: FileIo;
    writeUsers?: (rows: readonly JsonUser[]) => Promise<void>;
  } = {},
): CustomerUserRepository {
  const sessions = createJsonSessionFile(security.directory, options.io ?? fs);
  const write =
    options.writeUsers ??
    ((rows: readonly JsonUser[]) => security.store.replace("users", rows));
  const run = <T>(work: () => Promise<T>) =>
    security.run(async () => {
      try {
        return await work();
      } catch (e) {
        if (e instanceof CustomerUserError || e instanceof SessionError)
          throw e;
        throw new CustomerUserError("unavailable");
      }
    });
  async function state(actor: CustomerUserActor) {
    // Do not claim an email reserved by an interrupted application publication.
    try {
      await fs.lstat(join(security.directory, "application_intent.json"));
      throw new CustomerUserError("unavailable");
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
    const users = await security.store.read("users"),
      rows = await sessions.read(),
      account = await readJsonSecurityAccount(security, actor.userId);
    customerUserActor(
      actor,
      account,
      rows.find((s) => s.id === actor.sessionId) ?? null,
      now(),
    );
    return { users, rows };
  }
  return {
    create: (actor, value) =>
      run(async () => {
        const input = checkedNewCustomerUser(value),
          { users } = await state(actor);
        if (users.some((u) => u.id === input.id || u.email === input.email))
          throw new CustomerUserError("conflict");
        const row: JsonUser = {
          ...input,
          companyId: actor.companyId,
          role: "CUSTOMER_USER",
          status: "ACTIVE",
          mustChangePassword: true,
        };
        await write([...users, row]);
        return view(row);
      }),
    deactivate: (actor, id, expected) =>
      run(async () => {
        const key = customerUserId(id);
        if (!["ACTIVE", "SUSPENDED"].includes(expected))
          throw new CustomerUserError("invalid_input");
        const { users, rows } = await state(actor),
          target = users.find(
            (u) =>
              u.id === key &&
              u.companyId === actor.companyId &&
              u.role === "CUSTOMER_USER",
          );
        if (!target) throw new CustomerUserError("not_found");
        if (target.status !== expected) throw new CustomerUserError("conflict");
        const next = { ...target, status: "DEACTIVATED" as const };
        await write(users.map((u) => (u.id === key ? next : u)));
        await sessions.publish(
          rows.map((r) =>
            r.userId === key && r.revokedAt === null
              ? { ...r, revokedAt: new Date(now()).toISOString() }
              : r,
          ),
        );
        return view(next);
      }),
  };
}
