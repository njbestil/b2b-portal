import { Router, json, type RequestHandler } from "express";
import {
  ReviewError,
  type ApplicationDecisionService,
} from "./services/application-decisions.js";
import type { SessionService } from "./services/sessions.js";
import type { ApplicationRepository } from "./repositories/applications.js";
import { createApplicationReview } from "./services/application-review.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { AuthorizationError } from "./services/authorization.js";
import { sessionId, SessionError } from "./services/session-state.js";
import { HttpError, requestIdFor, sendSuccess } from "./http.js";
export function createApplicationReviewRouter(
  sessions?: SessionService,
  pending?: ApplicationRepository["pending"],
  service?: ApplicationDecisionService,
) {
  const router = Router();
  const error = (e: unknown) =>
    e instanceof HttpError
      ? e
      : e instanceof AuthorizationError || e instanceof SessionError
        ? authorizationHttpError(e)
        : e instanceof ReviewError && e.code === "invalid_input"
          ? new HttpError(
              400,
              "INVALID_APPLICATION_REQUEST",
              "Invalid application request.",
            )
          : e instanceof ReviewError && e.code === "forbidden"
            ? new HttpError(403, "FORBIDDEN", "Not permitted.")
            : e instanceof ReviewError && e.code === "not_found"
              ? new HttpError(
                  404,
                  "APPLICATION_NOT_FOUND",
                  "Application not found.",
                )
              : e instanceof ReviewError && e.code === "conflict"
                ? new HttpError(
                    409,
                    "APPLICATION_CONFLICT",
                    "Application changed. Reload before another decision.",
                  )
                : new HttpError(
                    503,
                    "APPLICATION_REVIEW_UNAVAILABLE",
                    "Application review could not be confirmed. Reload the latest details.",
                  );
  router.get(
    "/api/v1/admin/applications",
    authorize("applications.read", sessions),
    async (request, response, next) => {
      try {
        if (
          Object.keys(request.query).some(
            (k) => !["offset", "limit"].includes(k),
          )
        )
          throw new ReviewError("invalid_input");
        const number = (value: unknown, fallback: number) =>
          value === undefined
            ? fallback
            : typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)
              ? Number(value)
              : NaN;
        if (!service) throw new ReviewError("unavailable");
        sendSuccess(
          response,
          await service.list(
            actorFor(request),
            number(request.query.offset, 0),
            number(request.query.limit, 20),
          ),
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
      next(
        new HttpError(429, "RATE_LIMITED", "Too many application decisions."),
      );
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
      next(error(new ReviewError("unavailable")));
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
  router.post(
    "/api/v1/admin/applications/:companyId/decision",
    authorize("applications.read", sessions),
    guard,
    json({ limit: "8kb", inflate: false }),
    async (request, response, next) => {
      try {
        if (Object.keys(request.query).length)
          throw new ReviewError("invalid_input");
        if (!service) throw new ReviewError("unavailable");
        sendSuccess(
          response,
          await service.decide(
            actorFor(request),
            request.params.companyId,
            request.body,
            requestIdFor(response),
          ),
        );
      } catch (e) {
        next(error(e));
      }
    },
  );
  router.get(
    "/api/v1/admin/applications/:companyId",
    authorize("applications.read", sessions),
    async (request, response, next) => {
      try {
        const id = request.params.companyId;
        if (!sessionId(id) || Object.keys(request.query).length)
          throw new HttpError(
            400,
            "INVALID_APPLICATION_QUERY",
            "Invalid application query.",
          );
        if (service) {
          sendSuccess(response, await service.detail(actorFor(request), id));
          return;
        }
        if (!pending)
          throw new HttpError(
            503,
            "APPLICATION_REVIEW_UNAVAILABLE",
            "Application review is temporarily unavailable.",
          );
        const application = await createApplicationReview({ pending })(
          actorFor(request),
          id,
        );
        if (!application)
          throw new HttpError(
            404,
            "APPLICATION_NOT_FOUND",
            "Application not found.",
          );
        sendSuccess(response, { application });
      } catch (e) {
        next(error(e));
      }
    },
  );
  return router;
}
