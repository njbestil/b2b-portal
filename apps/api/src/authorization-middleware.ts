import type { Request, RequestHandler } from "express";
import type { SessionService } from "./services/sessions.js";
import {
  createAuthorization,
  AuthorizationError,
  type AuthorizedActor,
  type Permission,
} from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import { accessBearer, sessionHttpError } from "./authentication-http.js";
import { HttpError } from "./http.js";
const actors = new WeakMap<Request, AuthorizedActor>();
export function actorFor(request: Request): AuthorizedActor {
  const actor = actors.get(request);
  if (!actor) throw new SessionError("invalid_proof");
  return actor;
}
export function authorizationHttpError(error: unknown): HttpError {
  return error instanceof AuthorizationError
    ? new HttpError(403, "FORBIDDEN", "Not permitted.")
    : sessionHttpError(error);
}
export function authorize(
  permission: Permission,
  sessions?: SessionService,
): RequestHandler {
  const authorization = createAuthorization(async (token) => {
    if (!sessions) throw new SessionError("unavailable");
    return sessions.authenticateAccess(token);
  });
  return async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      if (!sessions) throw new SessionError("unavailable");
      actors.set(
        request,
        await authorization.admit(accessBearer(request.rawHeaders), permission),
      );
      next();
    } catch (e) {
      next(authorizationHttpError(e));
    }
  };
}
