import type {
  CompanyScope,
  EntityId,
  PageRequest,
} from "../repositories/common.js";
import type { OrderRepository } from "../repositories/orders.js";
import { checkedPage, checkedScope } from "./query-input.js";

export function createOrderQueries(orders: OrderRepository) {
  return {
    getOrder(scope: CompanyScope, orderId: EntityId) {
      return orders.findById(checkedScope(scope), orderId);
    },
    listOrders(scope: CompanyScope, page?: PageRequest) {
      return orders.list(checkedScope(scope), checkedPage(page));
    },
  };
}
