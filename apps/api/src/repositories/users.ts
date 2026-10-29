import type {
  AccountStatus,
  CompanyScope,
  EntityId,
  Page,
  PageRequest,
} from "./common.js";

/** Customer-directory projection deliberately excludes credentials/sessions. */
export interface CustomerUserProfile {
  readonly id: EntityId;
  readonly companyId: EntityId;
  readonly displayName: string;
  readonly role: "CUSTOMER_ADMIN" | "CUSTOMER_USER";
  readonly status: AccountStatus;
}

export interface UserRepository {
  findCustomerById(
    scope: CompanyScope,
    userId: EntityId,
  ): Promise<CustomerUserProfile | null>;
  /** Ordered by id ascending; includes only customer users in scope. */
  listCustomers(
    scope: CompanyScope,
    page: PageRequest,
  ): Promise<Page<CustomerUserProfile>>;
}
