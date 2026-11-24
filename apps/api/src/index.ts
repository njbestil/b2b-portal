import { createIntegrationMonitor } from "./services/integration-monitor.js";
import { createFulfillmentRefresh } from "./services/fulfillment.js";
import { createMockCancellationAdapter } from "./infrastructure/mock-cancellation-adapter.js";
import { createMockFulfillmentSource } from "./infrastructure/mock-fulfillment-adapter.js";
import { createAdminSalesAssignments } from "./services/admin-sales-assignments.js";
import { createSalesStaff } from "./services/sales-staff.js";
import { createInvoiceQueries } from "./services/invoices.js";
import { demoMode } from "./demo/accounts.js";
import {
  inspectDemoStore,
  protectDemoAuthentication,
  protectDemoTokens,
} from "./demo/accounts-runtime.js";
import { createDiagnostics } from "./services/diagnostics.js";
import { createAccountStatus } from "./services/account-status.js";
import { createCustomerUsers } from "./services/customer-users.js";
import { createPasswordReset } from "./services/password-reset.js";
import { resetProofs } from "./infrastructure/reset-crypto.js";
import { sessionProofs } from "./infrastructure/session-crypto.js";
import {
  EnvironmentConfigurationError,
  parseErpEnvironment,
  parsePostgresEnvironment,
  parseServerEnvironment,
  parseStorageEnvironment,
  parseSubmissionMinimum,
} from "@b2b-portal/config/server";
import { createApp } from "./app.js";
import { createCancellationStatus } from "./services/cancellation-status.js";
import { randomUUID } from "node:crypto";
import { createAudit } from "./services/audit.js";
import { createLogin, createVerifiedLogin } from "./services/login.js";
import { createApplications } from "./services/applications.js";
import {
  createOrderDrafts,
  createSalesDrafts,
} from "./services/order-drafts.js";
import { createMockCustomerCatalogSource } from "./infrastructure/mock-customer-catalog-adapter.js";
import { createMockSubmissionAdapter } from "./infrastructure/mock-submission-adapter.js";
import { parseSubmissionRetryPolicy } from "./infrastructure/submission-retry-config.js";
import { createCompanyProfiles } from "./services/company-profiles.js";
import { createDeliveryAddresses } from "./services/delivery-addresses.js";
import { createApplicationDecisions } from "./services/application-decisions.js";
import { createNotifications } from "./services/notifications.js";
import { parseSessionConfiguration } from "./infrastructure/session-config.js";
import { createAccessTokens } from "./infrastructure/access-tokens.js";
import { createSessions } from "./services/sessions.js";
import { SessionError } from "./services/session-state.js";
import { verifyPassword, hashPassword } from "./infrastructure/passwords.js";
import { createPasswordChange } from "./services/password-change.js";
import { createLogger } from "./logging.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  selectStorage,
  type StorageRuntime,
} from "./infrastructure/storage.js";
import { MockErpAdapter } from "./infrastructure/mock-erp-adapter.js";
import { createErpHealthProbe } from "./services/erp-health.js";
import { createShutdown, type ShutdownReason } from "./shutdown.js";

const logger = createLogger();
let storage: StorageRuntime | undefined;

