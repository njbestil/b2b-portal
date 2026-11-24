import type { RepositoryPorts } from "../repositories/index.js";
import type { Page, PageRequest } from "../repositories/common.js";
import type { CompanyProfileService } from "./company-profiles.js";
import { profileId } from "./company-profiles.js";
import { checkedSalesPage, SalesAssignmentError } from "./sales-assignments.js";
import {
  AuthorizationError,
  requirePermission,
  type AuthorizedActor,
  type Permission,
} from "./authorization.js";

/** Scope is built only after the existing provider revalidates Sales assignment. */
export function createSalesCustomerDetail(
  profiles: CompanyProfileService,
  repositories: RepositoryPorts,
) {
  async function read<T>(
    actor: AuthorizedActor,
    companyInput: unknown,
    permission: Permission,
    work: (companyId: string) => Promise<T>,
  ) {
    requirePermission(actor, permission);
    if (actor.role !== "SALES_STAFF") throw new AuthorizationError();
    const companyId = profileId(companyInput);
    const first = await profiles.internal(actor, companyId);
    if (first.company.id !== companyId || first.company.status !== "ACTIVE")
      throw new SalesAssignmentError("unavailable");
    const data = await work(companyId);
    const last = await profiles.internal(actor, companyId);
    if (last.company.id !== companyId || last.company.status !== "ACTIVE")
      throw new SalesAssignmentError("unavailable");
    return data;
  }
  function pageResult<T extends { id: string }, R>(
    result: Page<T>,
    page: PageRequest,
    valid: (row: T) => boolean,
    project: (row: T) => R,
  ) {
    if (
      !result ||
      !Array.isArray(result.items) ||
      !Number.isSafeInteger(result.total) ||
      result.total < 0 ||
      result.items.length > page.limit ||
      result.total < result.items.length ||
      result.items.some((row) => !row || typeof row.id !== "string") ||
      new Set(result.items.map((row) => row.id)).size !== result.items.length ||
      (result.items.length > 0 &&
        page.offset + result.items.length > result.total) ||
      result.items.some((row) => !valid(row))
    )
      throw new SalesAssignmentError("unavailable");
    return { items: result.items.map(project), total: result.total, ...page };
  }
  return {
    company: (actor: AuthorizedActor, company: unknown) =>
      read(actor, company, "company.read", async (id) => {
        const row = await repositories.companies.findById({ companyId: id });
        if (!row || row.id !== id || row.status !== "ACTIVE")
          throw new SalesAssignmentError("unavailable");
        return {
          company: {
            id: row.id,
            legalName: row.legalName,
            tradeName: row.tradeName,
            status: row.status,
            erpCustomerReference: row.erpCustomerReference,
          },
        };
      }),
    users: (actor: AuthorizedActor, company: unknown, input: PageRequest) => {
      const page = checkedSalesPage(input);
      return read(actor, company, "customer-users.read", async (id) =>
        pageResult(
          await repositories.users.listCustomers({ companyId: id }, page),
          page,
          (r) =>
            r.companyId === id &&
            ["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(r.role),
          (r) => ({
            id: r.id,
            companyId: r.companyId,
            displayName: r.displayName,
            role: r.role,
            status: r.status,
          }),
        ),
      );
    },
    catalog: (actor: AuthorizedActor, company: unknown, input: PageRequest) => {
      const page = checkedSalesPage(input);
      return read(actor, company, "catalog.read", async (id) =>
        pageResult(
          await repositories.catalog.listEligible({ companyId: id }, page),
          page,
          () => true,
          (r) => ({
            id: r.id,
            sku: r.sku,
            name: r.name,
            sellingUom: r.sellingUom,
            minimumOrderQuantity: r.minimumOrderQuantity,
            price: r.price
              ? { amount: r.price.amount, currency: r.price.currency }
              : null,
          }),
        ),
      );
    },
    orders: (actor: AuthorizedActor, company: unknown, input: PageRequest) => {
      const page = checkedSalesPage(input);
      return read(actor, company, "orders.read", async (id) =>
        pageResult(
          await repositories.orders.listHistory({ companyId: id }, page, {}),
          page,
          (r) => r.companyId === id && r.status !== "DRAFT",
          (r) => ({
            id: r.id,
            companyId: r.companyId,
            orderNumber: r.orderNumber,
            createdAt: r.createdAt,
            status: r.status,
            integrationStatus: r.integrationStatus,
          }),
        ),
      );
    },
  };
}
