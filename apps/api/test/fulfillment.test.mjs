import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { authFixture, oldPassword, barrier } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import {
  createFulfillmentRefresh,
  fulfillmentTransition,
} from "../dist/services/fulfillment.js";
import { createJsonFulfillment } from "../dist/infrastructure/json/fulfillment.js";
import { createPostgresFulfillment } from "../dist/infrastructure/postgres-fulfillment.js";
import { createMockFulfillmentSource } from "../dist/infrastructure/mock-fulfillment-adapter.js";
import { createOrderSnapshot } from "../dist/services/order-snapshot.js";
import { createApp } from "../dist/app.js";
import { createApp as createMock } from "../../mock-erp/dist/app.js";
const code = (value) => (e) => e.code === value;
const denied = (e) =>
  ["invalid_proof", "restricted", "forbidden"].includes(e.code) ||
  e.name === "AuthorizationError";
const signal = () => new AbortController().signal;
async function server(t, app) {
  const s = app.listen(0, "127.0.0.1");
  await once(s, "listening");
  t.after(
    () =>
      new Promise((r) => {
        s.closeAllConnections();
        s.close(r);
      }),
  );
  return { server: s, url: `http://127.0.0.1:${s.address().port}` };
}
async function fixture(t, provider = "json", io = fs) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.companyId = f.data.companies[0].id;
  f.orderId = randomUUID();
  f.erpId = randomUUID();
  f.customer = "DEMO-C001";
  const time = new Date(f.now()).toISOString(),
    addressId = randomUUID(),
    itemId = randomUUID();
  f.snapshot = createOrderSnapshot({
    orderId: f.orderId,
    companyId: f.companyId,
    submittedAt: time,
    submittedBy: {
      id: f.data.users[2].id,
      companyId: f.companyId,
      displayName: "Historical Buyer",
      role: "CUSTOMER_ADMIN",
    },
    delivery: {
      id: addressId,
      companyId: f.companyId,
      label: "Historical Delivery",
      line1: "Frozen Street",
      contactName: null,
      contactPhone: null,
    },
    items: [
      {
        itemId,
        productId: f.data.products[0].id,
        sku: "DEMO-P001",
        name: "Historical Product",
        sellingUom: "CASE",
        minimumOrderQuantity: "1",
        quantity: "1.25",
        unitPrice: "27.50",
        currency: "AED",
      },
    ],
  });
  const row = {
    id: f.orderId,
    companyId: f.companyId,
    createdByUserId: f.data.users[2].id,
    orderNumber: "SYNTHETIC-ORDER",
    createdAt: time,
    updatedAt: time,
    deliveryAddressId: addressId,
    status: "SUBMITTED",
    integrationStatus: "SUCCESS",
    erpOrderReference: f.erpId,
    items: [{ id: itemId, productId: f.data.products[0].id, quantity: "1.25" }],
    submittedSnapshot: f.snapshot,
  };
  if (provider === "json") {
    await f.security.store.replace("orders", [
      ...(await f.security.store.read("orders")),
      row,
    ]);
    // These unrelated private artifacts must not be read/rewritten by fulfillment.
    await fs.writeFile(
      join(f.directory, "integration_transactions.json"),
      JSON.stringify({
        private: "SYNTHETIC_UNREAD_TECHNICAL",
        status: "FAILED",
        attempts: 7,
      }),
    );
  } else {
    await f.pool.query(
      "UPDATE companies SET erp_customer_reference=$1 WHERE id=$2",
      [f.customer, f.companyId],
    );
    await f.pool.query(
      "INSERT INTO delivery_addresses(id,company_id,label,address) VALUES($1,$2,'Historical',$3::jsonb)",
      [addressId, f.companyId, JSON.stringify({ line1: "Frozen Street" })],
    );
    await f.pool.query(
      "INSERT INTO orders(id,company_id,created_by_user_id,order_number,created_at,updated_at,delivery_address_id,order_status,integration_status,erp_order_reference,order_snapshot,submitted_at) VALUES($1,$2,$3,$4,$5,$5,$6,'SUBMITTED','SUCCESS',$7,$8::jsonb,$5)",
      [
        f.orderId,
        f.companyId,
        row.createdByUserId,
        row.orderNumber,
        time,
        addressId,
        f.erpId,
        JSON.stringify(f.snapshot),
      ],
    );
    await f.pool.query(
      "INSERT INTO integration_transactions(id,company_id,order_id,operation,idempotency_key,status,retryable,retry_count,request_payload,response_payload,error_code,error_message) VALUES($1,$2,$3,'ORDER_SUBMISSION',$4,'FAILED',true,7,$5::jsonb,$6::jsonb,'SYNTHETIC_CODE','PRIVATE_TECHNICAL')",
      [
        randomUUID(),
        f.companyId,
        f.orderId,
        randomUUID(),
        JSON.stringify({ private: "SYNTHETIC_REQUEST" }),
        JSON.stringify({ private: "SYNTHETIC_RESPONSE" }),
      ],
    );
  }
  f.repo =
    provider === "json"
      ? createJsonFulfillment(f.security, f.now, io)
      : createPostgresFulfillment(f.pool, f.now);
  f.actor = async (i = 0) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(i)).accessToken,
      "profile.read",
    );
  f.observation = (status) => ({
    orderId: f.orderId,
    erpOrderReference: f.erpId,
    customerReference: f.customer,
    status,
    updatedAt: new Date(f.now() - 1000).toISOString(),
  });
  f.service = (status = "CONFIRMED", repo = f.repo) =>
    createFulfillmentRefresh(
      repo,
      { read: async () => f.observation(status) },
      f.record,
      f.now,
    );
  f.refresh = (actor, status = "CONFIRMED", repo = f.repo, abort = signal()) =>
    f
      .service(status, repo)
      .refresh(actor, f.companyId, f.orderId, {}, randomUUID(), abort);
  f.rawOrder = async () =>
    provider === "json"
      ? JSON.parse(
          await fs.readFile(join(f.directory, "orders.json"), "utf8"),
        ).find((r) => r.id === f.orderId)
      : (await f.pool.query("SELECT * FROM orders WHERE id=$1", [f.orderId]))
          .rows[0];
  f.technical = async () =>
    provider === "json"
      ? await fs.readFile(
          join(f.directory, "integration_transactions.json"),
          "utf8",
        )
      : (
          await f.pool.query(
            "SELECT * FROM integration_transactions WHERE order_id=$1 ORDER BY id",
            [f.orderId],
          )
        ).rows;
  f.patchOrder = async (patch) => {
    if (provider === "json")
      await f.security.run(async () =>
        f.security.store.replace(
          "orders",
          (await f.security.store.read("orders")).map((r) =>
            r.id === f.orderId ? { ...r, ...patch } : r,
          ),
        ),
      );
    else {
      const columns = {
        status: "order_status",
        integrationStatus: "integration_status",
        erpOrderReference: "erp_order_reference",
        companyId: "company_id",
      };
      for (const [k, v] of Object.entries(patch))
        await f.pool.query(`UPDATE orders SET ${columns[k]}=$1 WHERE id=$2`, [
          v,
          f.orderId,
        ]);
    }
  };
  f.patchCompany = async (patch) => {
    if (provider === "json")
      await f.security.run(async () =>
        f.security.store.replace(
          "companies",
          (await f.security.store.read("companies")).map((c) =>
            c.id === f.companyId ? { ...c, ...patch } : c,
          ),
        ),
      );
    else {
      const columns = {
        status: "status",
        erpCustomerReference: "erp_customer_reference",
      };
      for (const [k, v] of Object.entries(patch))
        await f.pool.query(
          `UPDATE companies SET ${columns[k]}=$1 WHERE id=$2`,
          [v, f.companyId],
        );
    }
  };
  return f;
}
async function mockOrder(t, f, state = "confirmed") {
  const mock = await server(t, createMock());
  const response = await fetch(mock.url + "/mock-erp/v1/orders", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      "x-mock-erp-fulfillment-scenario": state,
    },
    body: JSON.stringify({
      portalOrderId: f.orderId,
      customerId: f.customer,
      items: [{ productId: "DEMO-P001", quantity: "1" }],
    }),
  });
  assert.equal(response.status, 201);
  const order = await response.json();
  f.erpId = order.erpOrderId;
  await f.patchOrder({ erpOrderReference: f.erpId });
  f.clock.value = Date.now() + 1000;
  return {
    ...mock,
    source: createMockFulfillmentSource(
      { baseUrl: mock.url + "/mock-erp/v1/", timeoutMs: 1000 },
      f.now,
    ),
  };
}
const path = (f) =>
  `/api/v1/admin/companies/${f.companyId}/orders/${f.orderId}/fulfillment/refresh`;
