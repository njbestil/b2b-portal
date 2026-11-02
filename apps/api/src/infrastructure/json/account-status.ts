import * as fs from "node:fs/promises";
import type {
  AccountStatusRepository,
  StatusTargetKind,
  StatusActor,
  StatusTarget,
} from "../../repositories/account-status.js";
import type { JsonCompany, JsonUser } from "./models.js";
import type { JsonSecurityCoordinator } from "./security.js";
import { createJsonSessionFile, type FileIo } from "./session-file.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { statusActor } from "../account-status-state.js";
import { AccountStatusError, statusId } from "../../services/account-status.js";
import { SessionError } from "../../services/session-state.js";
export function createJsonAccountStatus(
  security: JsonSecurityCoordinator,
  now = Date.now,
  options: {
    io?: FileIo;
    writeUsers?: (rows: readonly JsonUser[]) => Promise<void>;
    writeCompanies?: (rows: readonly JsonCompany[]) => Promise<void>;
  } = {},
): AccountStatusRepository {
  const sessions = createJsonSessionFile(security.directory, options.io ?? fs);
  const writeUsers =
    options.writeUsers ??
    ((rows: readonly JsonUser[]) => security.store.replace("users", rows));
  const writeCompanies =
    options.writeCompanies ??
    ((rows: readonly JsonCompany[]) =>
      security.store.replace("companies", rows));
  const run = <T>(work: () => Promise<T>) =>
    security.run(async () => {
      try {
        return await work();
      } catch (e) {
        if (e instanceof AccountStatusError || e instanceof SessionError)
          throw e;
        throw new AccountStatusError("unavailable");
      }
    });
  async function current(
    actor: StatusActor,
    kind: StatusTargetKind,
    id: string,
  ) {
    statusId(actor.userId);
    statusId(actor.sessionId);
    statusId(id);
    if (kind !== "user" && kind !== "company")
      throw new AccountStatusError("invalid_input");
    const rows = await sessions.read();
    statusActor(
      actor,
      await readJsonSecurityAccount(security, actor.userId),
      rows.find((r) => r.id === actor.sessionId) ?? null,
      now(),
    );
    const users = await security.store.read("users"),
      companies = await security.store.read("companies");
    const row =
      kind === "user"
        ? users.find((r) => r.id === id)
        : companies.find((r) => r.id === id);
    if (!row) throw new AccountStatusError("not_found");
    const companyId = kind === "company" ? id : (row as JsonUser).companyId;
    if (companyId !== null && !companies.some((c) => c.id === companyId))
      throw new AccountStatusError("unavailable");
    const target: StatusTarget = { id, kind, status: row.status, companyId };
    return { rows, users, companies, target };
  }
  return {
    current: (actor, kind, id) =>
      run(async () => (await current(actor, kind, id)).target),
    change: (actor, kind, id, expected, next) =>
      run(async () => {
        const state = await current(actor, kind, id);
        if (kind === "user" && id === actor.userId)
          throw new AccountStatusError("forbidden");
        if (
          !["ACTIVE", "SUSPENDED"].includes(expected) ||
          !["ACTIVE", "SUSPENDED"].includes(next) ||
          expected === next
        )
          throw new AccountStatusError("invalid_input");
        if (state.target.status !== expected)
          throw new AccountStatusError("conflict");
        const affected = new Set(
          kind === "user"
            ? [id]
            : state.users.filter((u) => u.companyId === id).map((u) => u.id),
        );
        const cleanup = () =>
          sessions.publish(
            state.rows.map((row) =>
              affected.has(row.userId) && row.revokedAt === null
                ? { ...row, revokedAt: new Date(now()).toISOString() }
                : row,
            ),
          );
        const publish = () =>
          kind === "user"
            ? writeUsers(
                state.users.map((u) =>
                  u.id === id ? { ...u, status: next } : u,
                ),
              )
            : writeCompanies(
                state.companies.map((c) =>
                  c.id === id ? { ...c, status: next } : c,
                ),
              );
        // Inactive first on suspension; all old proofs cleared before activation.
        if (next === "SUSPENDED") {
          await publish();
          await cleanup();
        } else {
          await cleanup();
          await publish();
        }
        return { ...state.target, status: next };
      }),
  };
}