try {
  const config = parseServerEnvironment("api", process.env);
  const postgresConfig = parsePostgresEnvironment(process.env);
  const erpConfig = parseErpEnvironment(process.env);
  const submissionMinimum = parseSubmissionMinimum(process.env);
  const submissionRetry = parseSubmissionRetryPolicy(process.env);
  const storageConfig = parseStorageEnvironment(process.env);
  const sessionConfig = parseSessionConfiguration(process.env);
  const demoTarget = demoMode(process.env);
  storage = await selectStorage({
    postgres: postgresConfig,
    jsonDirectory: resolve(
      fileURLToPath(new URL("../", import.meta.url)),
      storageConfig.jsonDataDir ?? "data/runtime",
    ),
    startupTimeoutMs: storageConfig.startupTimeoutMs,
    logger,
    requireSessions: sessionConfig !== undefined,
    requireSalesAssignments: sessionConfig !== undefined,
    requirePasswordResets: true,
  });
  const selectedStorage = storage;
  if (demoTarget) {
    await inspectDemoStore(
      demoTarget,
      postgresConfig,
      resolve(
        fileURLToPath(new URL("../", import.meta.url)),
        storageConfig.jsonDataDir ?? "data/runtime",
      ),
    );
  }
  const authentication = protectDemoAuthentication(
    selectedStorage.authentication,
    demoTarget !== undefined,
  );
  const audit = createAudit(selectedStorage.audit, randomUUID);
  const notifications = createNotifications(
    selectedStorage.notifications,
    randomUUID,
  );
  const record = (input: Parameters<typeof audit.record>[0]) =>
    audit.record(input);
  const sessions = sessionConfig
    ? createSessions(
        selectedStorage.sessions,
        createVerifiedLogin(authentication, verifyPassword, record),
        record,
        sessionConfig,
        protectDemoTokens(
          createAccessTokens(sessionConfig),
          selectedStorage.authentication,
          demoTarget !== undefined,
        ),
        sessionProofs,
      )
    : undefined;
  const erpHealth = erpConfig
    ? createErpHealthProbe(new MockErpAdapter(erpConfig))
    : undefined;
  const app = createApp({
    manualRetry:
      config.nodeEnv !== "production" && erpConfig
        ? selectedStorage.createManualRetry?.(
            createMockSubmissionAdapter(erpConfig),
          )
        : undefined,
    orderCancellation: selectedStorage.createOrderCancellation?.(
      config.nodeEnv !== "production" && erpConfig
        ? createMockCancellationAdapter(erpConfig)
        : undefined,
    ),
    integrationMonitor: createIntegrationMonitor(
      selectedStorage.integrationMonitor,
    ),
    fulfillment:
      config.nodeEnv !== "production" && erpConfig
        ? createFulfillmentRefresh(
            selectedStorage.fulfillment,
            createMockFulfillmentSource(erpConfig),
            record,
          )
        : undefined,
    diagnostics: createDiagnostics({
      storage: {
        provider: selectedStorage.provider,
        probe: selectedStorage.health,
      },
      database: {
        configured: selectedStorage.databaseConfigured,
        probe: selectedStorage.databaseHealth,
      },
      erp: { provider: erpConfig ? "mock" : null, probe: erpHealth },
    }),
    orderSubmission:
      config.nodeEnv !== "production" &&
      erpConfig &&
      submissionMinimum &&
      selectedStorage.createOrderSubmission
        ? selectedStorage.createOrderSubmission(
            createMockCustomerCatalogSource(erpConfig),
            submissionMinimum,
            createMockSubmissionAdapter(erpConfig),
            submissionRetry,
          )
        : undefined,
    adminCompanies: selectedStorage.adminCompanies,
    invoices: createInvoiceQueries(
      selectedStorage.invoices,
      selectedStorage.repositories.companies,
    ),
    orderDrafts: createOrderDrafts(
      selectedStorage.orderDrafts,
      record,
      config.nodeEnv !== "production" && erpConfig && submissionMinimum
        ? {
            minimum: submissionMinimum,
            source: createMockCustomerCatalogSource(erpConfig),
          }
        : undefined,
    ),
    salesDrafts: createSalesDrafts(selectedStorage.orderDrafts, record),
    companyProfiles: createCompanyProfiles(selectedStorage.companyProfiles),
    deliveryAddresses: createDeliveryAddresses(
      selectedStorage.deliveryAddresses,
    ),
    accountStatus: createAccountStatus(selectedStorage.accountStatus, record),
    adminSalesAssignments: createAdminSalesAssignments(
      selectedStorage.adminSalesAssignments,
      record,
      randomUUID,
    ),
    salesStaff: createSalesStaff(
      selectedStorage.salesStaff,
      hashPassword,
      record,
      randomUUID,
    ),
    customerUsers: createCustomerUsers(
      selectedStorage.customerUsers,
      hashPassword,
      record,
      randomUUID,
    ),
    passwordReset: createPasswordReset(
      selectedStorage.passwordResets,
      hashPassword,
      verifyPassword,
      record,
      resetProofs,
    ),
    companyRepositories: selectedStorage.repositories,
    cancellationStatus: selectedStorage.cancellationStatus
      ? createCancellationStatus(
          selectedStorage.cancellationStatus,
          selectedStorage.companyProfiles,
        )
      : undefined,
    salesAssignments: selectedStorage.salesAssignments,
    pendingApplication: selectedStorage.applications.pending,
    applicationReview: createApplicationDecisions(
      selectedStorage.applicationReviews,
      record,
      (input) => notifications.create(input),
    ),
    passwordChange: sessions
      ? createPasswordChange(
          selectedStorage.passwordChanges,
          sessions.authenticateAccess,
          verifyPassword,
          hashPassword,
          record,
        )
      : undefined,
    applications: createApplications(
      selectedStorage.applications,
      hashPassword,
      (event) => audit.record(event),
      randomUUID,
    ),
    sessions,
    sessionLogin:
      sessions?.login ??
      (async () => {
        throw new SessionError("unavailable");
      }),
    login: createLogin(authentication, verifyPassword, (input) =>
      audit.record(input),
    ),
    logger,
    storageProvider: selectedStorage.provider,
    healthChecks: {
      storage: selectedStorage.health,
      erp: erpHealth,
    },
  });
  const server = app.listen(config.port, config.host);
  const shutdown = createShutdown(
    server,
    () => selectedStorage.close(),
    logger,
  );
  const stop = (reason: ShutdownReason) => {
    void shutdown(reason).then((clean) => {
      if (!clean) process.exitCode = 1;
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    });
  };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  server.once("listening", () => {
    logger("info", {
      event: "api.started",
      api: "up",
      storageProvider: selectedStorage.provider,
    });
  });
  server.on("error", () => {
    logger("error", { event: "api.start_failed", reason: "listen_failed" });
    process.exitCode = 1;
    stop("listen_failed");
  });
} catch (error) {
  await storage?.close().catch(() => {});
  logger("error", {
    event: "api.start_failed",
    reason:
      error instanceof EnvironmentConfigurationError
        ? "invalid_environment"
        : "storage_initialization_failed",
    // This validator only includes setting names/rules, never their values.
    ...(error instanceof EnvironmentConfigurationError
      ? { diagnostic: error.message }
      : {}),
  });
  process.exitCode = 1;
}