const post = (url, token, body = {}, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
const data = async (r, status = 200) => {
  assert.equal(r.status, status);
  assert.equal(r.headers.get("cache-control"), "no-store");
  return (await r.json()).data;
};
for (const provider of ["json", "postgresql"]) {
  const opts = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set disposable SQL test URL"
        : false,
  };
  test(
    provider +
      ": all three real Mock fixtures map independently of technical status and preserve every other stored field",
    opts,
    async (t) => {
      for (const [state, status, technical] of [
        ["confirmed", "CONFIRMED", "SUCCESS"],
        ["fulfilling", "FULFILLING", "FAILED"],
        ["delivered", "DELIVERED", "RETRYING"],
        ["confirmed", "CONFIRMED", "PROCESSING"],
      ])
        await t.test(state + "/" + technical, async (t) => {
          const f = await fixture(t, provider);
          await f.patchOrder({ integrationStatus: technical });
          await f.patchCompany({ status: "SUSPENDED" });
          const mock = await mockOrder(t, f, state),
            a = await f.actor(),
            before = await f.rawOrder(),
            transactions = await f.technical(),
            logs = [];
          const service = createFulfillmentRefresh(
              f.repo,
              mock.source,
              f.record,
              f.now,
            ),
            api = await server(
              t,
              createApp({
                sessions: f.auth,
                fulfillment: service,
                logger: (level, event) => logs.push({ level, event }),
              }),
            ),
            token = (await f.login()).accessToken;
          const result = await data(await post(api.url + path(f), token));
          assert.deepEqual(result, {
            orderId: f.orderId,
            companyId: f.companyId,
            status,
            changed: true,
          });
          const after = await f.rawOrder();
          if (provider === "json")
            assert.deepEqual(after, { ...before, status });
          else assert.deepEqual(after, { ...before, order_status: status });
          assert.deepEqual(await f.technical(), transactions);
          const repeat = await service.refresh(
            a,
            f.companyId,
            f.orderId,
            {},
            randomUUID(),
            signal(),
          );
          assert.equal(repeat.changed, false);
          assert.equal(repeat.status, status);
          const events =
            provider === "json"
              ? JSON.parse(
                  await fs.readFile(join(f.directory, "audit_logs.json")),
                )
              : (await f.pool.query("SELECT action,metadata FROM audit_logs"))
                  .rows;
          assert.equal(
            events.filter((e) => e.action === "order.fulfillment_updated")
              .length,
            1,
          );
          const text = JSON.stringify({ result, events, logs });
          for (const secret of [
            oldPassword,
            f.passwordHash,
            "PRIVATE_TECHNICAL",
            "SYNTHETIC_RESPONSE",
          ])
            assert.equal(text.includes(secret), false);
        });
    },
  );
  test(
    provider +
      ": monotonic skips, concurrent observations, verified equal no-op and terminal/regression guards",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        a = await f.actor();
      const outcomes = await Promise.allSettled([
        f.refresh(a, "CONFIRMED"),
        f.refresh(a, "DELIVERED"),
        f.refresh(a, "FULFILLING"),
      ]);
      assert.ok(outcomes.some((r) => r.status === "fulfilled"));
      assert.equal(
        (await f.rawOrder())[provider === "json" ? "status" : "order_status"],
        "DELIVERED",
      );
      assert.equal((await f.refresh(a, "DELIVERED")).changed, false);
      for (const status of ["CONFIRMED", "FULFILLING"])
        await assert.rejects(f.refresh(a, status), code("conflict"));
      for (const status of [
        "CANCELLED",
        "REJECTED",
        "PENDING_CUSTOMER_CONFIRMATION",
      ]) {
        await f.patchOrder({ status });
        const before = await f.rawOrder();
        await assert.rejects(f.refresh(a, "DELIVERED"), code("conflict"));
        assert.deepEqual(await f.rawOrder(), before);
      }
      assert.throws(
        () => fulfillmentTransition("DRAFT", "CONFIRMED"),
        code("conflict"),
      );
    },
  );
  test(
    provider +
      ": four-role/opaque actor, company/order correlation and strict trigger input deny before ERP I/O",
    opts,
    async (t) => {
      const f = await fixture(t, provider);
      let reads = 0;
      const service = createFulfillmentRefresh(
          f.repo,
          {
            read: async () => {
              reads++;
              return f.observation("CONFIRMED");
            },
          },
          f.record,
          f.now,
        ),
        a = await f.actor();
      for (const i of [1, 2, 3, 4, 5])
        await assert.rejects(
          service.refresh(
            await f.actor(i),
            f.companyId,
            f.orderId,
            {},
            randomUUID(),
            signal(),
          ),
          denied,
        );
      await assert.rejects(
        service.refresh(
          { ...a },
          f.companyId,
          f.orderId,
          {},
          randomUUID(),
          signal(),
        ),
        denied,
      );
      for (const body of [
        null,
        [],
        { status: "DELIVERED" },
        { erpOrderReference: f.erpId },
      ])
        await assert.rejects(
          service.refresh(
            a,
            f.companyId,
            f.orderId,
            body,
            randomUUID(),
            signal(),
          ),
          code("invalid_input"),
        );
      await assert.rejects(
        service.refresh(
          a,
          f.data.companies[1].id,
          f.orderId,
          {},
          randomUUID(),
          signal(),
        ),
        code("not_found"),
      );
      await assert.rejects(
        service.refresh(
          a,
          f.companyId,
          randomUUID(),
          {},
          randomUUID(),
          signal(),
        ),
        code("not_found"),
      );
      assert.equal(reads, 0);
      for (const patch of [
        { orderId: randomUUID() },
        { erpOrderReference: randomUUID() },
        { customerReference: "OTHER-CUSTOMER" },
        { status: "created" },
        { status: "available" },
        { updatedAt: new Date(f.now() + 1).toISOString() },
        { updatedAt: "2026-01-01" },
      ]) {
        const unsafe = createFulfillmentRefresh(
          f.repo,
          { read: async () => ({ ...f.observation("CONFIRMED"), ...patch }) },
          f.record,
          f.now,
        );
        await assert.rejects(
          unsafe.refresh(a, f.companyId, f.orderId, {}, randomUUID(), signal()),
          code("unavailable"),
        );
      }
    },
  );
  test(
    provider +
      ": post-fetch actor/correlation/terminal changes and strict expiry prevent stale publication",
    opts,
    async (t) => {
      for (const scenario of [
        "actor-inactive",
        "actor-restricted",
        "revoked",
        "expiry",
        "company-ref",
        "erp-ref",
        "cancelled",
        "abort",
      ])
        await t.test(scenario, async (t) => {
          const f = await fixture(t, provider),
            a = await f.actor(),
            entered = barrier(),
            release = barrier(),
            controller = new AbortController();
          const service = createFulfillmentRefresh(
              f.repo,
              {
                read: async () => {
                  entered.resolve();
                  await release.promise;
                  return f.observation("FULFILLING");
                },
              },
              f.record,
              f.now,
            ),
            pending = service.refresh(
              a,
              f.companyId,
              f.orderId,
              {},
              randomUUID(),
              controller.signal,
            );
          await entered.promise;
          if (scenario === "actor-inactive")
            await f.setUser({ status: "SUSPENDED" });
          if (scenario === "actor-restricted")
            await f.setUser({ mustChangePassword: true });
          if (scenario === "revoked")
            await f.sessions.revoke(a.sessionId, a.userId);
          if (scenario === "expiry")
            f.clock.value = Date.parse(a.accessExpiresAt);
          if (scenario === "company-ref")
            await f.patchCompany({ erpCustomerReference: "CHANGED-CUSTOMER" });
          if (scenario === "erp-ref")
            await f.patchOrder({ erpOrderReference: randomUUID() });
          if (scenario === "cancelled")
            await f.patchOrder({ status: "CANCELLED" });
          if (scenario === "abort") controller.abort();
          release.resolve();
          await assert.rejects(
            pending,
            ["company-ref", "erp-ref", "cancelled"].includes(scenario)
              ? code("conflict")
              : scenario === "abort"
                ? code("unavailable")
                : denied,
          );
          assert.notEqual(
            (await f.rawOrder())[
              provider === "json" ? "status" : "order_status"
            ],
            "FULFILLING",
          );
        });
    },
  );
  test(
    provider +
      ": required audit failure is unconfirmed committed status, repeat verified no-op and source failures never alter state",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        a = await f.actor();
      f.beforeAudit = async (e) => {
        if (e.action === "order.fulfillment_updated")
          throw Error("PRIVATE_AUDIT");
      };
      await assert.rejects(f.refresh(a), code("unavailable"));
      assert.equal(
        (await f.rawOrder())[provider === "json" ? "status" : "order_status"],
        "CONFIRMED",
      );
      assert.equal((await f.refresh(a)).changed, false);
      const before = await f.rawOrder();
      const service = createFulfillmentRefresh(
        f.repo,
        {
          read: async () => {
            throw Error("PRIVATE_PROVIDER_PAYLOAD");
          },
        },
        f.record,
        f.now,
      );
      await assert.rejects(
        service.refresh(a, f.companyId, f.orderId, {}, randomUUID(), signal()),
        code("unavailable"),
      );
      assert.deepEqual(await f.rawOrder(), before);
    },
  );
}

