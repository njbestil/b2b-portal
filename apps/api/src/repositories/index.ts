import type { CompanyRepository } from "./companies.js";
import type { UserRepository } from "./users.js";
import type { CatalogRepository } from "./catalog.js";
import type { OrderRepository } from "./orders.js";

/** Current application read ports; never an infrastructure or business-write API. */
export interface RepositoryPorts {
  readonly companies: CompanyRepository;
  readonly users: UserRepository;
  readonly catalog: CatalogRepository;
  readonly orders: OrderRepository;
}
