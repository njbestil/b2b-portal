import type { OrderNotesRepository } from "../../repositories/order-notes.js";
import { InternalNoteError } from "../../services/internal-notes.js";
import { SessionError } from "../../services/session-state.js";
import { CompanyProfileError } from "../../services/company-profiles.js";
import { profileActor } from "../company-profile-state.js";
import type { JsonSecurityCoordinator } from "./security.js";
import { createJsonInternalNotes } from "./internal-notes.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { createJsonSessionFile } from "./session-file.js";
import { createJsonSalesAssignmentFile } from "./sales-assignment-file.js";
export function createJsonOrderNotes(
  security: JsonSecurityCoordinator,
  now = Date.now,
): OrderNotesRepository {
  return {
    run: (actor, companyId, operation) =>
      security.run(async () => {
        try {
          const account = await readJsonSecurityAccount(security, actor.userId),
            session =
              (await createJsonSessionFile(security.directory).read()).find(
                (r) => r.id === actor.sessionId,
              ) ?? null;
          const company = (await security.store.read("companies")).find(
            (r) => r.id === companyId,
          );
          const assigned =
            actor.role === "SALES_STAFF" &&
            (await createJsonSalesAssignmentFile(security).read()).rows.some(
              (r) =>
                r.companyId === companyId &&
                r.salesStaffUserId === actor.userId &&
                r.active &&
                r.isPrimary &&
                r.endedAt === null &&
                Date.parse(r.createdAt) <= now(),
            );
          const check = () =>
            profileActor(
              actor,
              account,
              session,
              companyId,
              company?.status ?? null,
              assigned,
              false,
              now(),
            );
          check();
          const result = await operation(
            createJsonInternalNotes(security.directory, undefined, check),
          );
          check();
          return result;
        } catch (e) {
          if (
            e instanceof InternalNoteError ||
            e instanceof SessionError ||
            e instanceof CompanyProfileError
          )
            throw e;
          throw new InternalNoteError("storage_failed");
        }
      }),
  };
}