test("disconnected refreshes retain all four actual-operation slots until underlying work settles", async (t) => {
  const { default: express } = await import("express"),
    f = await fixture(t),
    token = (await f.login()).accessToken,
    entered = barrier(),
    release = barrier(),
    closed = barrier(),
    fifth = barrier();
  let started = 0,
    finished = 0,
    closes = 0;
  const service = {
    refresh: async () => {
      started++;
      if (started === 4) entered.resolve();
      if (started === 5) fifth.resolve();
      try {
        await release.promise;
        return {
          companyId: f.companyId,
          orderId: f.orderId,
          status: "CONFIRMED",
          changed: false,
        };
      } finally {
        finished++;
      }
    },
  };
  const outer = express();
  outer.use((_req, res, next) => {
    res.once("close", () => {
      if (++closes === 4) closed.resolve();
    });
    next();
  });
  outer.use(
    createApp({ sessions: f.auth, fulfillment: service, logger: () => {} }),
  );
  const api = await server(t, outer),
    controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map((c) =>
    fetch(api.url + path(f), {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: "{}",
      signal: c.signal,
    }).catch(() => null),
  );
  await entered.promise;
  for (const c of controllers) c.abort();
  await Promise.all(pending);
  await closed.promise;
  const response = post(api.url + path(f), token);
  let timer;
  const outcome = await Promise.race([
    response.then((r) => r.status),
    fifth.promise.then(() => "admitted fifth operation"),
    new Promise((r) => {
      timer = setTimeout(() => r("no bounded rejection"), 1000);
    }),
  ]);
  clearTimeout(timer);
  release.resolve();
  await response;
  for (let i = 0; i < 100 && finished < started; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(outcome, 503);
  assert.equal(started, 4);
  assert.equal(finished, 4);
  assert.equal((await post(api.url + path(f), token)).status, 200);
});

test("JSON known completed publication returns committed success for audit even when expiry/abort follows rename", async (t) => {
  for (const scenario of ["expiry", "abort"])
    await t.test(scenario, async (t) => {
      const f = await fixture(t),
        a = await f.actor(),
        controller = new AbortController(),
        io = {
          ...fs,
          rename: async (...args) => {
            await fs.rename(...args);
            if (scenario === "expiry")
              f.clock.value = Date.parse(a.accessExpiresAt);
            else controller.abort();
          },
        };
      const result = await f.refresh(
        a,
        "CONFIRMED",
        createJsonFulfillment(f.security, f.now, io),
        controller.signal,
      );
      assert.equal(result.changed, true);
      assert.equal((await f.rawOrder()).status, "CONFIRMED");
      const events = JSON.parse(
        await fs.readFile(join(f.directory, "audit_logs.json"), "utf8"),
      );
      assert.equal(
        events.filter((e) => e.action === "order.fulfillment_updated").length,
        1,
      );
    });
});

test("JSON raw private data is preserved, key order is irrelevant, and before/after-effect publication failures are explicit", async (t) => {
  for (const scenario of [
    "unknown-top",
    "unknown-nested",
    "key-order",
    "before",
    "after",
    "staged-expiry",
    "staged-abort",
  ])
    await t.test(scenario, async (t) => {
      const f = await fixture(t),
        a = await f.actor(),
        file = join(f.directory, "orders.json"),
        original = await fs.readFile(file, "utf8"),
        rows = JSON.parse(original),
        controller = new AbortController();
      if (scenario === "unknown-top")
        rows[0].futurePrivate = { retained: "PRIVATE" };
      if (scenario === "unknown-nested")
        rows.find((r) => r.id === f.orderId).submittedSnapshot.futurePrivate =
          "PRIVATE";
      if (scenario === "key-order") {
        const reverse = (v) =>
          Array.isArray(v)
            ? v.map(reverse)
            : v && typeof v === "object"
              ? Object.fromEntries(
                  Object.entries(v)
                    .reverse()
                    .map(([k, x]) => [k, reverse(x)]),
                )
              : v;
        await fs.writeFile(file, JSON.stringify(reverse(rows)));
      } else if (scenario.startsWith("unknown"))
        await fs.writeFile(file, JSON.stringify(rows));
      const before = await fs.readFile(file, "utf8"),
        io = {
          ...fs,
          open: async (...args) => {
            const h = await fs.open(...args);
            return {
              writeFile: (...x) => h.writeFile(...x),
              sync: async () => {
                await h.sync();
                if (scenario === "staged-expiry")
                  f.clock.value = Date.parse(a.accessExpiresAt);
                if (scenario === "staged-abort") controller.abort();
              },
              close: () => h.close(),
            };
          },
          rename: async (...args) => {
            if (scenario === "before") throw Error("PRIVATE_BEFORE");
            await fs.rename(...args);
            if (scenario === "after") throw Error("PRIVATE_AFTER");
          },
        };
      const repo = createJsonFulfillment(f.security, f.now, io);
      if (scenario === "key-order") {
        assert.equal((await f.refresh(a, "CONFIRMED", repo)).changed, true);
        assert.deepEqual((await f.rawOrder()).submittedSnapshot, f.snapshot);
      } else {
        await assert.rejects(
          f.refresh(a, "CONFIRMED", repo, controller.signal),
          scenario === "staged-expiry" ? denied : code("unavailable"),
        );
        if (scenario === "after")
          assert.equal((await f.rawOrder()).status, "CONFIRMED");
        else assert.equal(await fs.readFile(file, "utf8"), before);
      }
      assert.equal(
        (await fs.readdir(f.directory)).some((n) =>
          n.startsWith(".orders.fulfillment."),
        ),
        false,
      );
    });
});

test(
  "SQL real lock waits recheck actor/current linkage/expiry; update failure rolls back and integration locks do not gate business truth",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    for (const scenario of ["expiry-order", "actor-role", "company-ref"]) {
      await t.test(scenario, async (t) => {
        const f = await fixture(t, "postgresql"),
          a = await f.actor(),
          entered = barrier(),
          release = barrier(),
          blocker = await f.pool.connect();
        const source = {
            read: async () => {
              entered.resolve();
              await release.promise;
              return f.observation("FULFILLING");
            },
          },
          service = createFulfillmentRefresh(f.repo, source, f.record, f.now),
          pending = service.refresh(
            a,
            f.companyId,
            f.orderId,
            {},
            randomUUID(),
            signal(),
          );
        await entered.promise;
        await blocker.query("BEGIN");
        if (scenario === "expiry-order")
          await blocker.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE", [
            f.orderId,
          ]);
        else if (scenario === "actor-role")
          await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            a.userId,
          ]);
        else
          await blocker.query(
            "SELECT id FROM companies WHERE id=$1 FOR UPDATE",
            [f.companyId],
          );
        release.resolve();
        try {
          let waiting = false;
          for (let i = 0; i < 100; i++) {
            const q = await f.admin.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND (query LIKE '%orders%' OR query LIKE '%users%' OR query LIKE '%companies%')",
            );
            if (q.rows[0].n) {
              waiting = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.equal(waiting, true);
          if (scenario === "expiry-order")
            f.clock.value = Date.parse(a.accessExpiresAt);
          else if (scenario === "actor-role")
            await blocker.query(
              "UPDATE users SET role='SALES_STAFF' WHERE id=$1",
              [a.userId],
            );
          else
            await blocker.query(
              "UPDATE companies SET erp_customer_reference='CHANGED' WHERE id=$1",
              [f.companyId],
            );
          await blocker.query("COMMIT");
          await assert.rejects(
            pending,
            scenario === "company-ref" ? code("conflict") : denied,
          );
          assert.equal((await f.rawOrder()).order_status, "SUBMITTED");
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
      });
    }
    const f = await fixture(t, "postgresql"),
      a = await f.actor(),
      before = await f.rawOrder(),
      tech = await f.technical(),
      blocker = await f.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM integration_transactions WHERE order_id=$1 FOR UPDATE",
      [f.orderId],
    );
    let timer;
    try {
      const result = await Promise.race([
        f.refresh(a),
        new Promise((r) => {
          timer = setTimeout(() => r(null), 1000);
        }),
      ]);
      assert.equal(result?.status, "CONFIRMED");
      assert.deepEqual(await f.technical(), tech);
    } finally {
      clearTimeout(timer);
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    await f.pool.query(
      "CREATE FUNCTION refuse_fulfillment_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_ROLLBACK'; END $$",
    );
    await f.pool.query(
      "CREATE TRIGGER refuse_fulfillment_update BEFORE UPDATE OF order_status ON orders FOR EACH ROW EXECUTE FUNCTION refuse_fulfillment_update()",
    );
    await assert.rejects(f.refresh(a, "FULFILLING"), code("unavailable"));
    assert.deepEqual(await f.rawOrder(), {
      ...before,
      order_status: "CONFIRMED",
    });
    assert.deepEqual(await f.technical(), tech);
  },
);

