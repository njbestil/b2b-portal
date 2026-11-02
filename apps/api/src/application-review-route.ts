import { Router } from "express";
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
import { HttpError, sendSuccess } from "./http.js";
export function createApplicationReviewRouter(
  sessions?: SessionService,
  pending?: ApplicationRepository["pending"],
) {
  const router = Router();
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
        next(
          e instanceof HttpError
            ? e
            : e instanceof AuthorizationError || e instanceof SessionError
              ? authorizationHttpError(e)
              : new HttpError(
                  503,
                  "APPLICATION_REVIEW_UNAVAILABLE",
                  "Application review is temporarily unavailable.",
                ),
        );
      }
    },
  );
  return router;
}
