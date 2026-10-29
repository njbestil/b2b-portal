import {
  EnvironmentConfigurationError,
  parseServerEnvironment,
} from "@b2b-portal/config/server";
import { createApp } from "./app.js";

try {
  const config = parseServerEnvironment("mock-erp", process.env);
  const app = createApp();
  app.listen(config.port, config.host);
} catch (error) {
  if (!(error instanceof EnvironmentConfigurationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
