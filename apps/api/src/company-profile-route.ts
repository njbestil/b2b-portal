import { Router, json, type RequestHandler } from "express";
import type { SessionService } from "./services/sessions.js";
import {
  CompanyProfileError,
  type CompanyProfileService,
} from "./services/company-profiles.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess } from "./http.js";
export function createCompanyProfileRouter(
  sessions?: SessionService,
  service?: CompanyProfileService,
) {
  const router = Router();
  const error = (e: unknown) =>
    e instanceof HttpError
      ? e
      : e instanceof AuthorizationError || e instanceof SessionError
        ? authorizationHttpError(e)
        : e instanceof CompanyProfileError && e.code === "invalid_input"
          ? new HttpError(
              400,
              "INVALID_COMPANY_PROFILE_REQUEST",
              "Invalid company profile request.",
            )
          : e instanceof CompanyProfileError && e.code === "forbidden"
            ? new HttpError(403, "FORBIDDEN", "Not permitted.")
            : e instanceof CompanyProfileError && e.code === "not_found"
              ? new HttpError(
                  404,
                  "COMPANY_PROFILE_NOT_FOUND",
                  "Company profile not found.",
                )
              : e instanceof CompanyProfileError && e.code === "conflict"
                ? new HttpError(
                    409,
                    "COMPANY_PROFILE_CONFLICT",
                    "Company profile changed. Reload before saving.",
                  )
                : new HttpError(
                    503,
                    "COMPANY_PROFILE_UNAVAILABLE",
                    "Company profile operation could not be confirmed. Reload the latest profile.",
                  );
  for (const internal of [false, true])
    router.get(
      internal
        ? "/api/v1/companies/:companyId/profile"
        : "/api/v1/company-profile",
      authorize("company-profile.read", sessions),
      async (request, response, next) => {
        try {
          if (Object.keys(request.query).length)
            throw new CompanyProfileError("invalid_input");
          if (!service) throw new CompanyProfileError("unavailable");
          sendSuccess(
            response,
            internal
              ? await service.internal(
                  actorFor(request),
                  request.params.companyId,
                )
              : await service.own(actorFor(request)),
          );
        } catch (e) {
          next(error(e));
        }
      },
    );
  let inFlight = 0;
  const attempts = new Map<string, { count: number; until: number }>();
  const guard: RequestHandler = (request, response, next) => {
    const time = Date.now(),
      key = actorFor(request).userId;
    for (const [id, value] of attempts)
      if (value.until <= time) attempts.delete(id);
    const row = attempts.get(key);
    if ((row?.count ?? 0) >= 30) {
      next(new HttpError(429, "RATE_LIMITED", "Too many profile changes."));
      return;
    }
    attempts.set(key, {
      count: (row?.count ?? 0) + 1,
      until: row?.until ?? time + 60000,
    });
    if (!request.is("application/json")) {
      next(
        new HttpError(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "A JSON request body is required.",
        ),
      );
      return;
    }
    if (inFlight >= 4) {
      next(error(new CompanyProfileError("unavailable")));
      return;
    }
    inFlight++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        inFlight--;
      }
    };
    response.once("finish", release);
    response.once("close", release);
    next();
  };
  router.patch(
    "/api/v1/company-profile",
    authorize("company-profile.manage", sessions),
    guard,
    json({ limit: "8kb", inflate: false }),
    async (request, response, next) => {
      try {
        if (Object.keys(request.query).length)
          throw new CompanyProfileError("invalid_input");
        if (!service) throw new CompanyProfileError("unavailable");
        sendSuccess(
          response,
          await service.save(actorFor(request), request.body),
        );
      } catch (e) {
        next(error(e));
      }
    },
  );
  return router;
}
