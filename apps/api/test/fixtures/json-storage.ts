import type { CompanyRepository } from "../../src/repositories/companies.js";
import type { UserRepository } from "../../src/repositories/users.js";
import type { CatalogRepository } from "../../src/repositories/catalog.js";
import type { OrderRepository } from "../../src/repositories/orders.js";
import { JsonFileStore } from "../../src/infrastructure/json/store.js";
import { createJsonRepositories } from "../../src/infrastructure/json/repositories.js";

const store = new JsonFileStore("backend-configured-directory");
const repos = createJsonRepositories(store);
const companies: CompanyRepository = repos.companies;
const users: UserRepository = repos.users;
const catalog: CatalogRepository = repos.catalog;
const orders: OrderRepository = repos.orders;
void [companies, users, catalog, orders];
// @ts-expect-error Collection names are fixed, not caller-supplied file paths.
store.read("../secrets");
// @ts-expect-error No generic business-write operation was added to the port.
repos.orders.create({});
store.replace("products", [
  {
    id: "00000000-0000-4000-8000-000000000001",
    sku: "SKU",
    name: "Bulk",
    sellingUom: "KG",
    active: true,
    defaultPrice: null,
    // @ts-expect-error Fractional decimal values must remain exact strings.
    minimumOrderQuantity: 0.125,
  },
]);
