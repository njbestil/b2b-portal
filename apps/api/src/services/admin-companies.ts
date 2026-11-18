import type { AdminCompanyRepository } from "../repositories/admin-companies.js";
import type { PageRequest } from "../repositories/common.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
import { statusId, AccountStatusError } from "./account-status.js";
import { checkedPage } from "./query-input.js";
export function checkedAdminPage(input?: PageRequest) {
  try {
    const page = checkedPage(input);
    if (page.offset > 100000) throw new Error();
    return page;
  } catch {
    throw new AccountStatusError("invalid_input");
  }
}
export function createAdminCompanies(repository: AdminCompanyRepository) {
  return async (actor: AuthorizedActor, input?: PageRequest) => {
    requirePermission(actor, "accounts.status.read");
    const page = checkedAdminPage(input);
    const result = await repository.list(
      {
        userId: statusId(actor.userId),
        sessionId: statusId(actor.sessionId),
        accessExpiresAt: actor.accessExpiresAt,
      },
      page,
    );
    try {
      const ids = result.items.map((row) => statusId(row.id));
      if (
        !Number.isSafeInteger(result.total) ||
        result.total < 0 ||
        result.items.length > page.limit ||
        result.total < result.items.length ||
        (result.items.length &&
          page.offset + result.items.length > result.total) ||
        new Set(ids).size !== ids.length ||
        result.items.some(
          (row, i) =>
            ![
              "PENDING",
              "ACTIVE",
              "SUSPENDED",
              "REJECTED",
              "DEACTIVATED",
            ].includes(row.status) ||
            (i > 0 && ids[i - 1]! >= ids[i]!),
        )
      )
        throw new Error();
    } catch {
      throw new AccountStatusError("unavailable");
    }
    return {
      items: result.items.map((row) => ({
        id: row.id,
        legalName: row.legalName,
        tradeName: row.tradeName,
        status: row.status,
        erpCustomerReference: row.erpCustomerReference,
      })),
      total: result.total,
      ...page,
    };
  };
}
