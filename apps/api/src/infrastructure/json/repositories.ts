import type { CompanyRepository } from "../../repositories/companies.js";
import type {
  CatalogProduct,
  CatalogRepository,
} from "../../repositories/catalog.js";
import type {
  CustomerUserProfile,
  UserRepository,
} from "../../repositories/users.js";
import type { OrderRepository } from "../../repositories/orders.js";
import type { CompanyScope, PageRequest } from "../../repositories/common.js";
import { checkedPage, checkedScope } from "../../services/query-input.js";
import type { JsonPrice, JsonUser } from "./models.js";
import type { JsonFileStore } from "./store.js";

const companyScope = (scope: CompanyScope) =>
  checkedScope(scope).companyId.toLowerCase();

const ascending = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const pageOf = <T>(rows: T[], page: PageRequest) => ({
  items: rows.slice(page.offset, page.offset + page.limit),
  total: rows.length,
});
const customer = (row: JsonUser): row is CustomerUserProfile =>
  row.role === "CUSTOMER_ADMIN" || row.role === "CUSTOMER_USER";

export function createJsonRepositories(
  store: JsonFileStore,
  now: () => Date = () => new Date(),
): {
  companies: CompanyRepository;
  users: UserRepository;
  catalog: CatalogRepository;
  orders: OrderRepository;
} {
  const companyUsers = async (companyId: string) =>
    (await store.read("users"))
      .filter(
        (row): row is CustomerUserProfile =>
          customer(row) && row.companyId === companyId,
      )
      .map(({ id, companyId, displayName, role, status }) => ({
        id,
        companyId,
        displayName,
        role,
        status,
      }));
  const companyOrders = async (companyId: string) =>
    (await store.read("orders")).filter((row) => row.companyId === companyId);
  const catalog = async (companyId: string): Promise<CatalogProduct[]> => {
    const at = now().getTime();
    if (!Number.isFinite(at))
      throw new TypeError("A valid repository clock is required.");
    const valid = (price: JsonPrice | null | undefined): price is JsonPrice =>
      !!price &&
      (price.validFrom === null || Date.parse(price.validFrom) <= at) &&
      (price.validTo === null || at < Date.parse(price.validTo));
    const [products, access, prices] = await Promise.all([
      store.read("products"),
      store.read("customer_product_access"),
      store.read("customer_product_prices"),
    ]);
    const eligible = new Set(
      access
        .filter((row) => row.companyId === companyId && row.eligible)
        .map((row) => row.productId),
    );
    const customerPrices = new Map(
      prices
        .filter((row) => row.companyId === companyId)
        .map((row) => [row.productId, row.price]),
    );
    return products
      .filter((row) => row.active && eligible.has(row.id))
      .map((row) => {
        const custom = customerPrices.get(row.id);
        const resolved = valid(custom)
          ? custom
          : valid(row.defaultPrice)
            ? row.defaultPrice
            : null;
        return {
          id: row.id,
          sku: row.sku,
          name: row.name,
          sellingUom: row.sellingUom,
          minimumOrderQuantity: row.minimumOrderQuantity,
          price: resolved
            ? { amount: resolved.amount, currency: resolved.currency }
            : null,
        };
      });
  };
  return {
    companies: {
      async findById(scope) {
        const companyId = companyScope(scope);
        return (
          (await store.read("companies")).find((row) => row.id === companyId) ??
          null
        );
      },
    },
    users: {
      async findCustomerById(scope, userId) {
        const companyId = companyScope(scope);
        return (
          (await companyUsers(companyId)).find(
            (row) => row.id === userId.toLowerCase(),
          ) ?? null
        );
      },
      async listCustomers(scope, page) {
        const companyId = companyScope(scope);
        const request = checkedPage(page);
        return pageOf((await companyUsers(companyId)).sort(ascending), request);
      },
    },
    catalog: {
      async findEligibleById(scope, productId) {
        const companyId = companyScope(scope);
        return (
          (await catalog(companyId)).find(
            (row) => row.id === productId.toLowerCase(),
          ) ?? null
        );
      },
      async listEligible(scope, page) {
        const companyId = companyScope(scope);
        const request = checkedPage(page);
        return pageOf((await catalog(companyId)).sort(ascending), request);
      },
    },
    orders: {
      async findById(scope, orderId) {
        const companyId = companyScope(scope);
        return (
          (await companyOrders(companyId)).find(
            (row) => row.id === orderId.toLowerCase(),
          ) ?? null
        );
      },
      async list(scope, page) {
        const companyId = companyScope(scope);
        const request = checkedPage(page);
        const rows = (await companyOrders(companyId)).sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || ascending(a, b),
        );
        return pageOf(rows, request);
      },
    },
  };
}
