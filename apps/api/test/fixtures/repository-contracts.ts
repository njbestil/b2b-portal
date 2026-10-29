import type { CompanyRepository } from "../../src/repositories/companies.js";
import type {
  CatalogRepository,
  CatalogProduct,
} from "../../src/repositories/catalog.js";
import type { CompanyScope, Page } from "../../src/repositories/common.js";
import type {
  OrderRepository,
  OrderSummary,
} from "../../src/repositories/orders.js";
import type {
  UserRepository,
  CustomerUserProfile,
} from "../../src/repositories/users.js";
import { createCompanyQueries } from "../../src/services/company-queries.js";
import { createCatalogQueries } from "../../src/services/catalog-queries.js";
import { createOrderQueries } from "../../src/services/order-queries.js";

// Compile-only structural implementations; no provider base class is required.
const scope: CompanyScope = {
  companyId: "00000000-0000-4000-8000-000000000001",
};
const companies: CompanyRepository = {
  async findById({ companyId }) {
    return {
      id: companyId,
      legalName: "Demo",
      tradeName: "Demo",
      status: "ACTIVE",
      erpCustomerReference: null,
    };
  },
};
const user: CustomerUserProfile = {
  id: "user-id",
  companyId: scope.companyId,
  displayName: "Buyer",
  role: "CUSTOMER_USER",
  status: "ACTIVE",
};
const users: UserRepository = {
  async findCustomerById() {
    return user;
  },
  async listCustomers() {
    return { items: [user], total: 1 };
  },
};
const product: CatalogProduct = {
  id: "product-id",
  sku: "KG-1",
  name: "Bulk",
  sellingUom: "KG",
  minimumOrderQuantity: "0.125",
  price: { amount: "12.50", currency: "AED" },
};
const catalog: CatalogRepository = {
  async findEligibleById() {
    return product;
  },
  async listEligible() {
    return { items: [product], total: 1 };
  },
};
const order: OrderSummary = {
  id: "order-id",
  companyId: scope.companyId,
  orderNumber: null,
  createdByUserId: user.id,
  createdAt: "2026-10-29T00:00:00.000Z",
  status: "SUBMITTED",
  integrationStatus: "FAILED",
};
const orders: OrderRepository = {
  async findById() {
    return order;
  },
  async list() {
    return { items: [order], total: 1 };
  },
};

const companyQueries = createCompanyQueries(companies, users);
const catalogQueries = createCatalogQueries(catalog);
const orderQueries = createOrderQueries(orders);
const userResult: Promise<CustomerUserProfile | null> =
  companyQueries.getCustomerUser(scope, user.id);
const productResult: Promise<CatalogProduct | null> = catalogQueries.getProduct(
  scope,
  product.id,
);
const orderResult: Promise<Page<OrderSummary>> = orderQueries.listOrders(scope);
void [userResult, productResult, orderResult];

// These negative checks fail the test if a contract silently becomes unsafe/any.
// @ts-expect-error A company scope is mandatory even for a lookup.
orders.findById(order.id);
// @ts-expect-error Lists cannot omit the company scope and pagination.
catalog.listEligible();
// @ts-expect-error An internal account is not a customer-directory record.
const internalUser: CustomerUserProfile = { ...user, role: "SALES_STAFF" };
// @ts-expect-error Technical integration state is not business order state.
const invalidOrder: OrderSummary = { ...order, status: "FAILED" };
const invalidProduct: CatalogProduct = {
  ...product,
  // @ts-expect-error Fractional quantities must not become floating-point values.
  minimumOrderQuantity: 0.125,
};
const driverRepository: CompanyRepository = {
  // @ts-expect-error A driver-specific rows wrapper is not a logical read result.
  findById: async () => ({ rows: [] }),
};
// @ts-expect-error Consumers may not mutate persistence projections.
order.status = "CANCELLED";
void [internalUser, invalidOrder, invalidProduct, driverRepository];
