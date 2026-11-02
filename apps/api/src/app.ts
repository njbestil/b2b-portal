import { createPasswordResetRouter } from "./password-reset-route.js";
import type { PasswordResetService } from "./services/password-reset.js";
import { createApplicationReviewRouter } from "./application-review-route.js";
import type { ApplicationRepository } from "./repositories/applications.js";
import express from "express";
import { createTenantRouter } from "./tenant-route.js";
import type { RepositoryPorts } from "./repositories/index.js";
import { createAccountStatusRouter } from "./account-status-route.js";
import type { AccountStatusService } from "./services/account-status.js";
import { createLoginRouter, type LoginHandler } from "./login-route.js";
import { createSessionRouter } from "./session-route.js";
import { createPasswordChangeRouter } from "./password-change-route.js";
import type { PasswordChangeHandler } from "./services/password-change.js";
import { createLogoutRouter } from "./logout-route.js";
import type { SessionService } from "./services/sessions.js";
import type { HealthResponse, StorageProvider } from "@b2b-portal/contracts";
import { createHealthReporter, type HealthChecks } from "./health.js";
import { createLogger, type Logger, requestLogging } from "./logging.js";
import {
  errorHandler,
  notFoundHandler,
  requestIdFor,
  requestIdMiddleware,
  sendSuccess,
} from "./http.js";

import {
  createApplicationRouter,
  type ApplicationHandler,
} from "./application-route.js";

interface AppOptions {
  accountStatus?: AccountStatusService;
  passwordReset?: PasswordResetService;
  companyRepositories?: RepositoryPorts;
  pendingApplication?: ApplicationRepository["pending"];
  passwordChange?: PasswordChangeHandler;
  applications?: ApplicationHandler;
  sessions?: SessionService;
  sessionLogin?: SessionService["login"];
  login?: LoginHandler;
  logger?: Logger;
  healthChecks?: HealthChecks;
  healthTimeoutMs?: number;
  storageProvider?: StorageProvider;
}

export function createApp(options: AppOptions = {}) {
  const logger = options.logger ?? createLogger();
  const reportHealth = createHealthReporter(
    options.healthChecks,
    options.healthTimeoutMs,
    options.storageProvider,
  );
  const app = express();
  app.use(requestIdMiddleware);
  app.use(requestLogging(logger));
  if (options.login)
    app.use(createLoginRouter(options.login, Date.now, options.sessionLogin));
  if (options.applications)
    app.use(createApplicationRouter(options.applications));
  app.use(createSessionRouter(options.sessions));
  app.use(createPasswordChangeRouter(options.passwordChange));
  app.use(createLogoutRouter(options.sessions));
  app.use(createPasswordResetRouter(options.passwordReset));
  app.use(
    createApplicationReviewRouter(options.sessions, options.pendingApplication),
  );
  app.use(createAccountStatusRouter(options.sessions, options.accountStatus));
  app.use(express.json());
  app.use(createTenantRouter(options.sessions, options.companyRepositories));

  app.get("/", (_request, response) => {
    sendSuccess(response, { service: "b2b-portal-api" });
  });

  app.get("/health", async (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const health = await reportHealth();
    const requestId = requestIdFor(response);
    logger(health.status === "up" ? "info" : "warn", {
      event: "health.checked",
      requestId,
      health,
    });
    if (health.status === "up") {
      sendSuccess(response, health);
      return;
    }
    const body: HealthResponse = {
      success: false,
      error: {
        code: "SERVICE_NOT_READY",
        message: "Required dependencies are not ready.",
        details: health,
      },
      requestId,
    };
    response.status(503).json(body);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
