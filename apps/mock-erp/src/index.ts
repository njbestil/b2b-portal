import {
  EnvironmentConfigurationError,
  parseServerEnvironment,
} from "@b2b-portal/config/server";
import express from "express";

try {
  const config = parseServerEnvironment("mock-erp", process.env);
  const app = express();

  app.get("/", (_request, response) => {
    response.json({ service: "b2b-portal-mock-erp" });
  });

  app.get("/mock-erp/v1/health", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ status: "up" });
  });

  app.listen(config.port, config.host);
} catch (error) {
  if (!(error instanceof EnvironmentConfigurationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
