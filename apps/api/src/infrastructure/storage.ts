import type { AccountStatusRepository } from "../repositories/account-status.js";
import type { CustomerUserRepository } from "../repositories/customer-users.js";
import { createPostgresCustomerUsers } from "./postgres-customer-users.js";
import { createJsonCustomerUsers } from "./json/customer-users.js";
import { createJsonAccountStatus } from "./json/account-status.js";
import { createPostgresAccountStatus } from "./postgres-account-status.js";
import type { SalesAssignmentRepository } from "../repositories/sales-assignments.js";
import { createJsonSalesAssignments } from "./json/sales-assignments.js";
import { createPostgresSalesAssignments } from "./postgres-sales-assignments.js";
import type { PasswordResetRepository } from "../repositories/password-reset.js";
import { createJsonPasswordReset } from "./json/password-reset.js";
import { createPostgresPasswordReset } from "./postgres-password-reset.js";
import type { StorageProvider } from "@b2b-portal/contracts";
import type { PostgresEnvironment } from "@b2b-portal/config/server";
import type { HealthProbe } from "../health.js";
import type { Logger } from "../logging.js";
import type { RepositoryPorts } from "../repositories/index.js";
import { createPostgres } from "./postgres.js";
import {
  createPostgresRepositories,
  postgresReadinessSql,
} from "./postgres-repositories.js";
import { createJsonRepositories } from "./json/repositories.js";
import { collectionFiles } from "./json/schema.js";
import type { JsonCollection } from "./json/models.js";
import type { InternalNotesRepository } from "../repositories/internal-notes.js";
import { createPostgresInternalNotes } from "./postgres-internal-notes.js";
import { createJsonInternalNotes } from "./json/internal-notes.js";
import type { AuditRepository } from "../repositories/audit.js";
import { createPostgresAudit } from "./postgres-audit.js";
import { createJsonAudit } from "./json/audit.js";
import type { AuthenticationRepository } from "../repositories/authentication.js";
import { createJsonAuthentication } from "./json/authentication.js";
import { createPostgresAuthentication } from "./postgres-authentication.js";
import type { SessionRepository } from "../repositories/sessions.js";
import { createPostgresSessions } from "./postgres-sessions.js";
import { createJsonSessions } from "./json/sessions.js";
import { JsonSecurityCoordinator } from "./json/security.js";
import type { PasswordChangeRepository } from "../repositories/password-change.js";
import { createJsonPasswordChange } from "./json/password-change.js";
import { createPostgresPasswordChange } from "./postgres-password-change.js";

import type { NotificationRepository } from "../repositories/notifications.js";
import { createPostgresNotifications } from "./postgres-notifications.js";
import { createJsonNotifications } from "./json/notifications.js";

import type { ApplicationRepository } from "../repositories/applications.js";
import type { DeliveryAddressRepository } from "../repositories/delivery-addresses.js";
import { createPostgresDeliveryAddresses } from "./postgres-delivery-addresses.js";
import { createJsonDeliveryAddresses } from "./json/delivery-addresses.js";
import type { ApplicationReviewRepository } from "../repositories/application-reviews.js";
import { createPostgresApplicationReviews } from "./postgres-application-reviews.js";
import { createJsonApplicationReviews } from "./json/application-reviews.js";
import { createPostgresApplications } from "./postgres-applications.js";
import { createJsonApplications } from "./json/applications.js";

export interface StorageRuntime {
  readonly deliveryAddresses: DeliveryAddressRepository;
  readonly customerUsers: CustomerUserRepository;
  readonly accountStatus: AccountStatusRepository;
  readonly salesAssignments: SalesAssignmentRepository;
  readonly passwordResets: PasswordResetRepository;
  readonly passwordChanges: PasswordChangeRepository;
  readonly applications: ApplicationRepository;
  readonly applicationReviews: ApplicationReviewRepository;
  readonly sessions: SessionRepository;
  readonly notifications: NotificationRepository;
  readonly authentication: AuthenticationRepository;
  readonly provider: StorageProvider;
  readonly repositories: RepositoryPorts;
  readonly internalNotes: InternalNotesRepository;
  readonly audit: AuditRepository;
  readonly health: HealthProbe;
  close(): Promise<void>;
}

