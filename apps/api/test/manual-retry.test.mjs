import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { authFixture, barrier } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { checkedRetryVersion } from "../dist/services/manual-retry.js";
import { retryableSubmission } from "../dist/services/retryable-submission.js";
import { createPostgresManualRetry } from "../dist/infrastructure/postgres-manual-retry.js";
import { createPostgresSubmissionDispatch } from "../dist/infrastructure/postgres-submission-dispatch.js";
import { createPostgresRetryingGateway } from "../dist/infrastructure/postgres-submission-retry.js";
import { createMockSubmissionAdapter } from "../dist/infrastructure/mock-submission-adapter.js";
import { createApp as mockApp } from "../../mock-erp/dist/app.js";
import { createApp } from "../dist/app.js";
const signal = () => new AbortController().signal;
const conflict = (e) => e.code === "conflict";
const opts = {
  skip:
    !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
    "Disposable PostgreSQL URL required",
};
async function fixture(t) {
  const f = await authFixture(t, "postgresql");
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  const token = await f.login(),
    actor = await createAuthorization(f.auth.authenticateAccess).admit(
      token.accessToken,
      "integration-transactions.retry",
    );
  const companyId = f.data.companies[0].id,
    orderId = randomUUID(),
    id = randomUUID(),
    reference = randomUUID();
  const payload = {
    externalRequestReference: reference,
    portalOrderId: orderId,
    customerId: "DEMO-C001",
    items: [
      {
        productId: "DEMO-P003",
        quantity: "0.5",
        sellingUom: "KG",
        unitPrice: "8.25",
        currency: "AED",
        snapshot: { sku: "DEMO-P003", name: "Synthetic product" },
      },
    ],
  };
  await f.pool.query(
    "UPDATE companies SET erp_customer_reference='DEMO-C001' WHERE id=$1",
    [companyId],
  );
  await f.pool.query(
    "INSERT INTO orders(id,company_id,created_by_user_id,order_status,integration_status) VALUES($1,$2,$3,'SUBMITTED','PENDING')",
    [orderId, companyId, f.data.users[2].id],
  );
  await f.pool.query(
    "INSERT INTO integration_transactions(id,company_id,order_id,operation,idempotency_key,status,request_payload) VALUES($1,$2,$3,'ORDER_SUBMISSION',$4,'PENDING',$5::jsonb)",
    [id, companyId, orderId, reference, JSON.stringify(payload)],
  );
  const raw = async () =>
    (
      await f.pool.query("SELECT * FROM integration_transactions WHERE id=$1", [
        id,
      ])
    ).rows[0];
  const version = async () => {
    const row = await raw();
    return {
      retryCount: row.retry_count,
      updatedAt: row.updated_at.toISOString(),
    };
  };
  const fail = () =>
    createPostgresSubmissionDispatch(f.pool, {
      async send() {
        return { outcome: "rejected", code: "ERP_UNAVAILABLE" };
      },
    })(companyId, orderId);
  return {
    ...f,
    token,
    actor,
    companyId,
    orderId,
    id,
    payload,
    raw,
    version,
    fail,
  };
}
async function serve(t, app) {
  const s = app.listen(0, "127.0.0.1");
  await once(s, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        s.closeAllConnections();
        s.close(resolve);
      }),
  );
  return "http://127.0.0.1:" + s.address().port;
}
test("retry version and shared no-effect classification reject invalid or uncertain inputs", () => {
  for (const v of [
    null,
    {},
    [],
    { retryCount: -1, updatedAt: new Date().toISOString() },
    { retryCount: 2147483647, updatedAt: new Date().toISOString() },
    { retryCount: 0, updatedAt: "today" },
    { retryCount: 0, updatedAt: new Date().toISOString(), force: true },
  ])
    assert.throws(() => checkedRetryVersion(v));
  for (const code of [
    "ERP_UNAVAILABLE",
    "ERP_TIMEOUT",
    "ERP_TEMPORARY_FAILURE",
  ])
    assert.equal(retryableSubmission({ outcome: "rejected", code }), true);
  for (const v of [
    null,
    { outcome: "uncertain" },
    { outcome: "accepted" },
    { outcome: "rejected", code: "CREDIT_HOLD" },
    { outcome: "rejected", code: "OUTCOME_UNKNOWN" },
  ])
    assert.equal(retryableSubmission(v), false);
});
test(
  "exhausted automatic retries retain eligibility; one real Mock manual retry recovers the original identity",
  opts,
  async (t) => {
    const f = await fixture(t);
    let fail = true,
      calls = 0;
    const app = express();
    app.use((req, _res, next) => {
      calls++;
      if (fail) req.headers["x-mock-erp-scenario"] = "unavailable";
      next();
    });
    app.use(mockApp());
    const base = await serve(t, app),
      gateway = createMockSubmissionAdapter({
        baseUrl: base + "/mock-erp/v1/",
        timeoutMs: 1000,
      });
    await createPostgresSubmissionDispatch(
      f.pool,
      createPostgresRetryingGateway(
        f.pool,
        gateway,
        { maxRetries: 1, delayMs: 100 },
        async () => {},
      ),
    )(f.companyId, f.orderId);
    assert.equal(calls, 2);
    assert.equal((await f.raw()).retryable, true);
    assert.equal((await f.raw()).retry_count, 1);
    fail = false;
    const retry = createPostgresManualRetry(f.pool, gateway, f.now),
      version = await f.version();
    assert.deepEqual(await retry(f.actor, f.id, version, signal()), {
      transactionId: f.id,
    });
    const row = await f.raw();
    assert.equal(row.status, "SUCCESS");
    assert.equal(row.retryable, false);
    assert.equal(row.retry_count, 2);
    assert.deepEqual(row.request_payload, f.payload);
    const audit = (
      await f.pool.query(
        "SELECT company_id,actor_user_id,actor_role,target_type,target_id,metadata,created_at FROM audit_logs WHERE action='integration.retry_requested'",
      )
    ).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_user_id, f.actor.userId);
    assert.equal(audit[0].actor_role, "INTERNAL_ADMIN");
    assert.equal(audit[0].company_id, f.companyId);
    assert.equal(audit[0].target_type, "integration_transaction");
    assert.equal(audit[0].target_id, f.id);
    assert.deepEqual(audit[0].metadata, {
      transactionId: f.id,
      orderId: f.orderId,
      outcome: "success",
    });
    assert.ok(audit[0].created_at instanceof Date);
    assert.doesNotMatch(
      JSON.stringify(audit),
      /PRIVATE|payload|password|token/i,
    );
    assert.equal(calls, 3);
    const order = (
      await f.pool.query(
        "SELECT order_status,integration_status,erp_order_reference FROM orders WHERE id=$1",
        [f.orderId],
      )
    ).rows[0];
    assert.equal(order.order_status, "SUBMITTED");
    assert.equal(order.integration_status, "SUCCESS");
    assert.ok(order.erp_order_reference);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE action='integration.retry_requested'",
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(retry(f.actor, f.id, version, signal()), conflict);
    assert.equal(calls, 3);
  },
);
test(
  "concurrent identical Admin commands claim once, and unknown outcomes cannot be retried",
  opts,
  async (t) => {
    const f = await fixture(t);
    await f.fail();
    let calls = 0;
    const gate = barrier(),
      started = barrier();
    const retry = createPostgresManualRetry(
      f.pool,
      {
        async send() {
          calls++;
          started.resolve();
          await gate.promise;
          return { outcome: "uncertain" };
        },
      },
      f.now,
    );
    const version = await f.version(),
      pending = retry(f.actor, f.id, version, signal());
    await started.promise;
    await assert.rejects(retry(f.actor, f.id, version, signal()), conflict);
    gate.resolve();
    await pending;
    assert.equal(calls, 1);
    assert.equal((await f.raw()).retryable, false);
    await assert.rejects(
      retry(f.actor, f.id, await f.version(), signal()),
      conflict,
    );
  },
);
test(
  "business, unmarked, inconsistent, linked, cancelled and inactive-company transactions cannot send",
  opts,
  async (t) => {
    const f = await fixture(t);
    await f.fail();
    let calls = 0;
    const retry = createPostgresManualRetry(
      f.pool,
      {
        async send() {
          calls++;
          return { outcome: "accepted", erpOrderReference: "SYNTHETIC" };
        },
      },
      f.now,
    );
    const baseline = await f.raw();
    for (const patch of [
      { status: "PROCESSING" },
      { retryable: false },
      { operation: "OTHER" },
      {
        error_code: "CREDIT_HOLD",
        response_payload: { outcome: "rejected", code: "CREDIT_HOLD" },
      },
      {
        error_code: "OUTCOME_UNKNOWN",
        response_payload: { outcome: "uncertain" },
      },
      { request_payload: { ...f.payload, customerId: "FOREIGN" } },
      {
        request_payload: {
          ...f.payload,
          items: [{ ...f.payload.items[0], quantity: 0.5 }],
        },
      },
    ]) {
      for (const [key, value] of Object.entries(patch))
        await f.pool.query(
          "UPDATE integration_transactions SET " + key + "=$1 WHERE id=$2",
          [typeof value === "object" ? JSON.stringify(value) : value, f.id],
        );
      await assert.rejects(
        retry(f.actor, f.id, await f.version(), signal()),
        (e) => ["conflict", "unavailable"].includes(e.code),
      );
      for (const key of Object.keys(patch))
        await f.pool.query(
          "UPDATE integration_transactions SET " + key + "=$1 WHERE id=$2",
          [
            typeof baseline[key] === "object"
              ? JSON.stringify(baseline[key])
              : baseline[key],
            f.id,
          ],
        );
    }
    await f.pool.query(
      "UPDATE orders SET order_status='CANCELLED' WHERE id=$1",
      [f.orderId],
    );
    await assert.rejects(
      retry(f.actor, f.id, await f.version(), signal()),
      conflict,
    );
    await f.pool.query(
      "UPDATE orders SET order_status='SUBMITTED',erp_order_reference='LINKED' WHERE id=$1",
      [f.orderId],
    );
    await assert.rejects(
      retry(f.actor, f.id, await f.version(), signal()),
      conflict,
    );
    await f.pool.query(
      "UPDATE orders SET erp_order_reference=NULL WHERE id=$1",
      [f.orderId],
    );
    await f.pool.query("UPDATE companies SET status='SUSPENDED' WHERE id=$1", [
      f.companyId,
    ]);
    await assert.rejects(
      retry(f.actor, f.id, await f.version(), signal()),
      conflict,
    );
    assert.equal(calls, 0);
  },
);
test(
  "required audit failure rolls back claim/count and current session revocation refuses before I/O",
  opts,
  async (t) => {
    const f = await fixture(t);
    await f.fail();
    let calls = 0;
    const retry = createPostgresManualRetry(
        f.pool,
        {
          async send() {
            calls++;
            return { outcome: "uncertain" };
          },
        },
        f.now,
      ),
      before = await f.raw();
    await f.pool.query(
      "ALTER TABLE audit_logs ADD CONSTRAINT test_retry_audit CHECK(action<>'integration.retry_requested') NOT VALID",
    );
    await assert.rejects(
      retry(f.actor, f.id, await f.version(), signal()),
      (e) => e.code === "unavailable",
    );
    assert.deepEqual(await f.raw(), before);
    assert.equal(calls, 0);
    await f.pool.query(
      "ALTER TABLE audit_logs DROP CONSTRAINT test_retry_audit",
    );
    await f.pool.query(
      "UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE id=$1",
      [f.actor.sessionId],
    );
    await assert.rejects(
      retry(f.actor, f.id, await f.version(), signal()),
      (e) => e.code === "invalid_proof",
    );
    assert.equal(calls, 0);
  },
);
test(
  "HTTP admits only normal Internal Admin, uses safe bounded versioned responses and fails closed without provider",
  opts,
  async (t) => {
    const f = await fixture(t);
    await f.fail();
    const logs = [];
    let calls = 0;
    const retry = createPostgresManualRetry(
      f.pool,
      {
        async send() {
          calls++;
          return { outcome: "rejected", code: "ERP_UNAVAILABLE" };
        },
      },
      f.now,
    );
    const base = await serve(
        t,
        createApp({
          sessions: f.auth,
          manualRetry: retry,
          logger: (_l, e) => logs.push(e),
        }),
      ),
      url = base + "/api/v1/admin/integration-transactions/" + f.id + "/retry";
    const post = (token, body) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: "Bearer " + token } : {}),
        },
        body: JSON.stringify(body),
      });
    assert.equal((await post(null, {})).status, 401);
    for (const n of [1, 2, 3])
      assert.equal(
        (await post((await f.login(n)).accessToken, await f.version())).status,
        403,
      );
    const version = await f.version(),
      ok = await post(f.token.accessToken, version);
    assert.equal(ok.status, 202);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.deepEqual((await ok.json()).data, { transactionId: f.id });
    assert.equal((await post(f.token.accessToken, version)).status, 409);
    assert.equal(
      (await post(f.token.accessToken, { ...(await f.version()), force: true }))
        .status,
      400,
    );
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(logs).includes("ERP_UNAVAILABLE"));
    const absent = await serve(
      t,
      createApp({ sessions: f.auth, logger: () => {} }),
    );
    const refused = await fetch(
      absent + "/api/v1/admin/integration-transactions/" + f.id + "/retry",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + f.token.accessToken,
        },
        body: JSON.stringify(await f.version()),
      },
    );
    assert.equal(refused.status, 503);
    assert.equal(calls, 1);
  },
);
