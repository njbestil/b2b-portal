import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createOrderDrafts } from "../dist/services/order-drafts.js";
import { createPostgresOrderDrafts } from "../dist/infrastructure/postgres-order-drafts.js";
import { createMockCustomerCatalogSource } from "../dist/infrastructure/mock-customer-catalog-adapter.js";
import { createMockSubmissionAdapter } from "../dist/infrastructure/mock-submission-adapter.js";
import { createPostgresRetryingGateway } from "../dist/infrastructure/postgres-submission-retry.js";
import { createPostgresOrderSubmission } from "../dist/infrastructure/postgres-order-submission.js";
import { createPostgresManualRetry } from "../dist/infrastructure/postgres-manual-retry.js";
import { createApp } from "../dist/app.js";
import { createApp as createMock } from "../../mock-erp/dist/app.js";
const opts = {
  skip:
    !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
    "Disposable PostgreSQL required",
};
async function listen(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  return "http://127.0.0.1:" + server.address().port;
}
async function fixture(
  t,
  { scenarios = [], loseReceipt = false, maxRetries = 2 } = {},
) {
  const f = await authFixture(t, "postgresql");
  for (let n = 0; n < f.data.users.length; n++)
    await f.setUser({ mustChangePassword: false }, n);
  const cid = f.data.companies[0].id,
    address = randomUUID();
  await f.pool.query(
    "UPDATE companies SET erp_customer_reference='DEMO-C001' WHERE id=$1",
    [cid],
  );
  await f.pool.query(
    "INSERT INTO delivery_addresses(id,company_id,label,address,active,is_default) VALUES($1,$2,$3,$4,true,false)",
    [address, cid, "Synthetic", '{"line1":"Test delivery"}'],
  );
  for (const p of f.data.products)
    await f.pool.query(
      "INSERT INTO products(id,erp_product_reference,sku,name,selling_uom,minimum_order_quantity,active) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        p.id,
        p.erpProductReference,
        p.sku,
        p.name,
        p.sellingUom,
        p.minimumOrderQuantity,
        p.active,
      ],
    );
  for (const a of f.data.customer_product_access)
    await f.pool.query(
      "INSERT INTO customer_product_access(id,company_id,product_id,eligible) VALUES($1,$2,$3,$4)",
      [randomUUID(), a.companyId, a.productId, a.eligible],
    );
  f.sent = [];
  f.waits = [];
  let mock = createMock();
  const wrapped = express();
  wrapped.use(express.json({ limit: "32kb" }));
  wrapped.use((req, res, next) => {
    if (req.method === "POST" && req.path === "/mock-erp/v1/submissions") {
      const scenario = scenarios[Math.min(f.sent.length, scenarios.length - 1)];
      if (scenario) req.headers["x-mock-erp-scenario"] = scenario;
      f.sent.push(structuredClone(req.body));
      if (loseReceipt) {
        res.end = function (chunk) {
          f.lostReceipt = JSON.parse(chunk.toString());
          res.socket.destroy();
          return res;
        };
      }
    }
    next();
  });
  wrapped.use((req, res, next) => mock(req, res, next));
  f.mockOrigin = await listen(t, wrapped);
  f.restartMock = () => {
    mock = createMock();
  };
  const config = { baseUrl: f.mockOrigin + "/mock-erp/v1/", timeoutMs: 4000 },
    source = createMockCustomerCatalogSource(config),
    repo = createPostgresOrderDrafts(f.pool, f.now);
  f.drafts = createOrderDrafts(repo, f.record, {
    source,
    minimum: { amount: "27.5", currency: "AED" },
  });
  f.customer = await createAuthorization(f.auth.authenticateAccess).admit(
    (await f.login(2)).accessToken,
    "order-drafts.manage",
  );
  let d = (
    await f.drafts.create(
      f.customer,
      { deliveryAddressId: address },
      randomUUID(),
    )
  ).draft;
  d = (
    await f.drafts.changeItem(
      f.customer,
      d.id,
      undefined,
      "add",
      { version: d.version, productId: f.data.products[0].id, quantity: "1" },
      randomUUID(),
    )
  ).draft;
  const terms = await f.drafts.terms(f.customer, d.id, { version: d.version });
  f.draft = (
    await f.drafts.acknowledgeTerms(
      f.customer,
      d.id,
      { version: d.version, token: terms.token },
      randomUUID(),
    )
  ).draft;
  const oneAttempt = createMockSubmissionAdapter(config),
    gateway = createPostgresRetryingGateway(
      f.pool,
      oneAttempt,
      { maxRetries, delayMs: 100 },
      async (ms) => {
        f.waits.push(ms);
      },
    );
  f.compose = () =>
    createApp({
      sessions: f.auth,
      orderDrafts: f.drafts,
      orderSubmission: createPostgresOrderSubmission(
        f.pool,
        source,
        { amount: "27.5", currency: "AED" },
        gateway,
      ),
      manualRetry: createPostgresManualRetry(f.pool, oneAttempt),
      logger() {},
    });
  f.origin = await listen(t, f.compose());
  f.token = (await f.login(2)).accessToken;
  f.key = randomUUID();
  f.request = async (
    key = f.key,
    body = { version: f.draft.version },
    token = f.token,
    origin = f.origin,
  ) => {
    const res = await fetch(
      origin + "/api/v1/order-drafts/" + f.draft.id + "/submit",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      },
    );
    return {
      status: res.status,
      cache: res.headers.get("cache-control"),
      body: await res.json(),
    };
  };
  f.rows = async () => {
    const rows = (
      await f.pool.query(
        "SELECT o.order_status,o.integration_status,o.erp_order_reference,o.order_snapshot,t.id,t.status,t.retry_count,t.retryable,t.error_code,t.next_retry_at,t.idempotency_key,t.request_payload,t.response_payload,t.updated_at FROM orders o JOIN integration_transactions t ON t.order_id=o.id WHERE o.id=$1",
        [f.draft.id],
      )
    ).rows;
    assert.equal(rows.length, 1);
    return rows[0];
  };
  return f;
}
function privateReceipt(result, id) {
  assert.equal(result.status, 202);
  assert.equal(result.cache, "no-store");
  assert.deepEqual(result.body.data, { orderId: id });
  for (const secret of [
    "DEMO-C001",
    "erpOrderReference",
    "request_payload",
    "ERP_TIMEOUT",
    "CREDIT_HOLD",
  ])
    assert.ok(!JSON.stringify(result.body).includes(secret));
}
test(
  "Portal HTTP → SQL snapshot/ledger → real Mock success: concurrent replay and new app preserve one outbound identity",
  opts,
  async (t) => {
    const f = await fixture(t);
    for (const r of await Promise.all([f.request(), f.request()]))
      privateReceipt(r, f.draft.id);
    const row = await f.rows();
    assert.equal(f.sent.length, 1);
    assert.equal(row.status, "SUCCESS");
    assert.equal(row.order_status, "SUBMITTED");
    assert.equal(row.integration_status, "SUCCESS");
    assert.equal(row.retry_count, 0);
    assert.ok(row.erp_order_reference);
    assert.equal(row.order_snapshot.orderId, f.draft.id);
    assert.deepEqual(row.request_payload, f.sent[0]);
    assert.equal(row.idempotency_key, f.sent[0].externalRequestReference);
    const nextOrigin = await listen(t, f.compose());
    privateReceipt(
      await f.request(f.key, undefined, f.token, nextOrigin),
      f.draft.id,
    );
    assert.equal(f.sent.length, 1);
    assert.equal((await f.request(randomUUID())).status, 409);
    assert.equal(
      (await f.request(f.key, undefined, (await f.login(4)).accessToken))
        .status,
      409,
    );
    assert.equal(f.sent.length, 1);
  },
);
test(
  "Portal HTTP retries correlated no-effect timeout and unavailable responses with retained payload and bounded backoff",
  opts,
  async (t) => {
    const f = await fixture(t, {
      scenarios: ["timeout", "unavailable", "success"],
    });
    privateReceipt(await f.request(), f.draft.id);
    const row = await f.rows();
    assert.equal(row.status, "SUCCESS");
    assert.equal(row.retry_count, 2);
    assert.equal(row.next_retry_at, null);
    assert.deepEqual(f.waits, [100, 200]);
    assert.equal(f.sent.length, 3);
    assert.ok(
      f.sent.every((r) => JSON.stringify(r) === JSON.stringify(f.sent[0])),
    );
    privateReceipt(await f.request(), f.draft.id);
    assert.equal(f.sent.length, 3);
  },
);
test(
  "Portal HTTP exhausted technical retries remain submitted/delayed and replay never resets the budget",
  opts,
  async (t) => {
    const f = await fixture(t, { scenarios: ["unavailable"] });
    privateReceipt(await f.request(), f.draft.id);
    const row = await f.rows();
    assert.equal(row.order_status, "SUBMITTED");
    assert.equal(row.integration_status, "FAILED");
    assert.equal(row.status, "FAILED");
    assert.equal(row.error_code, "ERP_UNAVAILABLE");
    assert.equal(row.retryable, true);
    assert.equal(row.retry_count, 2);
    assert.equal(row.next_retry_at, null);
    assert.equal(f.sent.length, 3);
    privateReceipt(await f.request(), f.draft.id);
    assert.equal(f.sent.length, 3);
    assert.equal((await f.rows()).retry_count, 2);
  },
);
test(
  "Portal HTTP business rejection is retained without automatic retry or invented business transition",
  opts,
  async (t) => {
    const f = await fixture(t, { scenarios: ["credit-hold"] });
    privateReceipt(await f.request(), f.draft.id);
    const row = await f.rows();
    assert.equal(row.error_code, "CREDIT_HOLD");
    assert.equal(row.retryable, false);
    assert.equal(row.retry_count, 0);
    assert.equal(row.order_status, "SUBMITTED");
    assert.equal(row.integration_status, "FAILED");
    assert.deepEqual(f.waits, []);
    privateReceipt(await f.request(), f.draft.id);
    assert.equal(f.sent.length, 1);
  },
);
test(
  "real Mock accepts then loses receipt: unknown outcome is never resent after Portal or Mock restart, including manual retry",
  opts,
  async (t) => {
    const f = await fixture(t, { loseReceipt: true });
    privateReceipt(await f.request(), f.draft.id);
    const row = await f.rows();
    assert.equal(f.lostReceipt.outcome, "accepted");
    assert.ok(f.lostReceipt.order.erpOrderId);
    assert.equal(row.error_code, "OUTCOME_UNKNOWN");
    assert.equal(row.retryable, false);
    assert.equal(row.retry_count, 0);
    assert.equal(row.erp_order_reference, null);
    assert.equal(f.sent.length, 1);
    const accepted = await fetch(
      f.mockOrigin +
        "/mock-erp/v1/orders/" +
        f.lostReceipt.order.erpOrderId +
        "/fulfillment",
    );
    assert.equal(accepted.status, 200);
    f.restartMock();
    const nextOrigin = await listen(t, f.compose());
    privateReceipt(
      await f.request(f.key, undefined, f.token, nextOrigin),
      f.draft.id,
    );
    assert.equal((await f.request(randomUUID())).status, 409);
    const admin = (await f.login(0)).accessToken,
      res = await fetch(
        nextOrigin +
          "/api/v1/admin/integration-transactions/" +
          row.id +
          "/retry",
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + admin,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            retryCount: row.retry_count,
            updatedAt: row.updated_at.toISOString(),
          }),
        },
      );
    assert.equal(res.status, 409);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.waits, []);
    assert.deepEqual((await f.rows()).order_snapshot, row.order_snapshot);
  },
);
