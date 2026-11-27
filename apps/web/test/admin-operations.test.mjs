import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
let vite, api, TransactionDetails, DiagnosticsSummary;
const id = "12345678-1234-4234-8234-123456789abc",
  company = "22345678-1234-4234-8234-123456789abc",
  staff = "32345678-1234-4234-8234-123456789abc",
  time = "2026-11-27T10:00:00.000Z";
const user = {
  id,
  companyId: null,
  role: "INTERNAL_ADMIN",
  mustChangePassword: false,
};
const row = {
  id,
  companyId: company,
  orderId: staff,
  operation: "ORDER_SUBMISSION",
  status: "FAILED",
  retryable: true,
  retryCount: 2,
  nextRetryAt: null,
  errorCode: "ERP_TEMPORARY_FAILURE",
  createdAt: time,
  updatedAt: time,
};
const health = {
  storage: { provider: "json", status: "up" },
  database: { provider: "postgresql", configured: false, status: "not_in_use" },
  erp: { provider: null, status: "unconfigured" },
};
before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  api = await vite.ssrLoadModule("/src/features/admin-operations/api.ts");
  ({ TransactionDetails } = await vite.ssrLoadModule(
    "/src/features/admin-operations/IntegrationsPage.tsx",
  ));
  ({ DiagnosticsSummary } = await vite.ssrLoadModule(
    "/src/features/admin-operations/AdminEntry.tsx",
  ));
});
after(async () => vite?.close());
const envelope = (data) =>
  new Response(JSON.stringify({ success: true, requestId: id, data }), {
    headers: { "content-type": "application/json" },
  });
test("Admin projections retain only approved fields and reject malformed source/health claims", () => {
  assert.deepEqual(
    api.transactionView({
      ...row,
      errorMessage: "PRIVATE",
      requestPayload: "PRIVATE",
    }),
    row,
  );
  assert.deepEqual(
    api.diagnosticsView({ ...health, secret: "PRIVATE" }),
    health,
  );
  for (const change of [
    { status: "UNKNOWN" },
    { retryCount: -1 },
    { errorCode: "PRIVATE_ERROR" },
    { companyId: "bad" },
  ])
    assert.throws(() => api.transactionView({ ...row, ...change }));
  assert.throws(() =>
    api.diagnosticsView({
      ...health,
      database: { ...health.database, status: "up" },
    }),
  );
  assert.throws(() =>
    api.staffView({ id, companyId: company, role: "CUSTOMER_USER" }),
  );
  assert.throws(() => api.assignmentView({ id, companyId: id }, company));
});
test("monitor query validates exact filters and retry UI never offers unknown/business/in-flight outcomes", () => {
  const query = new URLSearchParams(
    api.monitorQuery(
      { q: "TX_1-abc", status: "FAILED", companyId: company, orderId: staff },
      20,
    ),
  );
  assert.equal(query.get("q"), "TX_1-abc");
  assert.equal(query.get("offset"), "20");
  for (const value of [{ q: "bad%" }, { companyId: "../" }, { status: "bad" }])
    assert.throws(() =>
      api.monitorQuery(
        { q: "", status: "", companyId: "", orderId: "", ...value },
        0,
      ),
    );
  assert.equal(api.canRequestRetry(row), true);
  for (const patch of [
    { status: "PROCESSING" },
    { operation: "OTHER" },
    { retryable: false },
    { errorCode: "OUTCOME_UNKNOWN" },
    { errorCode: "CREDIT_HOLD" },
  ])
    assert.equal(api.canRequestRetry({ ...row, ...patch }), false);
});
test("Admin transport sends one versioned PUT assignment and retry, with cancellation and no write replay", async () => {
  const signal = new AbortController().signal,
    calls = [],
    assignment = {
      id,
      companyId: company,
      salesStaffUserId: staff,
      assignedByUserId: id,
      isPrimary: true,
      active: true,
      createdAt: time,
      endedAt: null,
    };
  const client = new api.AdminClient(
    {
      request: async (path, init) => {
        calls.push([path, init]);
        return envelope(
          path.endsWith("/retry") ? { transactionId: id } : { assignment },
        );
      },
    },
    user,
  );
  assert.deepEqual(
    await client.assign(company, staff, null, signal),
    assignment,
  );
  assert.equal(calls[0][1].method, "PUT");
  assert.equal(calls[0][1].signal, signal);
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    salesStaffUserId: staff,
    expectedAssignmentId: null,
  });
  await client.retry(row, signal);
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    retryCount: 2,
    updatedAt: time,
  });
  assert.equal(calls.length, 2);
  const bad = new api.AdminClient(
    { request: async () => new Response("PRIVATE", { status: 503 }) },
    user,
  );
  await assert.rejects(bad.retry(row, signal));
  for (const role of ["SALES_STAFF", "CUSTOMER_ADMIN", "CUSTOMER_USER"])
    assert.throws(() => new api.AdminClient({}, { ...user, role }));
  assert.throws(
    () => new api.AdminClient({}, { ...user, mustChangePassword: true }),
  );
  const wrong = new api.AdminClient(
    {
      request: async () =>
        envelope({
          target: { id: company, kind: "company", status: "ACTIVE" },
        }),
    },
    user,
  );
  await assert.rejects(
    wrong.changeCompany(company, "ACTIVE", "SUSPENDED", signal),
  );
});
test("Admin detail and diagnostics markup display retained facts without private payloads or fabricated recovery", () => {
  const html = renderToStaticMarkup(
    createElement(TransactionDetails, {
      row: api.transactionView({ ...row, errorMessage: "PRIVATE" }),
    }),
  );
  assert.match(html, /OUTCOME|ERP_TEMPORARY_FAILURE/);
  assert.match(html, /separate from order business state/);
  assert.doesNotMatch(
    html,
    /PRIVATE|SO-105814|continue processing automatically/,
  );
  const diagnostics = renderToStaticMarkup(
    createElement(DiagnosticsSummary, { report: health }),
  );
  assert.match(diagnostics, /not in use/);
  assert.match(diagnostics, /unconfigured/);
  assert.doesNotMatch(
    diagnostics,
    /PRIVATE|Healthy ERP|All systems operational/,
  );
});
