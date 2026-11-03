import { Router, json, type RequestHandler } from "express";
import type { SessionService } from "./services/sessions.js";
import {
  AddressError,
  type DeliveryAddressService,
} from "./services/delivery-addresses.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess } from "./http.js";
export function createDeliveryAddressRouter(
  sessions?: SessionService,
  service?: DeliveryAddressService,
) {
  const router = Router();
  const error = (e: unknown) =>
    e instanceof HttpError
      ? e
      : e instanceof AuthorizationError || e instanceof SessionError
        ? authorizationHttpError(e)
        : e instanceof AddressError && e.code === "invalid_input"
          ? new HttpError(
              400,
              "INVALID_ADDRESS_REQUEST",
              "Invalid address request.",
            )
          : e instanceof AddressError && e.code === "forbidden"
            ? new HttpError(403, "FORBIDDEN", "Not permitted.")
            : e instanceof AddressError && e.code === "not_found"
              ? new HttpError(404, "ADDRESS_NOT_FOUND", "Address not found.")
              : e instanceof AddressError && e.code === "conflict"
                ? new HttpError(
                    409,
                    "ADDRESS_CONFLICT",
                    "Address collection changed or action conflicts. Reload before another action.",
                  )
                : new HttpError(
                    503,
                    "ADDRESS_UNAVAILABLE",
                    "Address operation could not be confirmed. Reload the latest collection.",
                  );
  for (const internal of [false, true])
    router.get(
      internal
        ? "/api/v1/companies/:companyId/delivery-addresses"
        : "/api/v1/delivery-addresses",
      authorize("delivery-addresses.read", sessions),
      async (request, response, next) => {
        try {
          if (Object.keys(request.query).length)
            throw new AddressError("invalid_input");
          if (!service) throw new AddressError("unavailable");
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
      next(new HttpError(429, "RATE_LIMITED", "Too many address changes."));
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
      next(error(new AddressError("unavailable")));
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
    "/api/v1/delivery-addresses",
    authorize("delivery-addresses.manage", sessions),
    guard,
    json({ limit: "8kb", inflate: false }),
    async (request, response, next) => {
      try {
        if (Object.keys(request.query).length)
          throw new AddressError("invalid_input");
        if (!service) throw new AddressError("unavailable");
        sendSuccess(
          response,
          await service.change(actorFor(request), request.body),
        );
      } catch (e) {
        next(error(e));
      }
    },
  );
  return router;
}
