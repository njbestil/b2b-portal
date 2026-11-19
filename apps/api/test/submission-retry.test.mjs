import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createApp as createMock } from "../../mock-erp/dist/app.js";
import { createMockSubmissionAdapter } from "../dist/infrastructure/mock-submission-adapter.js";
import { createPostgresRetryingGateway } from "../dist/infrastructure/postgres-submission-retry.js";
import { createPostgresSubmissionDispatch } from "../dist/infrastructure/postgres-submission-dispatch.js";
import { parseSubmissionRetryPolicy } from "../dist/infrastructure/submission-retry-config.js";

test("retry configuration is bounded and errors do not expose input", () => {
  assert.deepEqual(parseSubmissionRetryPolicy({}), {
    maxRetries: 2,
    delayMs: 1000,
  });
  assert.deepEqual(
    parseSubmissionRetryPolicy({
      ERP_SUBMISSION_MAX_RETRIES: "0",
      ERP_SUBMISSION_RETRY_DELAY_MS: "100",
    }),
    { maxRetries: 0, delayMs: 100 },
  );
  for (const env of [
    { ERP_SUBMISSION_MAX_RETRIES: "6" },
    { ERP_SUBMISSION_MAX_RETRIES: "secret" },
    { ERP_SUBMISSION_RETRY_DELAY_MS: "99" },
    { ERP_SUBMISSION_RETRY_DELAY_MS: "5001" },
  ])
    assert.throws(
      () => parseSubmissionRetryPolicy(env),
      (e) =>
        e.name === "EnvironmentConfigurationError" &&
        !e.message.includes("secret"),
    );
});
test("a matching technical code without correlation is never classified for retry", async (t) => {
  const app = express();
  app.post("/mock-erp/v1/submissions", express.json(), (_req, res) =>
    res.status(503).json({
      externalRequestReference: "wrong",
      portalOrderId: randomUUID(),
      customerId: "DEMO-C001",
      error: { code: "ERP_UNAVAILABLE", message: "private" },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const gateway = createMockSubmissionAdapter({
    baseUrl: `http://127.0.0.1:${server.address().port}/mock-erp/v1/`,
    timeoutMs: 1000,
  });
  assert.deepEqual(
    await gateway.send({
      externalRequestReference: "actual",
      portalOrderId: randomUUID(),
      customerId: "DEMO-C001",
      items: [],
    }),
    { outcome: "uncertain" },
  );
});
test(
  "the Mock adapter recognizes only correlated technical fixture responses",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "PostgreSQL URL required",
  },
  async (t) => {
    for (const [scenario, code] of [
      ["unavailable", "ERP_UNAVAILABLE"],
      ["temporary-server-failure", "ERP_TEMPORARY_FAILURE"],
      ["timeout", "ERP_TIMEOUT"],
    ]) {
      const f = await fixture(t, () => scenario);
      assert.deepEqual(await f.gateway.send(f.request), {
        outcome: "rejected",
        code,
      });
      assert.equal(f.calls(), 1);
    }
  },
);
async function fixture(t, scenario) {
  const f = await authFixture(t, "postgresql"),
    id = randomUUID(),
    ref = randomUUID(),
    companyId = f.data.companies[0].id;
  const request = {
    externalRequestReference: ref,
    portalOrderId: id,
    customerId: "DEMO-C001",
    items: [
      {
        productId: "DEMO-P003",
        quantity: "0.500000",
        sellingUom: "KG",
        unitPrice: "8.250000",
        currency: "AED",
        snapshot: { sku: "DEMO-P003", name: "Test product" },
      },
    ],
  };
  await f.pool.query(
    "INSERT INTO orders(id,company_id,created_by_user_id,order_status,integration_status) VALUES($1,$2,$3,'SUBMITTED','PENDING')",
    [id, companyId, f.data.users[2].id],
  );
  await f.pool.query(
    "INSERT INTO integration_transactions(id,company_id,order_id,operation,idempotency_key,status,request_payload) VALUES($1,$2,$3,'ORDER_SUBMISSION',$4,'PROCESSING',$5::jsonb)",
    [randomUUID(), companyId, id, ref, JSON.stringify(request)],
  );
  let calls = 0;
  const app = express();
  app.use((req, _res, next) => {
    const selected = scenario(calls++);
    if (selected) req.headers["x-mock-erp-scenario"] = selected;
    next();
  });
  app.use(createMock());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const gateway = createMockSubmissionAdapter({
    baseUrl: `http://127.0.0.1:${server.address().port}/mock-erp/v1/`,
    timeoutMs: 4000,
  });
  return { ...f, request, gateway, calls: () => calls };
}
const opts = {
  skip:
    !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL && "PostgreSQL URL required",
};
test(
  "correlated Mock technical failures retry exact identity up to the configured cap",
  opts,
  async (t) => {
    const f = await fixture(t, (n) => (n < 2 ? "unavailable" : null));
    const waits = [];
    const gateway = createPostgresRetryingGateway(
      f.pool,
      f.gateway,
      { maxRetries: 2, delayMs: 100 },
      async (ms) => {
        waits.push(ms);
      },
    );
    const result = await gateway.send(f.request);
    assert.equal(result.outcome, "accepted");
    assert.equal(f.calls(), 3);
    assert.deepEqual(waits, [100, 200]);
    const row = (
      await f.pool.query(
        "SELECT retry_count,next_retry_at FROM integration_transactions WHERE order_id=$1",
        [f.request.portalOrderId],
      )
    ).rows[0];
    assert.deepEqual(row, { retry_count: 2, next_retry_at: null });
  },
);
test(
  "the submission dispatcher records a successful retry without changing business status",
  opts,
  async (t) => {
    const f = await fixture(t, (n) => (n === 0 ? "unavailable" : null));
    await f.pool.query(
      "UPDATE integration_transactions SET status='PENDING' WHERE order_id=$1",
      [f.request.portalOrderId],
    );
    const gateway = createPostgresRetryingGateway(
      f.pool,
      f.gateway,
      { maxRetries: 2, delayMs: 100 },
      async () => {},
    );
    const dispatch = createPostgresSubmissionDispatch(f.pool, gateway);
    await dispatch(f.data.companies[0].id, f.request.portalOrderId);
    const row = (
      await f.pool.query(
        "SELECT o.order_status,o.integration_status,t.status,t.retry_count,t.next_retry_at FROM orders o JOIN integration_transactions t ON t.order_id=o.id WHERE o.id=$1",
        [f.request.portalOrderId],
      )
    ).rows[0];
    assert.deepEqual(row, {
      order_status: "SUBMITTED",
      integration_status: "SUCCESS",
      status: "SUCCESS",
      retry_count: 1,
      next_retry_at: null,
    });
    assert.equal(f.calls(), 2);
  },
);
test(
  "exhausted, business and unknown outcomes never exceed their retry budget",
  opts,
  async (t) => {
    for (const [scenario, expected, calls, retries] of [
      ["unavailable", "ERP_UNAVAILABLE", 3, 2],
      ["credit-hold", "CREDIT_HOLD", 1, 0],
    ]) {
      const f = await fixture(t, () => scenario),
        gateway = createPostgresRetryingGateway(
          f.pool,
          f.gateway,
          { maxRetries: 2, delayMs: 100 },
          async () => {},
        );
      const result = await gateway.send(f.request);
      assert.equal(result.code, expected);
      assert.equal(f.calls(), calls);
      assert.equal(
        (
          await f.pool.query(
            "SELECT retry_count FROM integration_transactions WHERE order_id=$1",
            [f.request.portalOrderId],
          )
        ).rows[0].retry_count,
        retries,
      );
    }
    const f = await fixture(t, () => null);
    let sends = 0;
    const gateway = createPostgresRetryingGateway(
      f.pool,
      {
        async send() {
          sends++;
          return { outcome: "uncertain" };
        },
      },
      { maxRetries: 2, delayMs: 100 },
      async () => {},
    );
    assert.deepEqual(await gateway.send(f.request), { outcome: "uncertain" });
    assert.equal(sends, 1);
  },
);
test(
  "interruption while waiting records the allocation and does not send again",
  opts,
  async (t) => {
    const f = await fixture(t, () => "unavailable");
    const gateway = createPostgresRetryingGateway(
      f.pool,
      f.gateway,
      { maxRetries: 2, delayMs: 100 },
      async () => {
        throw Error("worker stopped");
      },
    );
    assert.deepEqual(await gateway.send(f.request), { outcome: "uncertain" });
    assert.equal(f.calls(), 1);
    const row = (
      await f.pool.query(
        "SELECT retry_count,status,next_retry_at FROM integration_transactions WHERE order_id=$1",
        [f.request.portalOrderId],
      )
    ).rows[0];
    assert.equal(row.retry_count, 1);
    assert.equal(row.status, "PROCESSING");
    assert.ok(row.next_retry_at instanceof Date);
  },
);
