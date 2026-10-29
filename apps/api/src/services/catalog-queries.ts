import type { CatalogRepository } from "../repositories/catalog.js";
import type {
  CompanyScope,
  EntityId,
  PageRequest,
} from "../repositories/common.js";
import { checkedPage, checkedScope } from "./query-input.js";

export function createCatalogQueries(catalog: CatalogRepository) {
  return {
    getProduct(scope: CompanyScope, productId: EntityId) {
      return catalog.findEligibleById(checkedScope(scope), productId);
    },
    listProducts(scope: CompanyScope, page?: PageRequest) {
      return catalog.listEligible(checkedScope(scope), checkedPage(page));
    },
  };
}
