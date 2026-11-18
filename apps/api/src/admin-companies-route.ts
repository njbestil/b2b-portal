import { Router } from "express";
import type { PortalPage, PortalCompany } from "@b2b-portal/contracts";
import type { AdminCompanyRepository } from "./repositories/admin-companies.js";
import type { SessionService } from "./services/sessions.js";
import { createAdminCompanies } from "./services/admin-companies.js";
import { AccountStatusError } from "./services/account-status.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess } from "./http.js";
export function createAdminCompaniesRouter(
  sessions?: SessionService,
  repository?: AdminCompanyRepository,
) {
  const router = Router(),
    list = repository ? createAdminCompanies(repository) : undefined;
  router.get(
    "/api/v1/admin/companies",
    authorize("accounts.status.read", sessions),
    async (request, response, next) => {
      try {
        if (
          Object.keys(request.query).some(
            (key) => !["offset", "limit"].includes(key),
          )
        )
          throw new AccountStatusError("invalid_input");
        const number = (value: unknown, fallback: number) => {
          if (value === undefined) return fallback;
          if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
            throw new AccountStatusError("invalid_input");
          return Number(value);
        };
        if (!list) throw new AccountStatusError("unavailable");
        const result: PortalPage<PortalCompany> = await list(
          actorFor(request),
          {
            offset: number(request.query.offset, 0),
            limit: number(request.query.limit, 20),
          },
        );
        sendSuccess(response, result);
      } catch (e) {
        next(
          e instanceof AuthorizationError || e instanceof SessionError
            ? authorizationHttpError(e)
            : e instanceof AccountStatusError && e.code === "invalid_input"
              ? new HttpError(
                  400,
                  "INVALID_ADMIN_COMPANY_QUERY",
                  "Invalid customer-company query.",
                )
              : e instanceof AccountStatusError && e.code === "forbidden"
                ? new HttpError(403, "FORBIDDEN", "Not permitted.")
                : new HttpError(
                    503,
                    "ADMIN_COMPANIES_UNAVAILABLE",
                    "Customer companies are temporarily unavailable.",
                  ),
        );
      }
    },
  );
  return router;
}
