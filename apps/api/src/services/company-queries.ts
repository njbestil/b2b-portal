import type { CompanyRepository } from "../repositories/companies.js";
import type {
  CompanyScope,
  EntityId,
  PageRequest,
} from "../repositories/common.js";
import type { UserRepository } from "../repositories/users.js";
import { checkedPage, checkedScope } from "./query-input.js";

/** Internal application queries. Callers must first authorize company access. */
export function createCompanyQueries(
  companies: CompanyRepository,
  users: UserRepository,
) {
  return {
    getProfile(scope: CompanyScope) {
      return companies.findById(checkedScope(scope));
    },
    getCustomerUser(scope: CompanyScope, userId: EntityId) {
      return users.findCustomerById(checkedScope(scope), userId);
    },
    listCustomerUsers(scope: CompanyScope, page?: PageRequest) {
      return users.listCustomers(checkedScope(scope), checkedPage(page));
    },
  };
}
