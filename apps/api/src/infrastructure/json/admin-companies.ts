import type { AdminCompanyRepository } from "../../repositories/admin-companies.js";
import type { JsonSecurityCoordinator } from "./security.js";
import { createJsonSessionFile } from "./session-file.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { adminCompanyActor } from "../admin-company-state.js";
import { AccountStatusError, statusId } from "../../services/account-status.js";
import { checkedAdminPage } from "../../services/admin-companies.js";
import { SessionError } from "../../services/session-state.js";
export function createJsonAdminCompanies(
  security: JsonSecurityCoordinator,
  now = Date.now,
): AdminCompanyRepository {
  const sessions = createJsonSessionFile(security.directory);
  return {
    list: (actor, input) => {
      const page = checkedAdminPage(input);
      statusId(actor.userId);
      statusId(actor.sessionId);
      return security.run(async () => {
        try {
          const companies = await security.store.read("companies"),
            proofs = await sessions.read(),
            account = await readJsonSecurityAccount(security, actor.userId);
          adminCompanyActor(
            actor,
            account,
            proofs.find((r) => r.id === actor.sessionId) ?? null,
            now(),
          );
          const ordered = [...companies].sort((a, b) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
          );
          return {
            total: ordered.length,
            items: ordered
              .slice(page.offset, page.offset + page.limit)
              .map(
                ({
                  id,
                  legalName,
                  tradeName,
                  status,
                  erpCustomerReference,
                }) => ({
                  id,
                  legalName,
                  tradeName,
                  status,
                  erpCustomerReference,
                }),
              ),
          };
        } catch (e) {
          if (e instanceof SessionError || e instanceof AccountStatusError)
            throw e;
          throw new AccountStatusError("unavailable");
        }
      });
    },
  };
}
