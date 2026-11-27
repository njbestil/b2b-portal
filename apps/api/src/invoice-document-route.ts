import { Router } from "express";
import type { SessionService } from "./services/sessions.js";
import type { InvoiceDocuments } from "./services/invoice-documents.js";
import { InvoiceError } from "./services/invoices.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  actorFor,
  authorize,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError } from "./http.js";
export function createInvoiceDocumentRouter(
  sessions?: SessionService,
  documents?: InvoiceDocuments,
) {
  const router = Router();
  let active = 0;
  router.get(
    "/api/v1/invoices/:id/document",
    authorize("invoices.read", sessions),
    async (request, response, next) => {
      const controller = new AbortController(),
        abort = () => controller.abort();
      let admitted = false;
      response.once("close", abort);
      try {
        if (Object.keys(request.query).length)
          throw new InvoiceError("invalid_input");
        if (!documents || active >= 4) throw new InvoiceError();
        active++;
        admitted = true;
        const result = await documents.read(
          actorFor(request),
          request.params.id,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        response
          .set({
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="${result.filename}"`,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          })
          .send(result.bytes);
      } catch (error) {
        next(
          error instanceof SessionError || error instanceof AuthorizationError
            ? authorizationHttpError(error)
            : new HttpError(
                error instanceof InvoiceError && error.code === "not_found"
                  ? 404
                  : error instanceof InvoiceError &&
                      error.code === "invalid_input"
                    ? 400
                    : 503,
                "INVOICE_DOCUMENT_UNAVAILABLE",
                "Invoice document is unavailable.",
              ),
        );
      } finally {
        if (admitted) active--;
        response.off("close", abort);
      }
    },
  );
  return router;
}
