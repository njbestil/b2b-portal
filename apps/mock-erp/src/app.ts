import express from "express";
import { createMasterData } from "./master-data.js";
import { requireJson, orderErrorHandler } from "./order-http.js";
import { createOrderService } from "./orders.js";
import { parseScenario, runScenario } from "./scenarios.js";

export function createApp() {
  const app = express();
  const orders = createOrderService();

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
        const result = orders.create(key, request.body);
        response.status(result.created ? 201 : 200).json(result.order);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        request.off("aborted", cancel);
        response.off("close", cancel);
      }
    },
  );
  app.use(orderErrorHandler);

  return app;
}
