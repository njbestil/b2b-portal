import {
  EnvironmentConfigurationError,
  parseServerEnvironment,
} from "@b2b-portal/config/server";
import express from "express";

try {
  const config = parseServerEnvironment("api", process.env);
  const app = express();

  app.get("/", (_request, response) => {
    response.json({ service: "b2b-portal-api" });
  });

  app.listen(config.port, config.host);
} catch (error) {
  if (!(error instanceof EnvironmentConfigurationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
