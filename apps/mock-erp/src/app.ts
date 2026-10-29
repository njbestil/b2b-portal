import express from "express";
import { createMasterData } from "./master-data.js";

export function createApp() {
  const app = express();

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

  return app;
}