test("strict Mock adapter bounds malformed/unknown/correlation/time/media/UTF8/size, down/redirect/stall/abort and restart", async (t) => {
  const { default: express } = await import("express"),
    f = await fixture(t),
    a = await f.actor(),
    link = await f.repo.capture(a, f.companyId, f.orderId, signal());
  let mode = "success",
    requests = 0;
  const app = express();
  app.get("/mock-erp/v1/orders/:id/fulfillment", (req, res) => {
    requests++;
    assert.equal(req.headers["x-mock-erp-scenario"], undefined);
    const wire = {
      erpOrderId: f.erpId,
      portalOrderId: f.orderId,
      customerId: f.customer,
      fulfillmentStatus: "confirmed",
      updatedAt: new Date(f.now() - 1000).toISOString(),
    };
    if (mode === "down")
      return res.status(503).json({ private: "PRIVATE_PROVIDER" });
    if (mode === "redirect") return res.redirect("/unsafe");
    if (mode === "media")
      return res.type("text/plain").send(JSON.stringify(wire));
    if (mode === "oversize")
      return res.type("application/json").send(" ".repeat(5000));
    if (mode === "utf8")
      return res.type("application/json").send(Buffer.from([0xff]));
    if (mode === "malformed") return res.type("application/json").send("{");
    if (mode === "headers") return;
    if (mode === "body") {
      res.type("application/json");
      res.write("{");
      return;
    }
    if (mode === "unknown") wire.fulfillmentStatus = "created";
    if (mode === "uppercase") wire.fulfillmentStatus = "CONFIRMED";
    if (mode === "future") wire.updatedAt = new Date(f.now() + 1).toISOString();
    if (mode === "time") wire.updatedAt = "2026-01-01";
    if (mode === "order") wire.portalOrderId = randomUUID();
    if (mode === "erp") wire.erpOrderId = randomUUID();
    if (mode === "customer") wire.customerId = "OTHER";
    if (mode === "extra") wire.private = "PRIVATE";
    if (mode === "missing") delete wire.updatedAt;
    return res.json(wire);
  });
  const api = await server(t, app),
    source = createMockFulfillmentSource(
      { baseUrl: api.url + "/mock-erp/v1/", timeoutMs: 80 },
      f.now,
    );
  for (mode of [
    "unknown",
    "uppercase",
    "future",
    "time",
    "order",
    "erp",
    "customer",
    "extra",
    "missing",
    "down",
    "redirect",
    "media",
    "oversize",
    "utf8",
    "malformed",
    "headers",
    "body",
  ]) {
    const start = Date.now();
    await assert.rejects(source.read(link, signal()), code("unavailable"));
    assert.ok(Date.now() - start < 1500);
  }
  const before = requests,
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    source.read(link, controller.signal),
    code("unavailable"),
  );
  assert.equal(requests, before);
  mode = "success";
  assert.equal((await source.read(link, signal())).status, "CONFIRMED");
  const mock = await mockOrder(t, f, "delivered");
  const old = await f.repo.capture(a, f.companyId, f.orderId, signal());
  assert.equal((await mock.source.read(old, signal())).status, "DELIVERED");
  const restarted = await server(t, createMock()),
    lost = createMockFulfillmentSource(
      { baseUrl: restarted.url + "/mock-erp/v1/", timeoutMs: 500 },
      f.now,
    );
  await assert.rejects(lost.read(old, signal()), code("unavailable"));
  assert.equal((await f.rawOrder()).status, "SUBMITTED");
});

