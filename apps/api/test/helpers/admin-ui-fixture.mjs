import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { authFixture } from "./auth-fixture.mjs";
import { createApp } from "../../dist/app.js";
import { createLogin } from "../../dist/services/login.js";
import {
  verifyPassword,
  hashPassword,
} from "../../dist/infrastructure/passwords.js";
import { createSalesStaff } from "../../dist/services/sales-staff.js";
import { createAdminSalesAssignments } from "../../dist/services/admin-sales-assignments.js";
import { createAccountStatus } from "../../dist/services/account-status.js";
import { createIntegrationMonitor } from "../../dist/services/integration-monitor.js";
import { createDiagnostics } from "../../dist/services/diagnostics.js";
import { createPostgresManualRetry } from "../../dist/infrastructure/postgres-manual-retry.js";
import { createUnavailableIntegrationMonitor } from "../../dist/infrastructure/unavailable-integration-monitor.js";
import { createPostgresIntegrationMonitor } from "../../dist/infrastructure/postgres-integration-monitor.js";
import { createJsonRepositories } from "../../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../../dist/infrastructure/postgres-repositories.js";
import { createJsonSalesStaff } from "../../dist/infrastructure/json/sales-staff.js";
import { createPostgresSalesStaff } from "../../dist/infrastructure/postgres-sales-staff.js";
import { createJsonAdminCompanies } from "../../dist/infrastructure/json/admin-companies.js";
import { createPostgresAdminCompanies } from "../../dist/infrastructure/postgres-admin-companies.js";
import { createJsonAdminSalesAssignments } from "../../dist/infrastructure/json/admin-sales-assignments.js";
import { createPostgresAdminSalesAssignments } from "../../dist/infrastructure/postgres-admin-sales-assignments.js";
import { createJsonAccountStatus } from "../../dist/infrastructure/json/account-status.js";
import { createPostgresAccountStatus } from "../../dist/infrastructure/postgres-account-status.js";
export async function adminFixture(t, provider) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  const sql = provider === "postgresql",
    storage = sql ? f.pool : f.security;
  f.staffRepo = sql
    ? createPostgresSalesStaff(storage, f.now)
    : createJsonSalesStaff(storage, f.now);
  f.staffService = createSalesStaff(
    f.staffRepo,
    hashPassword,
    f.record,
    randomUUID,
  );
  f.options = {
    sessions: f.auth,
    sessionLogin: f.auth.login,
    login: createLogin(f.authentication, verifyPassword, f.record),
    companyRepositories: sql
      ? createPostgresRepositories(f.pool)
      : createJsonRepositories(f.security.store),
    adminCompanies: sql
      ? createPostgresAdminCompanies(f.pool, f.now)
      : createJsonAdminCompanies(f.security, f.now),
    salesStaff: f.staffService,
    adminSalesAssignments: createAdminSalesAssignments(
      sql
        ? createPostgresAdminSalesAssignments(f.pool, f.now)
        : createJsonAdminSalesAssignments(f.security, f.now),
      f.record,
      randomUUID,
    ),
    accountStatus: createAccountStatus(
      sql
        ? createPostgresAccountStatus(f.pool, f.now)
        : createJsonAccountStatus(f.security, f.now),
      f.record,
    ),
    integrationMonitor: createIntegrationMonitor(
      sql
        ? createPostgresIntegrationMonitor(f.pool, f.now)
        : createUnavailableIntegrationMonitor(),
      f.now,
    ),
    diagnostics: createDiagnostics({
      storage: {
        provider,
        probe: async () => {
          if (sql) await f.pool.query("SELECT 1");
          else await f.security.store.read("companies");
          return true;
        },
      },
      database: {
        configured: sql,
        ...(sql
          ? {
              probe: async () => {
                await f.pool.query("SELECT 1");
                return true;
              },
            }
          : {}),
      },
      erp: { provider: null },
    }),
    logger() {},
  };
  f.sends = 0;
  if (sql) {
    f.options.manualRetry = createPostgresManualRetry(f.pool, {
      async send() {
        f.sends++;
        throw Error("Unexpected send");
      },
    });
    f.order = randomUUID();
    f.transaction = randomUUID();
    await f.pool.query(
      "INSERT INTO orders(id,company_id,created_by_user_id,order_status,integration_status) VALUES($1,$2,$3,'SUBMITTED','FAILED')",
      [f.order, f.data.companies[0].id, f.data.users[2].id],
    );
    await f.pool.query(
      "INSERT INTO integration_transactions(id,company_id,order_id,operation,status,retryable,retry_count,error_code,idempotency_key,request_payload,response_payload,error_message) VALUES($1,$2,$3,'ORDER_SUBMISSION','FAILED',true,1,'ERP_TEMPORARY_FAILURE',$4,$5::jsonb,$6::jsonb,'PRIVATE_ERROR')",
      [
        f.transaction,
        f.data.companies[0].id,
        f.order,
        randomUUID(),
        '{"private":"PRIVATE_REQUEST"}',
        '{"private":"PRIVATE_RESPONSE"}',
      ],
    );
  }
  const server = createApp(f.options).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  f.url = `http://127.0.0.1:${server.address().port}`;
  return f;
}
