import { Router } from "express";
import type { PortalInvoice, PortalInvoicePage } from "@b2b-portal/contracts";
import type { SessionService } from "./services/sessions.js";
import { InvoiceError, type InvoiceQueries } from "./services/invoices.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  actorFor,
  authorize,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess } from "./http.js";
export function createInvoiceRouter(
  sessions?: SessionService,
  queries?: InvoiceQueries,
) {
  const router = Router();
  for (const detail of [false, true])
    router.get(
      detail ? "/api/v1/invoices/:id" : "/api/v1/invoices",
      authorize("invoices.read", sessions),
      async (request, response, next) => {
        try {
          if (!queries) throw new InvoiceError();
          if (
            Object.keys(request.query).some(
              (k) => detail || !["offset", "limit"].includes(k),
            )
          )
            throw new InvoiceError("invalid_input");
          const number = (v: unknown, fallback: number) => {
            if (v === undefined) return fallback;
            if (
              typeof v !== "string" ||
              v.trim() !== v ||
              !/^(0|[1-9]\d*)$/.test(v)
            )
              throw new InvoiceError("invalid_input");
            return Number(v);
          };
          const result: PortalInvoice | PortalInvoicePage = detail
            ? await queries.find(actorFor(request), request.params.id)
            : await queries.list(actorFor(request), {
                offset: number(request.query.offset, 0),
                limit: number(request.query.limit, 20),
              });
          sendSuccess(response, result);
        } catch (e) {
          next(
            e instanceof AuthorizationError || e instanceof SessionError
              ? authorizationHttpError(e)
              : e instanceof InvoiceError && e.code === "invalid_input"
                ? new HttpError(
                    400,
                    "INVALID_INVOICE_QUERY",
                    "Invalid invoice query.",
                  )
                : e instanceof InvoiceError && e.code === "not_found"
                  ? new HttpError(
                      404,
                      "INVOICE_NOT_FOUND",
                      "Invoice not found.",
                    )
                  : new HttpError(
                      503,
                      "INVOICES_UNAVAILABLE",
                      "Invoices are temporarily unavailable.",
                    ),
          );
        }
      },
    );
  return router;
}