test("HTTP bounds body/query/media/rate, denies other roles, hides failures and ignores caller Mock scenario controls", async (t) => {
  const f = await fixture(t),
    logs = [],
    service = f.service(),
    api = await server(
      t,
      createApp({
        sessions: f.auth,
        fulfillment: service,
        logger: (level, event) => logs.push({ level, event }),
      }),
    ),
    url = api.url + path(f),
    token = (await f.login()).accessToken;
  assert.equal((await post(url, null)).status, 401);
  for (const i of [1, 2, 3])
    assert.equal(
      (
        await post(
          url,
          (await f.login(i)).accessToken,
          {},
          { "x-role": "INTERNAL_ADMIN" },
        )
      ).status,
      403,
    );
  for (const suffix of ["?companyId=x", "?status=DELIVERED"])
    assert.equal((await post(url + suffix, token)).status, 400);
  assert.equal((await post(url, token, { status: "DELIVERED" })).status, 400);
  assert.equal(
    (await post(url, token, {}, { "content-type": "text/plain" })).status,
    415,
  );
  assert.equal(
    (await post(url, token, { padding: "x".repeat(2000) })).status,
    413,
  );
  const malformed = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  let limited;
  for (let i = 0; i < 5; i++) limited = await post(url, token, { x: 1 });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  const safe = await server(
    t,
    createApp({ sessions: f.auth, fulfillment: service, logger: () => {} }),
  );
  assert.equal(
    (
      await data(
        await post(
          safe.url + path(f),
          token,
          {},
          {
            "x-mock-erp-fulfillment-scenario": "delivered",
            "x-mock-erp-scenario": "unavailable",
          },
        ),
      )
    ).status,
    "CONFIRMED",
  );
  const absent = await server(
    t,
    createApp({ sessions: f.auth, logger: () => {} }),
  );
  assert.equal((await post(absent.url + path(f), token)).status, 503);
  assert.equal(JSON.stringify(logs).includes(f.passwordHash), false);
});

