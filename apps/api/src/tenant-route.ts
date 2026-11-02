import type {
  PortalCompany,
  PortalCustomerUser,
  PortalProduct,
  PortalOrder,
  PortalPage,
} from "@b2b-portal/contracts";
import { Router, type Request } from "express";
import type { RepositoryPorts } from "./repositories/index.js";
import type { PageRequest } from "./repositories/common.js";
import type { SessionService } from "./services/sessions.js";
import {
  createTenantQueries,
  TenantQueryError,
  type TenantQueries,
} from "./services/tenant-queries.js";
import {
  AuthorizationError,
  type AuthorizedActor,
  type Permission,
} from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  actorFor,
  authorize,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess } from "./http.js";
function page(request: Request, paged: boolean): PageRequest {
  const query = request.query;
  if (
    Object.keys(query).some(
      (key) => !paged || !["offset", "limit"].includes(key),
    )
  )
    throw new TenantQueryError("invalid_input");
  const number = (value: unknown, fallback: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
      throw new TenantQueryError("invalid_input");
    return Number(value);
  };
  return { offset: number(query.offset, 0), limit: number(query.limit, 20) };
}
export function createTenantRouter(
  sessions?: SessionService,
  repositories?: RepositoryPorts,
) {
  const router = Router(),
    queries = repositories ? createTenantQueries(repositories) : undefined;
  function read(
    path: string,
    permission: Permission,
    paged: boolean,
    work: (
      q: TenantQueries,
      a: AuthorizedActor,
      r: Request,
      p: PageRequest,
    ) => Promise<unknown>,
  ) {
    router.get(
      path,
      authorize(permission, sessions),
      async (request, response, next) => {
        try {
          if (!queries) throw new TenantQueryError("unavailable");
          const result = await work(
            queries,
            actorFor(request),
            request,
            page(request, paged),
          );
          sendSuccess(response, result);
        } catch (e) {
          next(
            e instanceof AuthorizationError || e instanceof SessionError
              ? authorizationHttpError(e)
              : e instanceof TenantQueryError && e.code === "invalid_input"
                ? new HttpError(
                    400,
                    "INVALID_COMPANY_QUERY",
                    "Invalid company query.",
                  )
                : e instanceof TenantQueryError && e.code === "not_found"
                  ? new HttpError(
                      404,
                      "RESOURCE_NOT_FOUND",
                      "Resource not found.",
                    )
                  : new HttpError(
                      503,
                      "COMPANY_QUERY_UNAVAILABLE",
                      "Company data is temporarily unavailable.",
                    ),
          );
        }
      },
    );
  }
  const base = "/api/v1/companies/:companyId";
  read(
    base,
    "company.read",
    false,
    async (q, a, r): Promise<{ company: PortalCompany }> => ({
      company: await q.getCompany(a, r.params.companyId),
    }),
  );
  read(
    base + "/users",
    "customer-users.read",
    true,
    (q, a, r, p): Promise<PortalPage<PortalCustomerUser>> =>
      q.listUsers(a, r.params.companyId, p),
  );
  read(
    base + "/users/:userId",
    "customer-users.read",
    false,
    async (q, a, r): Promise<{ user: PortalCustomerUser }> => ({
      user: await q.getUser(a, r.params.companyId, r.params.userId),
    }),
  );
  read(
    base + "/catalog",
    "catalog.read",
    true,
    (q, a, r, p): Promise<PortalPage<PortalProduct>> =>
      q.listProducts(a, r.params.companyId, p),
  );
  read(
    base + "/catalog/:productId",
    "catalog.read",
    false,
    async (q, a, r): Promise<{ product: PortalProduct }> => ({
      product: await q.getProduct(a, r.params.companyId, r.params.productId),
    }),
  );
  read(
    base + "/orders",
    "orders.read",
    true,
    (q, a, r, p): Promise<PortalPage<PortalOrder>> =>
      q.listOrders(a, r.params.companyId, p),
  );
  read(
    base + "/orders/:orderId",
    "orders.read",
    false,
    async (q, a, r): Promise<{ order: PortalOrder }> => ({
      order: await q.getOrder(a, r.params.companyId, r.params.orderId),
    }),
  );
  return router;
}
