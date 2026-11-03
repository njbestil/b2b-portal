import { Router } from "express";
import type { SalesCompanyPage } from "@b2b-portal/contracts";
import type { SalesAssignmentRepository } from "./repositories/sales-assignments.js";
import type { SessionService } from "./services/sessions.js";
import { createSalesCompanies } from "./services/sales-companies.js";
import { SalesAssignmentError } from "./services/sales-assignments.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess } from "./http.js";
export function createSalesCompaniesRouter(
  sessions?: SessionService,
  repository?: SalesAssignmentRepository,
) {
  const router = Router(),
    list = repository ? createSalesCompanies(repository) : undefined;
  router.get(
    "/api/v1/sales/companies",
    authorize("sales.companies.read", sessions),
    async (request, response, next) => {
      try {
        if (
          Object.keys(request.query).some(
            (key) => !["offset", "limit"].includes(key),
          )
        )
          throw new SalesAssignmentError("invalid_input");
        const number = (value: unknown, fallback: number) => {
          if (value === undefined) return fallback;
          if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
            throw new SalesAssignmentError("invalid_input");
          return Number(value);
        };
        if (!list) throw new SalesAssignmentError("unavailable");
        const result: SalesCompanyPage = await list(actorFor(request), {
          offset: number(request.query.offset, 0),
          limit: number(request.query.limit, 20),
        });
        sendSuccess(response, result);
      } catch (e) {
        next(
          e instanceof AuthorizationError || e instanceof SessionError
            ? authorizationHttpError(e)
            : e instanceof SalesAssignmentError && e.code === "invalid_input"
              ? new HttpError(
                  400,
                  "INVALID_SALES_COMPANY_QUERY",
                  "Invalid assigned-company query.",
                )
              : e instanceof SalesAssignmentError && e.code === "forbidden"
                ? new HttpError(403, "FORBIDDEN", "Not permitted.")
                : new HttpError(
                    503,
                    "SALES_COMPANIES_UNAVAILABLE",
                    "Assigned companies are temporarily unavailable.",
                  ),
        );
      }
    },
  );
  return router;
}
