import test from "node:test";
import express from "express";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createOrderDrafts } from "../dist/services/order-drafts.js";
import { createJsonOrderDrafts } from "../dist/infrastructure/json/order-drafts.js";
import { createPostgresOrderDrafts } from "../dist/infrastructure/postgres-order-drafts.js";
import { createMockCustomerCatalogSource } from "../dist/infrastructure/mock-customer-catalog-adapter.js";
import { createMockSubmissionAdapter } from "../dist/infrastructure/mock-submission-adapter.js";
import { createPostgresOrderSubmission } from "../dist/infrastructure/postgres-order-submission.js";
import { createApp } from "../dist/app.js";
import { createApp as createMock } from "../../mock-erp/dist/app.js";
const isCode = (code) => (e) => e.code === code;
async function fixture(t, provider) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  const cid = f.data.companies[0].id,
    addressId = randomUUID();
  if (provider === "json")
    await fs.writeFile(
      join(f.directory, "delivery_addresses.json"),
      JSON.stringify([
        {
          id: addressId,
          companyId: cid,
          label: "Delivery",
          address: { line1: "Synthetic" },
          active: true,
          isDefault: false,
        },
      ]),
    );
  else {
    await f.pool.query(
      "UPDATE companies SET erp_customer_reference=$1 WHERE id=$2",
      ["DEMO-C001", cid],
    );
    await f.pool.query(
      "INSERT INTO delivery_addresses(id,company_id,label,address,active,is_default) VALUES($1,$2,'Delivery',$3::jsonb,true,false)",
      [addressId, cid, JSON.stringify({ line1: "Synthetic" })],
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
  }
  f.repo =
    provider === "json"
      ? createJsonOrderDrafts(f.security, f.now)
      : createPostgresOrderDrafts(f.pool, f.now);
  f.actor = async (i) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(i)).accessToken,
      "profile.read",
    );
  f.ca = await f.actor(2);
  f.cu = await f.actor(3);
  f.base = createOrderDrafts(f.repo, f.record);
  const draft = (
    await f.base.create(f.ca, { deliveryAddressId: addressId }, randomUUID())
  ).draft;
  f.draft = (
    await f.base.changeItem(
      f.ca,
      draft.id,
      undefined,
      "add",
      {
        version: draft.version,
        productId: f.data.products[0].id,
        quantity: "1",
      },
      randomUUID(),
    )
  ).draft;
  f.server = createMock().listen(0, "127.0.0.1");
  await once(f.server, "listening");
  t.after(
    () =>
      new Promise((r) => {
        f.server.closeAllConnections();
        f.server.close(r);
      }),
  );
  f.source = createMockCustomerCatalogSource({
    baseUrl: "http://127.0.0.1:" + f.server.address().port + "/mock-erp/v1/",
    timeoutMs: 5000,
  });
  f.service = createOrderDrafts(f.repo, f.record, {
    minimum: { amount: "27.5", currency: "AED" },
    source: f.source,
  });
  f.unacknowledged = f.draft;
  const quote = await f.service.terms(f.ca, f.draft.id, {
    version: f.draft.version,
  });
  f.draft = (
    await f.service.acknowledgeTerms(
      f.ca,
      f.draft.id,
      { version: f.draft.version, token: quote.token },
      randomUUID(),
    )
  ).draft;
  return f;
}
test(
  "postgresql: one submission commits snapshot and request, sends once, and replays",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "PostgreSQL URL required",
  },
  async (t) => {
    const f = await fixture(t, "postgresql");
    const mock = createMockSubmissionAdapter({
      baseUrl: `http://127.0.0.1:${f.server.address().port}/mock-erp/v1/`,
      timeoutMs: 5000,
    });
    let sent = 0;
    const submit = createPostgresOrderSubmission(
      f.pool,
      f.source,
      { amount: "27.5", currency: "AED" },
      {
        async send(body) {
          sent++;
          return mock.send(body);
        },
      },
    );
    const body = { version: f.draft.version };
    const results = await Promise.all([
      submit(f.ca, f.draft.id, "stable-key", body),
      submit(f.ca, f.draft.id, "stable-key", body),
    ]);
    assert.deepEqual(results, [
      { orderId: f.draft.id },
      { orderId: f.draft.id },
    ]);
    assert.equal(sent, 1);
    const row = (
      await f.pool.query(
        "SELECT order_status,integration_status,erp_order_reference,order_snapshot FROM orders WHERE id=$1",
        [f.draft.id],
      )
    ).rows[0];
    assert.equal(row.order_status, "SUBMITTED");
    assert.equal(row.integration_status, "SUCCESS");
    assert.ok(row.erp_order_reference);
    assert.equal(row.order_snapshot.orderId, f.draft.id);
    const tx = (
      await f.pool.query(
        "SELECT idempotency_key,status,request_payload,response_payload FROM integration_transactions WHERE order_id=$1",
        [f.draft.id],
      )
    ).rows;
    assert.equal(tx.length, 1);
    assert.equal(tx[0].status, "SUCCESS");
    assert.equal(
      tx[0].request_payload.externalRequestReference,
      tx[0].idempotency_key,
    );
    const offlineReplay = createPostgresOrderSubmission(
      f.pool,
      {
        async readSnapshot() {
          throw Error("offline");
        },
      },
      { amount: "27.5", currency: "AED" },
      {
        async send() {
          throw Error("must not send");
        },
      },
    );
    assert.deepEqual(
      await offlineReplay(f.ca, f.draft.id, "stable-key", body),
      { orderId: f.draft.id },
    );
    await assert.rejects(
      submit(f.ca, f.draft.id, "other-key", body),
      isCode("conflict"),
    );
    await assert.rejects(submit(f.cu, f.draft.id, "stable-key", body));
    assert.equal(sent, 1);
  },
);
test(
  "postgresql: an uncertain send is retained and never automatically sent again",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "PostgreSQL URL required",
  },
  async (t) => {
    const f = await fixture(t, "postgresql");
    const snapshot = await f.source.readSnapshot(new AbortController().signal);
    const mock = createMockSubmissionAdapter({
      baseUrl: `http://127.0.0.1:${f.server.address().port}/mock-erp/v1/`,
      timeoutMs: 5000,
    });
    let sent = 0;
    const submit = createPostgresOrderSubmission(
      f.pool,
      { readSnapshot: async () => structuredClone(snapshot) },
      { amount: "27.5", currency: "AED" },
      {
        async send(request) {
          sent++;
          assert.equal((await mock.send(request)).outcome, "accepted");
          return { outcome: "uncertain" };
        },
      },
    );
    const body = { version: f.draft.version };
    await submit(f.ca, f.draft.id, "unknown-key", body);
    await new Promise((resolve) => {
      f.server.closeAllConnections();
      f.server.close(resolve);
    });
    f.server = createMock().listen(0, "127.0.0.1");
    await once(f.server, "listening");
    await submit(f.ca, f.draft.id, "unknown-key", body);
    const row = (
      await f.pool.query(
        "SELECT status,retryable,error_code FROM integration_transactions WHERE order_id=$1",
        [f.draft.id],
      )
    ).rows[0];
    assert.deepEqual(row, {
      status: "FAILED",
      retryable: false,
      error_code: "OUTCOME_UNKNOWN",
    });
    assert.equal(sent, 1);
  },
);
test(
  "postgresql: a lost worker after claim is not automatically retried",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "PostgreSQL URL required",
  },
  async (t) => {
    const f = await fixture(t, "postgresql");
    let sent = 0;
    const submit = createPostgresOrderSubmission(
      f.pool,
      f.source,
      { amount: "27.5", currency: "AED" },
      {
        async send() {
          sent++;
          return { outcome: "uncertain" };
        },
      },
    );
    const body = { version: f.draft.version };
    await submit(f.ca, f.draft.id, "crash-key", body);
    await f.pool.query(
      "UPDATE integration_transactions SET status='PROCESSING',error_code=NULL,response_payload=NULL WHERE order_id=$1",
      [f.draft.id],
    );
    await submit(f.ca, f.draft.id, "crash-key", body);
    assert.equal(sent, 1);
    assert.equal(
      (
        await f.pool.query(
          "SELECT status FROM integration_transactions WHERE order_id=$1",
          [f.draft.id],
        )
      ).rows[0].status,
      "PROCESSING",
    );
  },
);
test(
  "postgresql: audit failure rolls back reservation and submission",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "PostgreSQL URL required",
  },
  async (t) => {
    const f = await fixture(t, "postgresql");
    let sent = 0;
    await f.pool.query(
      "ALTER TABLE audit_logs ADD CONSTRAINT reject_submission_audit CHECK (action <> 'order.submitted')",
    );
    const submit = createPostgresOrderSubmission(
      f.pool,
      f.source,
      { amount: "27.5", currency: "AED" },
      {
        async send() {
          sent++;
          return { outcome: "uncertain" };
        },
      },
    );
    await assert.rejects(
      submit(f.ca, f.draft.id, "audit-key", { version: f.draft.version }),
      isCode("unavailable"),
    );
    assert.equal(sent, 0);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM submission_idempotency WHERE order_id=$1",
          [f.draft.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.pool.query("SELECT order_status FROM orders WHERE id=$1", [
          f.draft.id,
        ])
      ).rows[0].order_status,
      "DRAFT",
    );
  },
);
test(
  "postgresql: changed stock or price prevents transaction, snapshot and ERP send",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "PostgreSQL URL required",
  },
  async (t) => {
    const f = await fixture(t, "postgresql"),
      current = await f.source.readSnapshot(new AbortController().signal);
    let sent = 0;
    const submit = createPostgresOrderSubmission(
      f.pool,
      { readSnapshot: async () => structuredClone(current) },
      { amount: "27.5", currency: "AED" },
      {
        async send() {
          sent++;
          return { outcome: "uncertain" };
        },
      },
    );
    current.products.find(
      (p) => p.reference === "DEMO-P001",
    ).metadata.availableQuantity = "0";
    await assert.rejects(
      submit(f.ca, f.draft.id, "stock-key", { version: f.draft.version }),
      isCode("conflict"),
    );
    current.products.find(
      (p) => p.reference === "DEMO-P001",
    ).metadata.availableQuantity = "20";
    current.prices.find(
      (p) =>
        p.productReference === "DEMO-P001" &&
        p.customerReference === "DEMO-C001",
    ).price.amount = "30";
    await assert.rejects(
      submit(f.ca, f.draft.id, "price-key", { version: f.draft.version }),
      isCode("conflict"),
    );
    assert.equal(sent, 0);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM integration_transactions WHERE order_id=$1",
          [f.draft.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.pool.query("SELECT order_status FROM orders WHERE id=$1", [
          f.draft.id,
        ])
      ).rows[0].order_status,
      "DRAFT",
    );
  },
);
test(
  "postgresql: Mock business rejection is terminal, sanitized and not retried",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "PostgreSQL URL required",
  },
  async (t) => {
    const f = await fixture(t, "postgresql"),
      app = express();
    app.use((req, _res, next) => {
      req.headers["x-mock-erp-scenario"] = "credit-hold";
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
    const mock = createMockSubmissionAdapter({
      baseUrl: `http://127.0.0.1:${server.address().port}/mock-erp/v1/`,
      timeoutMs: 5000,
    });
    let sent = 0;
    const submit = createPostgresOrderSubmission(
      f.pool,
      f.source,
      { amount: "27.5", currency: "AED" },
      {
        async send(request) {
          sent++;
          return mock.send(request);
        },
      },
    );
    const body = { version: f.draft.version };
    await submit(f.ca, f.draft.id, "reject-key", body);
    await submit(f.ca, f.draft.id, "reject-key", body);
    const row = (
      await f.pool.query(
        "SELECT status,retryable,error_code,response_payload FROM integration_transactions WHERE order_id=$1",
        [f.draft.id],
      )
    ).rows[0];
    assert.equal(row.status, "FAILED");
    assert.equal(row.retryable, false);
    assert.equal(row.error_code, "CREDIT_HOLD");
    assert.deepEqual(row.response_payload, {
      outcome: "rejected",
      code: "CREDIT_HOLD",
    });
    assert.equal(sent, 1);
    const order = (
      await f.pool.query(
        "SELECT order_status,integration_status,erp_order_reference FROM orders WHERE id=$1",
        [f.draft.id],
      )
    ).rows[0];
    assert.deepEqual(order, {
      order_status: "SUBMITTED",
      integration_status: "FAILED",
      erp_order_reference: null,
    });
  },
);
test(
  "postgresql: HTTP submission requires auth and idempotency key and returns no ERP identity",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "PostgreSQL URL required",
  },
  async (t) => {
    const f = await fixture(t, "postgresql");
    const gateway = createMockSubmissionAdapter({
      baseUrl: `http://127.0.0.1:${f.server.address().port}/mock-erp/v1/`,
      timeoutMs: 5000,
    });
    const submit = createPostgresOrderSubmission(
      f.pool,
      f.source,
      { amount: "27.5", currency: "AED" },
      gateway,
    );
    const server = createApp({
      sessions: f.auth,
      orderDrafts: f.service,
      orderSubmission: submit,
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const url = `http://127.0.0.1:${server.address().port}/api/v1/order-drafts/${f.draft.id}/submit`;
    const token = (await f.login(2)).accessToken,
      body = JSON.stringify({ version: f.draft.version });
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body,
        })
      ).status,
      400,
    );
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "idempotency-key": "http-key",
      },
      body,
    });
    assert.equal(response.status, 202);
    const text = await response.text();
    assert.ok(text.includes(f.draft.id));
    assert.ok(!text.includes("DEMO-C001"));
    assert.ok(!text.includes("erpOrder"));
  },
);
test("JSON submission fails closed when durable reservation is unavailable", async (t) => {
  const f = await fixture(t, "json");
  const server = createApp({ sessions: f.auth, orderDrafts: f.service }).listen(
    0,
    "127.0.0.1",
  );
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const token = (await f.login(2)).accessToken;
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/v1/order-drafts/${f.draft.id}/submit`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "idempotency-key": "json-key",
      },
      body: JSON.stringify({ version: f.draft.version }),
    },
  );
  assert.equal(response.status, 503);
  assert.equal(
    (
      await f.repo.find(
        {
          userId: f.ca.userId,
          sessionId: f.ca.sessionId,
          companyId: f.ca.companyId,
          role: f.ca.role,
          accessExpiresAt: f.ca.accessExpiresAt,
        },
        f.draft.id,
      )
    ).status,
    "DRAFT",
  );
});
test(
  "postgresql: a client disconnect cannot cancel the committed submission",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "PostgreSQL URL required",
  },
  async (t) => {
    const f = await fixture(t, "postgresql"),
      accepted = randomUUID();
    let started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    let finish;
    const gate = new Promise((resolve) => {
      finish = resolve;
    });
    const submit = createPostgresOrderSubmission(
      f.pool,
      f.source,
      { amount: "27.5", currency: "AED" },
      {
        async send() {
          started();
          await gate;
          return { outcome: "accepted", erpOrderReference: accepted };
        },
      },
    );
    const server = createApp({
      sessions: f.auth,
      orderDrafts: f.service,
      orderSubmission: submit,
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const controller = new AbortController(),
      token = (await f.login(2)).accessToken;
    const request = fetch(
      `http://127.0.0.1:${server.address().port}/api/v1/order-drafts/${f.draft.id}/submit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "idempotency-key": "disconnect-key",
        },
        body: JSON.stringify({ version: f.draft.version }),
        signal: controller.signal,
      },
    ).catch(() => null);
    await entered;
    controller.abort();
    await request;
    finish();
    for (let i = 0; i < 50; i++) {
      const row = (
        await f.pool.query(
          "SELECT integration_status,erp_order_reference FROM orders WHERE id=$1",
          [f.draft.id],
        )
      ).rows[0];
      if (row.integration_status === "SUCCESS") {
        assert.equal(row.erp_order_reference, accepted);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("The committed submission did not finish after disconnect");
  },
);
test("Mock adapter treats malformed or mismatched receipts and transport failures as uncertain", async (t) => {
  const app = express();
  let mode = "mismatch",
    count = 0;
  app.post("/mock-erp/v1/submissions", express.json(), (req, res) => {
    count++;
    if (mode === "failure")
      return res
        .status(503)
        .json({ error: { code: "SECRET", message: "private" } });
    res.status(201).json({
      externalRequestReference: "different",
      portalOrderId: req.body.portalOrderId,
      customerId: req.body.customerId,
      outcome: "accepted",
      order: {
        erpOrderId: randomUUID(),
        status: "created",
        portalOrderId: req.body.portalOrderId,
        customerId: req.body.customerId,
        items: req.body.items,
      },
    });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const adapter = createMockSubmissionAdapter({
    baseUrl: `http://127.0.0.1:${server.address().port}/mock-erp/v1/`,
    timeoutMs: 1000,
  });
  const request = {
    externalRequestReference: "abc",
    portalOrderId: randomUUID(),
    customerId: "DEMO-C001",
    items: [],
  };
  assert.deepEqual(await adapter.send(request), { outcome: "uncertain" });
  mode = "failure";
  assert.deepEqual(await adapter.send(request), { outcome: "uncertain" });
  assert.equal(count, 2);
});
test(
  "postgresql: integration claim and result never overwrite concurrent business status",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "PostgreSQL URL required",
  },
  async (t) => {
    const f = await fixture(t, "postgresql");
    let release, entered;
    const started = new Promise((r) => {
        entered = r;
      }),
      gate = new Promise((r) => {
        release = r;
      });
    const submit = createPostgresOrderSubmission(
      f.pool,
      f.source,
      { amount: "27.5", currency: "AED" },
      {
        async send() {
          entered();
          await gate;
          return { outcome: "uncertain" };
        },
      },
    );
    const pending = submit(f.ca, f.draft.id, "status-key", {
      version: f.draft.version,
    });
    await started;
    const before = (
      await f.pool.query(
        "SELECT o.order_status,o.integration_status,t.status AS transaction_status FROM orders o JOIN integration_transactions t ON t.order_id=o.id WHERE o.id=$1",
        [f.draft.id],
      )
    ).rows[0];
    assert.deepEqual(before, {
      order_status: "SUBMITTED",
      integration_status: "PROCESSING",
      transaction_status: "PROCESSING",
    });
    await f.pool.query(
      "UPDATE orders SET order_status='CONFIRMED' WHERE id=$1",
      [f.draft.id],
    );
    release();
    await pending;
    const after = (
      await f.pool.query(
        "SELECT o.order_status,o.integration_status,t.status AS transaction_status,t.error_code,t.retryable FROM orders o JOIN integration_transactions t ON t.order_id=o.id WHERE o.id=$1",
        [f.draft.id],
      )
    ).rows[0];
    assert.deepEqual(after, {
      order_status: "CONFIRMED",
      integration_status: "FAILED",
      transaction_status: "FAILED",
      error_code: "OUTCOME_UNKNOWN",
      retryable: false,
    });
  },
);
test(
  "postgresql: failed order claim rolls the transaction claim back without sending",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "PostgreSQL URL required",
  },
  async (t) => {
    const f = await fixture(t, "postgresql");
    let sent = 0;
    await f.pool.query(
      "ALTER TABLE orders ADD CONSTRAINT reject_processing CHECK (integration_status <> 'PROCESSING')",
    );
    const submit = createPostgresOrderSubmission(
      f.pool,
      f.source,
      { amount: "27.5", currency: "AED" },
      {
        async send() {
          sent++;
          return { outcome: "uncertain" };
        },
      },
    );
    await assert.rejects(
      submit(f.ca, f.draft.id, "claim-key", { version: f.draft.version }),
      isCode("unavailable"),
    );
    const row = (
      await f.pool.query(
        "SELECT o.order_status,o.integration_status,t.status AS transaction_status FROM orders o JOIN integration_transactions t ON t.order_id=o.id WHERE o.id=$1",
        [f.draft.id],
      )
    ).rows[0];
    assert.deepEqual(row, {
      order_status: "SUBMITTED",
      integration_status: "PENDING",
      transaction_status: "PENDING",
    });
    assert.equal(sent, 0);
  },
);
test(
  "postgresql: a concurrent technical status change cannot be overwritten by an ERP result",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "PostgreSQL URL required",
  },
  async (t) => {
    const f = await fixture(t, "postgresql");
    let release, entered;
    const started = new Promise((r) => {
        entered = r;
      }),
      gate = new Promise((r) => {
        release = r;
      });
    const submit = createPostgresOrderSubmission(
      f.pool,
      f.source,
      { amount: "27.5", currency: "AED" },
      {
        async send() {
          entered();
          await gate;
          return { outcome: "accepted", erpOrderReference: randomUUID() };
        },
      },
    );
    const pending = submit(f.ca, f.draft.id, "changed-technical-key", {
      version: f.draft.version,
    });
    await started;
    await f.pool.query(
      "UPDATE orders SET integration_status='FAILED' WHERE id=$1",
      [f.draft.id],
    );
    release();
    await assert.rejects(pending, isCode("unavailable"));
    const row = (
      await f.pool.query(
        "SELECT o.order_status,o.integration_status,o.erp_order_reference,t.status AS transaction_status FROM orders o JOIN integration_transactions t ON t.order_id=o.id WHERE o.id=$1",
        [f.draft.id],
      )
    ).rows[0];
    assert.deepEqual(row, {
      order_status: "SUBMITTED",
      integration_status: "FAILED",
      erp_order_reference: null,
      transaction_status: "PROCESSING",
    });
  },
);
for (const provider of ["json", "postgresql"]) {
  const opts = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "PostgreSQL URL required"
        : false,
  };
  test(
    provider +
      ": explicit acknowledgement binds customer-visible prices; price changes conflict and sufficient stock changes do not",
    opts,
    async (t) => {
      const f = await fixture(t, provider);
      const snap = await f.source.readSnapshot(new AbortController().signal);
      let current = structuredClone(snap);
      const service = createOrderDrafts(f.repo, f.record, {
        minimum: { amount: "0", currency: "AED" },
        source: { readSnapshot: async () => structuredClone(current) },
      });
      const unbased = await f.base.create(f.ca, {}, randomUUID());
      const added = await f.base.changeItem(
        f.ca,
        unbased.draft.id,
        undefined,
        "add",
        {
          version: unbased.draft.version,
          productId: f.data.products[0].id,
          quantity: "1",
        },
        randomUUID(),
      );
      assert.ok(
        (
          await service.validate(f.ca, added.draft.id, {
            version: added.draft.version,
          })
        ).issues.some((i) => i.code === "COMMERCIAL_TERMS_REQUIRED"),
      );
      const quote = await service.terms(f.ca, f.draft.id, {
        version: f.draft.version,
      });
      const customerPrice = () =>
        current.prices.find(
          (p) =>
            p.productReference === "DEMO-P001" &&
            p.customerReference === "DEMO-C001",
        ).price;
      customerPrice().amount = "27.5000";
      assert.equal(
        (await service.validate(f.ca, f.draft.id, { version: f.draft.version }))
          .valid,
        true,
      );
      current.products.find(
        (p) => p.reference === "DEMO-P001",
      ).metadata.availableQuantity = "2";
      assert.equal(
        (await service.validate(f.ca, f.draft.id, { version: f.draft.version }))
          .valid,
        true,
      );
      current.products.find(
        (p) => p.reference === "DEMO-P001",
      ).metadata.availableQuantity = "0.5";
      assert.ok(
        (
          await service.validate(f.ca, f.draft.id, { version: f.draft.version })
        ).issues.some((i) => i.code === "INSUFFICIENT_STOCK"),
      );
      current.products.find(
        (p) => p.reference === "DEMO-P001",
      ).metadata.availableQuantity = null;
      assert.ok(
        (
          await service.validate(f.ca, f.draft.id, { version: f.draft.version })
        ).issues.some((i) => i.code === "STOCK_UNKNOWN"),
      );
      current = structuredClone(snap);
      customerPrice().amount = "29";
      const changed = await service.validate(f.ca, f.draft.id, {
        version: f.draft.version,
      });
      assert.deepEqual(
        changed.issues.filter((i) => i.code === "PRICE_CHANGED"),
        [{ code: "PRICE_CHANGED", itemId: quote.terms[0].itemId }],
      );
      await assert.rejects(
        service.acknowledgeTerms(
          f.ca,
          f.draft.id,
          { version: f.draft.version, token: quote.token },
          randomUUID(),
        ),
        isCode("conflict"),
      );
      const fresh = await service.terms(f.ca, f.draft.id, {
        version: f.draft.version,
      });
      assert.equal(fresh.terms[0].amount, "29");
      const accepted = (
        await service.acknowledgeTerms(
          f.ca,
          f.draft.id,
          { version: f.draft.version, token: fresh.token },
          randomUUID(),
        )
      ).draft;
      assert.notEqual(accepted.version, f.draft.version);
      assert.equal(
        (
          await service.validate(f.ca, accepted.id, {
            version: accepted.version,
          })
        ).valid,
        true,
      );
      await assert.rejects(
        service.acknowledgeTerms(
          f.cu,
          accepted.id,
          { version: accepted.version, token: fresh.token },
          randomUUID(),
        ),
        isCode("not_found"),
      );
    },
  );
  test(
    provider +
      ": actual Mock source validates current customer price and stock, ownership, address and minimum",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        input = { version: f.draft.version };
      const result = await f.service.validate(f.ca, f.draft.id, input);
      assert.equal(result.valid, true);
      assert.deepEqual(result.issues, []);
      assert.equal(result.draftVersion, f.draft.version);
      assert.equal(JSON.stringify(result).includes("DEMO-C001"), false);
      await assert.rejects(
        f.service.validate(f.cu, f.draft.id, input),
        isCode("not_found"),
      );
      await assert.rejects(
        f.service.validate(f.ca, f.draft.id, {
          version: f.draft.version,
          minimum: "0",
        }),
        isCode("invalid_input"),
      );
      const stricter = createOrderDrafts(f.repo, f.record, {
        minimum: { amount: "27.50001", currency: "AED" },
        source: f.source,
      });
      assert.deepEqual(
        (await stricter.validate(f.ca, f.draft.id, input)).issues,
        [{ code: "BELOW_MINIMUM_ORDER_VALUE" }],
      );
      const disabled = createOrderDrafts(f.repo, f.record);
      await assert.rejects(
        disabled.validate(f.ca, f.draft.id, input),
        isCode("unavailable"),
      );
    },
  );
  test(
    provider +
      ": acknowledgement and edits serialize, preserve terms on restart and reject uncertain writes",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        before = f.draft;
      const quote = await f.service.terms(f.ca, before.id, {
        version: before.version,
      });
      const results = await Promise.allSettled([
        f.service.acknowledgeTerms(
          f.ca,
          before.id,
          { version: before.version, token: quote.token },
          randomUUID(),
        ),
        f.base.update(
          f.ca,
          before.id,
          { version: before.version, deliveryAddressId: null },
          randomUUID(),
        ),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.find((r) => r.status === "rejected").reason.code,
        "conflict",
      );
      let current = (await f.base.find(f.ca, before.id)).draft;
      const reopened =
        provider === "json"
          ? createJsonOrderDrafts(f.security, f.now)
          : createPostgresOrderDrafts(f.pool, f.now);
      const reopenedService = createOrderDrafts(reopened, f.record, {
        minimum: { amount: "27.5", currency: "AED" },
        source: f.source,
      });
      assert.ok(
        !(
          await reopenedService.validate(f.ca, current.id, {
            version: current.version,
          })
        ).issues.some((i) => i.code === "COMMERCIAL_TERMS_REQUIRED"),
      );
      const nextQuote = await reopenedService.terms(f.ca, current.id, {
        version: current.version,
      });
      const uncertain = createOrderDrafts(
        reopened,
        async () => {
          throw Error("PRIVATE");
        },
        { minimum: { amount: "27.5", currency: "AED" }, source: f.source },
      );
      await assert.rejects(
        uncertain.acknowledgeTerms(
          f.ca,
          current.id,
          { version: current.version, token: nextQuote.token },
          randomUUID(),
        ),
        isCode("unavailable"),
      );
      const changed = (await f.base.find(f.ca, current.id)).draft;
      assert.notEqual(changed.version, current.version);
      await assert.rejects(
        reopenedService.acknowledgeTerms(
          f.ca,
          current.id,
          { version: current.version, token: nextQuote.token },
          randomUUID(),
        ),
        isCode("conflict"),
      );
    },
  );
  test(
    provider +
      ": provider errors, source changes and stale draft version fail closed",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        input = { version: f.draft.version };
      const failure = createOrderDrafts(f.repo, f.record, {
        minimum: { amount: "0", currency: "AED" },
        source: {
          readSnapshot: async () => {
            throw Error("PRIVATE");
          },
        },
      });
      await assert.rejects(
        failure.validate(f.ca, f.draft.id, input),
        isCode("unavailable"),
      );
      const snapshot = await f.source.readSnapshot(
        new AbortController().signal,
      );
      const source = {
        readSnapshot: async () => {
          await f.base.update(
            f.ca,
            f.draft.id,
            { version: f.draft.version, deliveryAddressId: null },
            randomUUID(),
          );
          return snapshot;
        },
      };
      const raced = createOrderDrafts(f.repo, f.record, {
        minimum: { amount: "0", currency: "AED" },
        source,
      });
      await assert.rejects(
        raced.validate(f.ca, f.draft.id, input),
        isCode("conflict"),
      );
      const current = (await f.base.find(f.ca, f.draft.id)).draft;
      assert.deepEqual(
        (
          await f.service.validate(f.ca, current.id, {
            version: current.version,
          })
        ).issues,
        [{ code: "ADDRESS_UNAVAILABLE" }],
      );
    },
  );
  test(
    provider +
      ": request-time source controls price, stock, eligibility and MOQ",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        input = { version: f.draft.version };
      const snapshot = await f.source.readSnapshot(
        new AbortController().signal,
      );
      let current = structuredClone(snapshot);
      const service = createOrderDrafts(f.repo, f.record, {
        minimum: { amount: "27.5", currency: "AED" },
        source: { readSnapshot: async () => structuredClone(current) },
      });
      const product = () =>
        current.products.find((p) => p.reference === "DEMO-P001");
      const codes = async () =>
        (await service.validate(f.ca, f.draft.id, input)).issues.map(
          (i) => i.code,
        );
      product().metadata.availableQuantity = null;
      assert.ok((await codes()).includes("STOCK_UNKNOWN"));
      product().metadata.availableQuantity = "0.5";
      assert.ok((await codes()).includes("INSUFFICIENT_STOCK"));
      current = structuredClone(snapshot);
      product().minimumOrderQuantity = "1.25";
      assert.ok((await codes()).includes("BELOW_MOQ"));
      current = structuredClone(snapshot);
      current.access.find(
        (a) =>
          a.customerReference === "DEMO-C001" &&
          a.productReference === "DEMO-P001",
      ).eligible = false;
      assert.ok((await codes()).includes("PRODUCT_UNAVAILABLE"));
      current = structuredClone(snapshot);
      current.prices = current.prices.filter(
        (p) => p.productReference !== "DEMO-P001",
      );
      assert.ok((await codes()).includes("PRICE_UNAVAILABLE"));
      current = structuredClone(snapshot);
      current.customers.find((c) => c.reference === "DEMO-C001").active = false;
      assert.ok((await codes()).includes("ACCOUNT_INELIGIBLE"));
    },
  );
  test(
    provider +
      ": actual validation HTTP route exposes no ERP identity or request policy",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        server = createApp({
          sessions: f.auth,
          orderDrafts: f.service,
          logger: () => {},
        }).listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(
        () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(r);
          }),
      );
      const url =
          "http://127.0.0.1:" +
          server.address().port +
          "/api/v1/order-drafts/" +
          f.draft.id +
          "/validate",
        token = (await f.login(2)).accessToken;
      const send = (body, target = url) =>
        fetch(target, {
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      let res = await send({ version: f.draft.version });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      let body = await res.json();
      assert.equal(body.data.valid, true);
      assert.ok(!JSON.stringify(body).includes("DEMO-C001"));
      res = await send({ version: f.draft.version, currency: "USD" });
      assert.equal(res.status, 400);
      const termsUrl = url.replace(/\/validate$/, "/terms");
      res = await send({ version: f.draft.version }, termsUrl);
      assert.equal(res.status, 200);
      const quote = (await res.json()).data;
      assert.equal(quote.terms[0].amount, "27.50");
      assert.equal(quote.stock[0].availableQuantity, "100");
      res = await send(
        { version: f.draft.version, token: quote.token },
        termsUrl + "/acknowledge",
      );
      assert.equal(res.status, 200);
      assert.notEqual((await res.json()).data.draft.version, f.draft.version);
    },
  );
}
