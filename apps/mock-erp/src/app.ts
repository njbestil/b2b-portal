import express from "express";
import { createMasterData } from "./master-data.js";
import { requireJson, orderErrorHandler } from "./order-http.js";
import { createOrderService } from "./orders.js";

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
    (request, response) => {
      const result = orders.create(
        request.get("Idempotency-Key"),
        request.body,
      );
      response.status(result.created ? 201 : 200).json(result.order);
    },
  );
  app.use(orderErrorHandler);

  return app;
}