test(
  "real #62 SQL submission receipt maps its retained Mock fulfillment without changing dispatch evidence or snapshot",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    const { createOrderDrafts } =
        await import("../dist/services/order-drafts.js"),
      { createPostgresOrderDrafts } =
        await import("../dist/infrastructure/postgres-order-drafts.js"),
      { createMockCustomerCatalogSource } =
        await import("../dist/infrastructure/mock-customer-catalog-adapter.js"),
      { createMockSubmissionAdapter } =
        await import("../dist/infrastructure/mock-submission-adapter.js"),
      { createPostgresOrderSubmission } =
        await import("../dist/infrastructure/postgres-order-submission.js");
    const f = await fixture(t, "postgresql"),
      mock = await server(t, createMock()),
      config = { baseUrl: mock.url + "/mock-erp/v1/", timeoutMs: 5000 };
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
    for (const row of f.data.customer_product_access)
      await f.pool.query(
        "INSERT INTO customer_product_access(id,company_id,product_id,eligible) VALUES($1,$2,$3,$4)",
        [randomUUID(), row.companyId, row.productId, row.eligible],
      );
    const customer = await f.actor(2),
      source = createMockCustomerCatalogSource(config),
      drafts = createOrderDrafts(
        createPostgresOrderDrafts(f.pool, f.now),
        f.record,
        { minimum: { amount: "27.5", currency: "AED" }, source },
      );
    let draft = (
      await drafts.create(
        customer,
        { deliveryAddressId: f.snapshot.delivery.id },
        randomUUID(),
      )
    ).draft;
    draft = (
      await drafts.changeItem(
        customer,
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
    const quote = await drafts.terms(customer, draft.id, {
      version: draft.version,
    });
    draft = (
      await drafts.acknowledgeTerms(
        customer,
        draft.id,
        { version: draft.version, token: quote.token },
        randomUUID(),
      )
    ).draft;
    const submit = createPostgresOrderSubmission(
      f.pool,
      source,
      { amount: "27.5", currency: "AED" },
      createMockSubmissionAdapter(config),
    );
    await submit(customer, draft.id, "fulfillment-real-submit", {
      version: draft.version,
    });
    const before = (
        await f.pool.query("SELECT * FROM orders WHERE id=$1", [draft.id])
      ).rows[0],
      tech = (
        await f.pool.query(
          "SELECT * FROM integration_transactions WHERE order_id=$1",
          [draft.id],
        )
      ).rows;
    assert.equal(before.order_status, "SUBMITTED");
    assert.equal(before.integration_status, "SUCCESS");
    assert.equal(tech.length, 1);
    f.clock.value = Date.now() + 1000;
    const result = await createFulfillmentRefresh(
      f.repo,
      createMockFulfillmentSource(config, f.now),
      f.record,
      f.now,
    ).refresh(
      await f.actor(),
      f.companyId,
      draft.id,
      {},
      randomUUID(),
      signal(),
    );
    assert.equal(result.status, "CONFIRMED");
    const after = (
      await f.pool.query("SELECT * FROM orders WHERE id=$1", [draft.id])
    ).rows[0];
    assert.deepEqual(after, { ...before, order_status: "CONFIRMED" });
    assert.deepEqual(
      (
        await f.pool.query(
          "SELECT * FROM integration_transactions WHERE order_id=$1",
          [draft.id],
        )
      ).rows,
      tech,
    );
  },
);

test("actual API entry point composes configured nonproduction refresh and fails closed for production or absent ERP", async (t) => {
  const { spawn } = await import("node:child_process"),
    { createServer } = await import("node:net");
  for (const mode of ["configured", "production", "absent"])
    await t.test(mode, async (t) => {
      const f = await fixture(t),
        mock = await mockOrder(t, f, "confirmed"),
        token = (await f.login()).accessToken;
      const probe = createServer();
      probe.listen(0, "127.0.0.1");
      await once(probe, "listening");
      const port = probe.address().port;
      await new Promise((r) => probe.close(r));
      const env = {
        ...process.env,
        NODE_ENV: mode === "production" ? "production" : "test",
        API_HOST: "127.0.0.1",
        API_PORT: String(port),
        DATABASE_URL: "",
        JSON_DATA_DIR: f.directory,
        ERP_BASE_URL: mode === "absent" ? "" : mock.url + "/mock-erp/v1/",
        ERP_TIMEOUT_MS: mode === "absent" ? "" : "500",
        AUTH_JWT_ISSUER: "password-test",
        AUTH_JWT_AUDIENCE: "password-test",
        AUTH_JWT_ACTIVE_KID: "synthetic",
        AUTH_JWT_KEYS: JSON.stringify({
          synthetic: Buffer.alloc(32, 23).toString("base64url"),
        }),
        DEMO_MODE: "",
        DEMO_ACCOUNTS_ENABLED: "",
        SUBMISSION_MINIMUM_AMOUNT: "",
        SUBMISSION_MINIMUM_CURRENCY: "",
      };
      for (const key of [
        "DEMO_MODE",
        "DEMO_ACCOUNTS_ENABLED",
        "SUBMISSION_MINIMUM_AMOUNT",
        "SUBMISSION_MINIMUM_CURRENCY",
      ])
        delete env[key];
      const child = spawn(process.execPath, ["apps/api/dist/index.js"], {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "",
        timer;
      t.after(async () => {
        if (child.exitCode === null) {
          child.kill();
          await once(child, "exit");
        }
      });
      await new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(Error("Synthetic API startup timeout")),
          5000,
        );
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("api.started")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(Error("Synthetic API exited before listening"));
        });
      });
      const response = await post(`http://127.0.0.1:${port}` + path(f), token);
      if (mode === "configured")
        assert.equal((await data(response)).status, "CONFIRMED");
      else {
        assert.equal(response.status, 503);
        assert.equal((await f.rawOrder()).status, "SUBMITTED");
      }
      assert.equal(output.includes(f.passwordHash), false);
      assert.equal(output.includes(oldPassword), false);
    });
});
