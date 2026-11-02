import {
  resolveInvoiceDocument,
  documentReferenceErrorHandler,
} from "./invoice-documents.js";
import express from "express";
import { createMasterData } from "./master-data.js";
import { requireJson, orderErrorHandler } from "./order-http.js";
import { createOrderService, OrderError } from "./orders.js";
import { parseScenario, runScenario } from "./scenarios.js";
import {
  parseFulfillmentScenario,
  parseFulfillmentReadScenario,
} from "./fulfillment.js";
import {
  createCancellationService,
  parseCancellationScenario,
} from "./cancellations.js";

export function createApp() {
  const app = express();
  const orders = createOrderService();
  const cancellations = createCancellationService(orders.findById);

  app.get("/", (_request, response) => {
    response.json({ service: "b2b-portal-mock-erp" });
  });

  app.get("/mock-erp/v1/health", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ status: "up" });
  });

  app.get("/mock-erp/v1/master-data", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(createMasterData());
  });

  app.post(
    "/mock-erp/v1/orders",
    requireJson,
    express.json({ limit: "32kb", inflate: false }),
    async (request, response) => {
      const scenario = parseScenario(request.get("X-Mock-ERP-Scenario"));
      const fulfillment = parseFulfillmentScenario(
        request.get("X-Mock-ERP-Fulfillment-Scenario"),
      );
      const key = request.get("Idempotency-Key");
      const replay = orders.replay(key, request.body);
      if (replay) {
        response.status(200).json(replay);
        return;
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      request.once("aborted", cancel);
      response.once("close", cancel);
      try {
        await runScenario(scenario, controller.signal);
        if (controller.signal.aborted) return;
        const result = orders.create(
          key,
          request.body,
          scenario === "completed",
          fulfillment,
        );
        response.status(result.created ? 201 : 200).json(result.order);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        request.off("aborted", cancel);
        response.off("close", cancel);
      }
    },
  );
  app.get("/mock-erp/v1/orders/:erpOrderId/invoice", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ invoice: orders.invoice(request.params.erpOrderId) });
  });
  app.post(
    "/mock-erp/v1/orders/:erpOrderId/cancellations",
    requireJson,
    express.json({ limit: "4kb", inflate: false }),
    async (request, response) => {
      const scenario = parseCancellationScenario(
        request.get("X-Mock-ERP-Cancellation-Scenario"),
      );
      const key = request.get("Idempotency-Key"),
        id = request.params.erpOrderId;
      if (typeof id !== "string")
        throw new OrderError(400, "INVALID_ORDER_ID", "Invalid ERP order ID.");
      const replay = cancellations.replay(key, id, request.body);
      if (replay) {
        response.status(200).json(replay);
        return;
      }
      const controller = new AbortController(),
        cancel = () => controller.abort();
      request.once("aborted", cancel);
      response.once("close", cancel);
      try {
        await runScenario(
          scenario === "approved" || scenario === "rejected"
            ? "success"
            : scenario,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const result = cancellations.create(
          key,
          id,
          request.body,
          scenario === "rejected" ? "rejected" : "approved",
        );
        response.status(result.created ? 201 : 200).json(result.cancellation);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        request.off("aborted", cancel);
        response.off("close", cancel);
      }
    },
  );
  app.get(
    "/mock-erp/v1/orders/:erpOrderId/fulfillment",
    async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      const scenario = parseFulfillmentReadScenario(
        request.get("X-Mock-ERP-Scenario"),
      );
      const state = orders.fulfillment(request.params.erpOrderId);
      const controller = new AbortController(),
        cancel = () => controller.abort();
      request.once("aborted", cancel);
      response.once("close", cancel);
      try {
        await runScenario(scenario, controller.signal);
        if (!controller.signal.aborted) response.json(state);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        request.off("aborted", cancel);
        response.off("close", cancel);
      }
    },
  );
  app.get(
    "/mock-erp/v1/invoice-documents/:documentReference",
    (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      const document = resolveInvoiceDocument(
        request.params.documentReference,
        orders.invoice,
      );
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${document.filename}"`,
      );
      response.setHeader("Content-Length", String(document.bytes.byteLength));
      response.end(document.bytes);
    },
  );
  app.use("/mock-erp/v1/invoice-documents", documentReferenceErrorHandler);
  app.use(orderErrorHandler);

  return app;
}
