import type { RepositoryPorts } from "../repositories/index.js";
import type { PageRequest, Page } from "../repositories/common.js";
import type { CompanyProfile } from "../repositories/companies.js";
import type { CustomerUserProfile } from "../repositories/users.js";
import type { CatalogProduct } from "../repositories/catalog.js";
import type { OrderSummary } from "../repositories/orders.js";
import {
  requirePermission,
  AuthorizationError,
  type AuthorizedActor,
  type Permission,
} from "./authorization.js";
import { SessionError } from "./session-state.js";
import { checkedPage } from "./query-input.js";
export class TenantQueryError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "unavailable") {
    super("Company query could not be confirmed.");
    this.name = "TenantQueryError";
  }
}
const notFound = () => new TenantQueryError("not_found");
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new TenantQueryError("invalid_input");
  return value.toLowerCase();
}
const companyView = (row: CompanyProfile) => ({
  id: row.id,
  legalName: row.legalName,
  tradeName: row.tradeName,
  status: row.status,
  erpCustomerReference: row.erpCustomerReference,
});
const userView = (row: CustomerUserProfile) => ({
  id: row.id,
  companyId: row.companyId,
  displayName: row.displayName,
  role: row.role,
  status: row.status,
});
const productView = (row: CatalogProduct) => ({
  id: row.id,
  sku: row.sku,
  name: row.name,
  sellingUom: row.sellingUom,
  minimumOrderQuantity: row.minimumOrderQuantity,
  price: row.price
    ? { amount: row.price.amount, currency: row.price.currency }
    : null,
});
const orderView = (row: OrderSummary) => ({
  id: row.id,
  companyId: row.companyId,
  orderNumber: row.orderNumber,
  createdAt: row.createdAt,
  status: row.status,
  integrationStatus: row.integrationStatus,
});
function pageRequest(page?: PageRequest) {
  try {
    return checkedPage(page);
  } catch {
    throw new TenantQueryError("invalid_input");
  }
}
function pageView<T, R>(
  result: Page<T>,
  page: PageRequest,
  view: (row: T) => R,
  valid: (row: T) => boolean,
): Page<R> {
  if (
    !Number.isSafeInteger(result.total) ||
    result.total < 0 ||
    result.items.length > page.limit ||
    result.total < result.items.length ||
    result.items.some((row) => !valid(row))
  )
    throw new TenantQueryError("unavailable");
  return { items: result.items.map(view), total: result.total };
}
/** Only authenticated actor input; never accept CompanyScope from HTTP callers. */
export function createTenantQueries(repositories: RepositoryPorts) {
  async function access(
    actor: AuthorizedActor,
    permission: Permission,
    companyId: unknown,
  ) {
    requirePermission(actor, permission);
    const company = id(companyId),
      customer =
        actor.role === "CUSTOMER_ADMIN" || actor.role === "CUSTOMER_USER";
    if (customer && actor.companyId !== company) throw notFound();
    // #34 owns the assignment producer. Role permission alone never grants Sales
    // ownership, and this PR must not substitute a caller-provided assignment.
    if (actor.role === "SALES_STAFF") throw new AuthorizationError();
    const scope = Object.freeze({ companyId: company }),
      row = await repositories.companies.findById(scope);
    if (!row) throw notFound();
    if (row.id !== company) throw new TenantQueryError("unavailable");
    if (customer && row.status !== "ACTIVE")
      throw new SessionError("invalid_proof");
    return { scope, company: row };
  }
  return {
    async getCompany(actor: AuthorizedActor, companyId: unknown) {
      const result = await access(actor, "company.read", companyId);
      return companyView(result.company);
    },
    async listUsers(
      actor: AuthorizedActor,
      companyId: unknown,
      input?: PageRequest,
    ) {
      const page = pageRequest(input),
        { scope } = await access(actor, "customer-users.read", companyId);
      return pageView(
        await repositories.users.listCustomers(scope, page),
        page,
        userView,
        (row) =>
          row.companyId === scope.companyId &&
          ["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(row.role),
      );
    },
    async getUser(actor: AuthorizedActor, companyId: unknown, userId: unknown) {
      const key = id(userId),
        { scope } = await access(actor, "customer-users.read", companyId);
      const row = await repositories.users.findCustomerById(scope, key);
      if (
        !row ||
        row.id !== key ||
        row.companyId !== scope.companyId ||
        !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(row.role)
      )
        throw notFound();
      return userView(row);
    },
    async listProducts(
      actor: AuthorizedActor,
      companyId: unknown,
      input?: PageRequest,
    ) {
      const page = pageRequest(input),
        { scope } = await access(actor, "catalog.read", companyId);
      return pageView(
        await repositories.catalog.listEligible(scope, page),
        page,
        productView,
        () => true,
      );
    },
    async getProduct(
      actor: AuthorizedActor,
      companyId: unknown,
      productId: unknown,
    ) {
      const key = id(productId),
        { scope } = await access(actor, "catalog.read", companyId);
      const row = await repositories.catalog.findEligibleById(scope, key);
      if (!row || row.id !== key) throw notFound();
      return productView(row);
    },
    async listOrders(
      actor: AuthorizedActor,
      companyId: unknown,
      input?: PageRequest,
    ) {
      const page = pageRequest(input),
        { scope } = await access(actor, "orders.read", companyId);
      return pageView(
        await repositories.orders.list(scope, page),
        page,
        orderView,
        (row) => row.companyId === scope.companyId,
      );
    },
    async getOrder(
      actor: AuthorizedActor,
      companyId: unknown,
      orderId: unknown,
    ) {
      const key = id(orderId),
        { scope } = await access(actor, "orders.read", companyId);
      const row = await repositories.orders.findById(scope, key);
      if (!row || row.id !== key || row.companyId !== scope.companyId)
        throw notFound();
      return orderView(row);
    },
  };
}
export type TenantQueries = ReturnType<typeof createTenantQueries>;