async function reachable(
  probe: HealthProbe,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => probe(controller.signal))
        .then(
          (up) => up === true,
          () => false,
        ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Select exactly once. Repository errors and health checks never reselect. */
export async function selectStorage(
  options: {
    postgres?: PostgresEnvironment;
    jsonDirectory: string;
    startupTimeoutMs: number;
    logger: Logger;
    requireSessions?: boolean;
    requirePasswordResets?: boolean;
    requireSalesAssignments?: boolean;
  },
  makePostgres: typeof createPostgres = createPostgres,
): Promise<StorageRuntime> {
  if (
    !Number.isInteger(options.startupTimeoutMs) ||
    options.startupTimeoutMs < 1 ||
    options.startupTimeoutMs > 60_000
  )
    throw new RangeError("Storage startup timeout must be 1–60000 ms.");
  let retirement = Promise.resolve();
  if (options.postgres) {
    const postgres = makePostgres(options.postgres, options.logger);
    if (await reachable(postgres.health, options.startupTimeoutMs)) {
      const sessions = createPostgresSessions(postgres.pool);
      const salesAssignments = createPostgresSalesAssignments(postgres.pool);
      const passwordResets = createPostgresPasswordReset(postgres.pool);
      options.logger("info", {
        event: "storage.selected",
        provider: "postgresql",
        reason: "postgres_reachable",
      });
      return Object.freeze({
        provider: "postgresql",
        sessions,
        passwordChanges: createPostgresPasswordChange(postgres.pool),
        passwordResets,
        accountStatus: createPostgresAccountStatus(postgres.pool),
        customerUsers: createPostgresCustomerUsers(postgres.pool),
        salesAssignments,
        repositories: createPostgresRepositories(postgres.pool),
        authentication: createPostgresAuthentication(postgres.pool),
        internalNotes: createPostgresInternalNotes(postgres.pool),
        audit: createPostgresAudit(postgres.pool),
        notifications: createPostgresNotifications(postgres.pool),
        applications: createPostgresApplications(postgres.pool),
        deliveryAddresses: createPostgresDeliveryAddresses(postgres.pool),
        applicationReviews: createPostgresApplicationReviews(postgres.pool),
        health: async (signal: AbortSignal) =>
          (await postgres.probe(signal, postgresReadinessSql)) &&
          !signal.aborted &&
          (!options.requireSessions || (await sessions.ready())) &&
          (!options.requirePasswordResets || (await passwordResets.ready())) &&
          (!options.requireSalesAssignments ||
            (await salesAssignments.ready())),
        close: () => postgres.close(),
      });
    }
    // Start cleanup immediately, but a late bounded pg acquisition must not keep
    // JSON startup waiting. Shutdown still owns/awaits this same retirement.
    retirement = Promise.resolve().then(() => postgres.close());
    void retirement.catch(() =>
      options.logger("error", { event: "storage.cleanup_failed" }),
    );
  }
  const security = new JsonSecurityCoordinator(options.jsonDirectory);
  const store = security.store,
    sessions = createJsonSessions(security);
  const passwordResets = createJsonPasswordReset(security);
  const salesAssignments = createJsonSalesAssignments(security);
  const applications = createJsonApplications(
    options.jsonDirectory,
    store,
    undefined,
    security,
  );
  const applicationReviews = createJsonApplicationReviews(security);
  await applicationReviews
    .recover()
    .catch(() =>
      options.logger("error", { event: "application_reviews.recovery_failed" }),
    );
  await applications
    .recover()
    .catch(() =>
      options.logger("error", { event: "applications.recovery_failed" }),
    );
  const health: HealthProbe = async (signal) => {
    if (signal.aborted) return false;
    try {
      await Promise.all(
        (Object.keys(collectionFiles) as JsonCollection[]).map((name) =>
          store.read(name),
        ),
      );
      return (
        !signal.aborted &&
        (!options.requireSessions || (await sessions.ready())) &&
        (!options.requirePasswordResets || (await passwordResets.ready())) &&
        (!options.requireSalesAssignments || (await salesAssignments.ready()))
      );
    } catch {
      return false;
    }
  };
  options.logger(options.postgres ? "warn" : "info", {
    event: "storage.selected",
    provider: "json",
    reason: options.postgres ? "postgres_unavailable" : "postgres_unconfigured",
  });
  return Object.freeze({
    provider: "json",
    sessions,
    passwordChanges: createJsonPasswordChange(security),
    accountStatus: createJsonAccountStatus(security),
    customerUsers: createJsonCustomerUsers(security),
    passwordResets,
    salesAssignments,
    repositories: createJsonRepositories(store),
    authentication: createJsonAuthentication(store),
    internalNotes: createJsonInternalNotes(options.jsonDirectory),
    audit: createJsonAudit(options.jsonDirectory),
    notifications: createJsonNotifications(options.jsonDirectory),
    applications,
    deliveryAddresses: createJsonDeliveryAddresses(security),
    applicationReviews,
    health,
    close: () => retirement,
  });
}
