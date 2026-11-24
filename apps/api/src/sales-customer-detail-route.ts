import { Router, type Request } from "express";
import type { SessionService } from "./services/sessions.js";
import type { RepositoryPorts } from "./repositories/index.js";
import type { CompanyProfileService } from "./services/company-profiles.js";
import { CompanyProfileError } from "./services/company-profiles.js";
import { createSalesCustomerDetail } from "./services/sales-customer-detail.js";
import { SalesAssignmentError } from "./services/sales-assignments.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess } from "./http.js";

function page(request: Request, paged: boolean) {
  if (
    Object.keys(request.query).some(
      (key) => !paged || !["offset", "limit"].includes(key),
    )
  )
    throw new SalesAssignmentError("invalid_input");
  const number = (value: unknown, fallback: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
      throw new SalesAssignmentError("invalid_input");
    return Number(value);
  };
  return {
    offset: number(request.query.offset, 0),
    limit: number(request.query.limit, 20),
  };
}
export function createSalesCustomerDetailRouter(
  sessions?: SessionService,
  profiles?: CompanyProfileService,
  repositories?: RepositoryPorts,
) {
  const router = Router();
  const service =
    profiles && repositories
      ? createSalesCustomerDetail(profiles, repositories)
      : undefined;
  for (const section of ["company", "users", "catalog", "orders"] as const) {
    router.get(
      `/api/v1/sales/companies/:companyId${section === "company" ? "" : `/${section}`}`,
      authorize("sales.companies.read", sessions),
      async (request, response, next) => {
        try {
          const pagination = page(request, section !== "company");
          if (!service) throw new SalesAssignmentError("unavailable");
          const actor = actorFor(request),
            id = request.params.companyId;
          const result =
            section === "company"
              ? await service.company(actor, id)
              : await service[section](actor, id, pagination);
          sendSuccess(response, result);
        } catch (e) {
          next(
            e instanceof AuthorizationError || e instanceof SessionError
              ? authorizationHttpError(e)
              : e instanceof CompanyProfileError && e.code === "forbidden"
                ? new HttpError(403, "FORBIDDEN", "Not permitted.")
                : e instanceof CompanyProfileError && e.code === "not_found"
                  ? new HttpError(
                      404,
                      "RESOURCE_NOT_FOUND",
                      "Resource not found.",
                    )
                  : (e instanceof CompanyProfileError ||
                        e instanceof SalesAssignmentError) &&
                      e.code === "invalid_input"
                    ? new HttpError(
                        400,
                        "INVALID_SALES_CUSTOMER_QUERY",
                        "Invalid customer query.",
                      )
                    : new HttpError(
                        503,
                        "SALES_CUSTOMER_UNAVAILABLE",
                        "Customer data is temporarily unavailable.",
                      ),
          );
        }
      },
    );
  }
  return router;
}
