import { createOrderSnapshot } from "../dist/services/order-snapshot.js";
import { seedJson } from "../dist/demo/seed.js";
import { provisionJsonAccounts } from "../dist/demo/accounts-json.js";
import { demoAccounts } from "../dist/demo/accounts.js";
import { createCatalogSync } from "../dist/services/catalog-sync.js";
import { createJsonCatalogCache } from "../dist/infrastructure/json/catalog-cache.js";
import { createMockCatalogSource } from "../dist/infrastructure/mock-catalog-adapter.js";
import * as fs from "node:fs/promises";
import { once } from "node:events";
import { createApp } from "../dist/app.js";
import { selectStorage } from "../dist/infrastructure/storage.js";
import { createCancellationStatus } from "../dist/services/cancellation-status.js";
import { createJsonCompanyProfiles } from "../dist/infrastructure/json/company-profiles.js";
import { createAuthorization } from "../dist/services/authorization.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cancellationFixture } from "./helpers/cancellation-fixture.mjs";
import { JsonSecurityCoordinator } from "../dist/infrastructure/json/security.js";
import { JsonFileStore } from "../dist/infrastructure/json/store.js";
import { createJsonCancellation } from "../dist/infrastructure/json/cancellation.js";
import { createJsonOrderDrafts } from "../dist/infrastructure/json/order-drafts.js";
const reason = { reason: "Synthetic private reason" };
for (const provider of ["json", "postgresql"]) {
  const opts = {
    skip:
      provider === "postgresql" &&
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "PostgreSQL required",
  };
  test(
    provider +
      ": cancellation parity enforces reason, company, draft owner, roles, assignment and delivered/in-flight rules",
    opts,
    async (t) => {
      const f = await cancellationFixture(t, provider),
        draft = await f.order();
      await assert.rejects(
        f.cancel(f.customer, f.company, draft.id, "blank", { reason: " " }),
        { code: "invalid_input" },
      );
      await assert.rejects(
        f.cancel(f.buyer, f.company, draft.id, "buyer", reason),
        { code: "not_found" },
      );
      await assert.rejects(
        f.cancel(f.other, f.company, draft.id, "other", reason),
        { code: "not_found" },
      );
      await assert.rejects(
        f.cancel(f.admin, f.company, draft.id, "admin", reason),
        { name: "AuthorizationError" },
      );
      for (const status of ["DELIVERED", "CANCELLED", "REJECTED"]) {
        const o = await f.order({
          status,
          integration: "SUCCESS",
          linked: true,
        });
        await assert.rejects(
          f.cancel(f.customer, f.company, o.id, status, reason),
          { code: "conflict" },
        );
      }
      const inFlight = await f.order({
        status: "SUBMITTED",
        integration: "PROCESSING",
        linked: true,
      });
      if (provider === "postgresql")
        await f.pool.query(
          "INSERT INTO integration_transactions(id,company_id,order_id,operation,idempotency_key,status,request_payload) VALUES($1,$2,$3,'ORDER_SUBMISSION',$4,'PROCESSING','{}')",
          [randomUUID(), f.company, inFlight.id, randomUUID()],
        );
      await assert.rejects(
        f.cancel(f.customer, f.company, inFlight.id, "flight", reason),
        { code: "conflict" },
      );
      const buyerDraft = await f.order({ creator: f.buyer.userId });
      const result = await f.cancel(
        f.buyer,
        f.company,
        buyerDraft.id,
        "buyer-own",
        reason,
      );
      assert.equal(result.status, "APPROVED");
      const salesOrder = await f.order({
        status: "PENDING_CUSTOMER_CONFIRMATION",
        creator: f.sales.userId,
      });
      assert.equal(
        (await f.cancel(f.sales, f.company, salesOrder.id, "sales", reason))
          .status,
        "APPROVED",
      );
      await f.assign(false);
      const another = await f.order({
        status: "CONFIRMED",
        integration: "SUCCESS",
        linked: true,
      });
      await assert.rejects(
        f.cancel(f.sales, f.company, another.id, "unassigned", reason),
        { code: "not_found" },
      );
      await f.setUser({ status: "SUSPENDED" }, 2);
      await assert.rejects(
        f.cancel(f.customer, f.company, draft.id, "suspended", reason),
      );
      assert.equal((await f.raw(draft.id)).status, "DRAFT");
      assert.equal(f.calls, 0);
    },
  );
  for (const scenario of [undefined, "rejected"])
    test(
      provider +
        ": actual Mock " +
        (scenario ?? "approved") +
        " cancellation retains one correlation, safe audit and replay",
      opts,
      async (t) => {
        const f = await cancellationFixture(t, provider, scenario),
          o = await f.order({
            status: "CONFIRMED",
            integration: "SUCCESS",
            linked: true,
          });
        const result = await f.cancel(
          f.customer,
          f.company,
          o.id,
          "stable",
          reason,
        );
        assert.equal(result.status, scenario ? "REJECTED" : "APPROVED");
        assert.equal(f.calls, 1);
        assert.deepEqual(
          await f.cancel(f.customer, f.company, o.id, "stable", reason),
          result,
        );
        assert.equal(f.calls, 1);
        assert.equal(
          (await f.raw(o.id)).status,
          scenario ? "CONFIRMED" : "CANCELLED",
        );
        const events = await f.audits(result.requestId);
        assert.deepEqual(events.map((r) => r.action).sort(), [
          "order.cancellation_decided",
          "order.cancellation_requested",
        ]);
        for (const e of events) {
          assert.equal(e.actorUserId, f.customer.userId);
          assert.equal(e.companyId, f.company);
          assert.equal(e.metadata.orderId, o.id);
          assert.doesNotMatch(
            JSON.stringify(e),
            /Synthetic private reason|payload|password|token/i,
          );
        }
        assert.equal(
          (await f.status.latest(f.company, o.id)).cancellation.status,
          result.status,
        );
        assert.doesNotMatch(JSON.stringify(result), /reason|erp|Hash|attempt/);
        await assert.rejects(
          f.cancel(f.customer, f.company, o.id, "stable", {
            reason: "Changed reason",
          }),
          { code: "conflict" },
        );
      },
    );
  test(
    provider +
      ": concurrent identical cancellations send once and do not create another request",
    opts,
    async (t) => {
      const f = await cancellationFixture(t, provider),
        o = await f.order({
          status: "CONFIRMED",
          integration: "SUCCESS",
          linked: true,
        });
      const rows = await Promise.all(
        Array.from({ length: 4 }, () =>
          f.cancel(f.customer, f.company, o.id, "same", reason),
        ),
      );
      assert.equal(new Set(rows.map((r) => r.requestId)).size, 1);
      assert.equal(f.calls, 1);
      assert.equal((await f.raw(o.id)).status, "CANCELLED");
    },
  );
  test(
    provider +
      ": potentially accepted unknown cancellation is never resent through a recreated gateway",
    opts,
    async (t) => {
      const f = await cancellationFixture(t, provider),
        o = await f.order({
          status: "CONFIRMED",
          integration: "SUCCESS",
          linked: true,
        });
      const lost = f.make({
        async cancel(p) {
          await f.gateway.cancel(p);
          return { outcome: "unknown" };
        },
      });
      const result = await lost(f.customer, f.company, o.id, "unknown", reason);
      assert.equal(result.status, "PENDING");
      const restartedGateway = await f.restartMock();
      let sends = 0;
      const reopened = f.make(
        {
          async cancel(request) {
            sends++;
            return restartedGateway.cancel(request);
          },
        },
        {},
        provider === "json"
          ? new JsonSecurityCoordinator(f.directory)
          : undefined,
      );
      assert.deepEqual(
        await reopened(f.customer, f.company, o.id, "unknown", reason),
        result,
      );
      assert.equal(sends, 0);
      assert.equal(f.calls, 1);
      assert.equal((await f.raw(o.id)).status, "CONFIRMED");
      assert.equal((await f.audits(result.requestId)).length, 1);
    },
  );
}
for (const stage of [
  "intent",
  "orders.json",
  "audit_logs.json",
  "order_cancellations.json",
  "complete",
])
  test(
    "JSON local cancellation recovers interruption after " +
      stage +
      " before other writers",
    async (t) => {
      const f = await cancellationFixture(t),
        o = await f.order();
      let hit = false;
      const cancel = f.make(undefined, {
        async afterPublish(phase, where) {
          if (!hit && phase === "request" && where === stage) {
            hit = true;
            throw Error("Synthetic publication interruption");
          }
        },
      });
      await assert.rejects(
        cancel(f.customer, f.company, o.id, "recover", reason),
        { code: "unavailable" },
      );
      assert.equal(hit, true);
      if (stage !== "complete")
        await assert.rejects(new JsonFileStore(f.directory).read("orders"));
      const reopened = new JsonSecurityCoordinator(f.directory);
      await reopened.run(async () => {});
      const entries = await f.ledger();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].status, "APPROVED");
      assert.equal((await f.raw(o.id)).status, "CANCELLED");
      assert.equal((await f.audits(entries[0].id)).length, 2);
      assert.equal(f.calls, 0);
      const drafts = createJsonOrderDrafts(reopened, f.now);
      await drafts.create({ ...f.customer, companyId: f.company }, null);
      assert.equal((await f.raw(o.id)).status, "CANCELLED");
      assert.deepEqual(
        (
          await createJsonCancellation(reopened, undefined, f.now)(
            f.customer,
            f.company,
            o.id,
            "recover",
            reason,
          )
        ).requestId,
        entries[0].id,
      );
      await f.record({
        companyId: f.company,
        actorUserId: f.customer.userId,
        actorRole: "CUSTOMER_ADMIN",
        action: "order.draft_updated",
        targetType: "order",
        targetId: o.id,
        metadata: { orderId: o.id, outcome: "success" },
      });
      assert.equal((await f.audits(entries[0].id)).length, 2);
    },
  );
for (const phase of ["claim", "decision"])
  test(
    "JSON " +
      phase +
      " interruption retains the one-attempt boundary across reopen",
    async (t) => {
      const f = await cancellationFixture(t),
        o = await f.order({
          status: "CONFIRMED",
          integration: "SUCCESS",
          linked: true,
        });
      let hit = false;
      const cancel = f.make(f.gateway, {
        async afterPublish(p, stage) {
          if (!hit && p === phase && stage === "intent") {
            hit = true;
            throw Error("Synthetic crash");
          }
        },
      });
      await assert.rejects(
        cancel(f.customer, f.company, o.id, "one-attempt", reason),
        { code: "unavailable" },
      );
      const reopened = new JsonSecurityCoordinator(f.directory);
      await reopened.run(async () => {});
      let sends = 0;
      const result = await createJsonCancellation(
        reopened,
        {
          async cancel() {
            sends++;
            throw Error("No repeat");
          },
        },
        f.now,
      )(f.customer, f.company, o.id, "one-attempt", reason);
      assert.equal(sends, 0);
      assert.equal(f.calls, phase === "claim" ? 0 : 1);
      assert.equal(result.status, phase === "claim" ? "PENDING" : "APPROVED");
      assert.equal(
        (await f.raw(o.id)).status,
        phase === "claim" ? "CONFIRMED" : "CANCELLED",
      );
    },
  );
test("JSON cancellation preserves private recognized order data and refuses unknown private data without rewriting", async (t) => {
  const f = await cancellationFixture(t),
    o = await f.order();
  const path = join(f.directory, "orders.json");
  let rows = JSON.parse(await readFile(path, "utf8"));
  const row = rows.find((r) => r.id === o.id);
  row.items = [
    { id: randomUUID(), productId: f.data.products[0].id, quantity: "1" },
  ];
  row.commercialBaseline = [
    {
      itemId: row.items[0].id,
      productId: row.items[0].productId,
      quantity: "1",
      amount: "27.50",
      currency: "AED",
    },
  ];
  await writeFile(path, JSON.stringify(rows));
  const privateData = structuredClone(row);
  await f.cancel(f.customer, f.company, o.id, "private", reason);
  const after = await f.raw(o.id);
  assert.deepEqual(after.items, privateData.items);
  assert.deepEqual(after.commercialBaseline, privateData.commercialBaseline);
  const other = await f.order();
  rows = JSON.parse(await readFile(path, "utf8"));
  rows.find((r) => r.id === other.id).futurePrivate = { retain: "Synthetic" };
  const original = JSON.stringify(rows);
  await writeFile(path, original);
  await assert.rejects(
    f.cancel(f.customer, f.company, other.id, "future", reason),
    { code: "unavailable" },
  );
  assert.equal(await readFile(path, "utf8"), original);
});
test("JSON pending journal rejects offline drift and blocks existing order/audit writers without data loss", async (t) => {
  const f = await cancellationFixture(t),
    o = await f.order();
  const cancel = f.make(undefined, {
    async afterPublish(_p, stage) {
      if (stage === "intent") throw Error("Stop");
    },
  });
  await assert.rejects(cancel(f.customer, f.company, o.id, "drift", reason));
  const path = join(f.directory, "orders.json"),
    raw = JSON.parse(await readFile(path, "utf8"));
  raw[0].futurePrivate = "Retain";
  const bytes = JSON.stringify(raw);
  await writeFile(path, bytes);
  await assert.rejects(
    f.drafts.create({ ...f.customer, companyId: f.company }, null),
  );
  await assert.rejects(
    f.record({
      companyId: f.company,
      actorUserId: f.customer.userId,
      actorRole: "CUSTOMER_ADMIN",
      action: "order.created",
      targetType: "order",
      targetId: o.id,
      metadata: { outcome: "success" },
    }),
  );
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.ok(
    await readFile(join(f.directory, "cancellation_publication_intent.json")),
  );
});
test("JSON actual process termination after a durable claim never repeats the outbound attempt", async (t) => {
  const f = await cancellationFixture(t),
    o = await f.order({
      status: "CONFIRMED",
      integration: "SUCCESS",
      linked: true,
    });
  const input = join(f.directory, "synthetic-crash-input.json");
  await writeFile(
    input,
    JSON.stringify({
      directory: f.directory,
      actor: {
        userId: f.customer.userId,
        sessionId: f.customer.sessionId,
        companyId: f.company,
        role: f.customer.role,
        accessExpiresAt: f.customer.accessExpiresAt,
        mustChangePassword: false,
      },
      orderId: o.id,
      companyId: f.company,
    }),
  );
  const child = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("./helpers/cancellation-crash.mjs", import.meta.url),
      ),
      input,
    ],
    { timeout: 15000, encoding: "utf8", windowsHide: true },
  );
  assert.equal(child.status, 77, child.stderr);
  const fresh = new JsonSecurityCoordinator(f.directory);
  let calls = 0;
  const result = await createJsonCancellation(
    fresh,
    {
      async cancel() {
        calls++;
        return { outcome: "unknown" };
      },
    },
    f.now,
  )(f.customer, f.company, o.id, "process-crash", reason);
  assert.equal(result.status, "PENDING");
  assert.equal(calls, 0);
  assert.equal((await f.ledger())[0].attempt.status, "PROCESSING");
});
test("JSON cancellation and draft edits serialize without reopening the cancelled order", async (t) => {
  const f = await cancellationFixture(t),
    o = await f.order();
  const actor = { ...f.customer, companyId: f.company },
    draft = await f.drafts.find(actor, o.id);
  const results = await Promise.allSettled([
    f.cancel(f.customer, f.company, o.id, "concurrent-edit", reason),
    f.drafts.update(actor, o.id, draft.version, null),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal((await f.raw(o.id)).status, "CANCELLED");
  assert.equal((await f.ledger()).length, 1);
  await assert.rejects(f.drafts.update(actor, o.id, draft.version, null), {
    code: "conflict",
  });
});

for (const timing of ["before", "after"])
  test(
    "JSON journal rename failure " +
      timing +
      " publication either leaves old state or recovers complete state",
    async (t) => {
      const f = await cancellationFixture(t),
        o = await f.order();
      let failed = false;
      const io = {
        ...fs,
        async rename(from, to) {
          if (!failed && to.endsWith("cancellation_publication_intent.json")) {
            failed = true;
            if (timing === "after") await fs.rename(from, to);
            throw Error("Synthetic rename failure");
          }
          return fs.rename(from, to);
        },
      };
      await assert.rejects(
        f.make(undefined, { io })(
          f.customer,
          f.company,
          o.id,
          "rename",
          reason,
        ),
        { code: "unavailable" },
      );
      assert.equal(failed, true);
      const security = new JsonSecurityCoordinator(f.directory);
      await security.run(async () => {});
      assert.equal(
        (await f.raw(o.id)).status,
        timing === "before" ? "DRAFT" : "CANCELLED",
      );
      const result = await createJsonCancellation(security, undefined, f.now)(
        f.customer,
        f.company,
        o.id,
        "rename",
        reason,
      );
      assert.equal(result.status, "APPROVED");
      assert.equal((await f.ledger()).length, 1);
      assert.equal((await f.audits(result.requestId)).length, 2);
    },
  );
test("JSON startup recovers a complete intent and malformed intent fails closed with safe diagnostics", async (t) => {
  const f = await cancellationFixture(t),
    o = await f.order();
  await assert.rejects(
    f.make(undefined, {
      async afterPublish(_phase, stage) {
        if (stage === "orders.json") throw Error("Interrupted");
      },
    })(f.customer, f.company, o.id, "startup", reason),
  );
  const logs = [];
  const options = {
    jsonDirectory: f.directory,
    startupTimeoutMs: 1000,
    logger(_level, row) {
      logs.push(row);
    },
  };
  const runtime = await selectStorage(options);
  assert.equal(runtime.provider, "json");
  assert.equal(await runtime.health(new AbortController().signal), true);
  assert.ok(runtime.createOrderCancellation);
  assert.equal(
    (await runtime.cancellationStatus.latest(f.company, o.id)).cancellation
      .status,
    "APPROVED",
  );
  await runtime.close();
  const path = join(f.directory, "cancellation_publication_intent.json");
  await writeFile(
    path,
    JSON.stringify({ schemaVersion: 1, files: [{ name: "../PRIVATE_PATH" }] }),
  );
  const before = await readFile(join(f.directory, "orders.json"), "utf8");
  const blocked = await selectStorage(options);
  assert.equal(await blocked.health(new AbortController().signal), false);
  assert.ok(logs.some((r) => r.event === "cancellations.recovery_failed"));
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_PATH/);
  assert.equal(
    await readFile(join(f.directory, "orders.json"), "utf8"),
    before,
  );
  await blocked.close();
});
test("JSON actual HTTP cancellation and status share the current customer authorization and safe public envelope", async (t) => {
  const f = await cancellationFixture(t),
    o = await f.order();
  const app = createApp({
    sessions: f.auth,
    orderCancellation: f.cancel,
    cancellationStatus: createCancellationStatus(
      f.status,
      createJsonCompanyProfiles(f.security),
    ),
    logger() {},
  });
  const server = app.listen(0, "127.0.0.1");
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
    "/api/v1/companies/" +
    f.company +
    "/orders/" +
    o.id +
    "/cancellations";
  const token = (await f.login(2)).accessToken;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "idempotency-key": "json-http",
    },
    body: JSON.stringify(reason),
  });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()).data;
  assert.equal(body.status, "APPROVED");
  assert.doesNotMatch(JSON.stringify(body), /reason|Hash|attempt|erp/);
  const status = await fetch(url, {
    headers: { authorization: "Bearer " + token },
  });
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json()).data.cancellation, body);
  const wrong = await fetch(url, {
    headers: { authorization: "Bearer " + (await f.login(4)).accessToken },
  });
  assert.equal(wrong.status, 404);
});
test("JSON stale sessions, expired access and company suspension reject admitted actors before publication", async (t) => {
  const f = await cancellationFixture(t),
    o = await f.order();
  const proof = await f.login(2),
    actor = await createAuthorization(f.auth.authenticateAccess).admit(
      proof.accessToken,
      "orders.cancel",
    );
  await f.auth.revoke(proof.accessToken, randomUUID());
  await assert.rejects(f.cancel(actor, f.company, o.id, "revoked", reason));
  await f.security.run(async () =>
    f.security.store.replace(
      "companies",
      (await f.security.store.read("companies")).map((c) =>
        c.id === f.company ? { ...c, status: "SUSPENDED" } : c,
      ),
    ),
  );
  await assert.rejects(
    f.cancel(f.customer, f.company, o.id, "company", reason),
  );
  await f.security.run(async () =>
    f.security.store.replace(
      "companies",
      (await f.security.store.read("companies")).map((c) =>
        c.id === f.company ? { ...c, status: "ACTIVE" } : c,
      ),
    ),
  );
  f.clock.value = Date.parse(f.customer.accessExpiresAt) + 1;
  await assert.rejects(f.cancel(f.customer, f.company, o.id, "expiry", reason));
  assert.equal((await f.raw(o.id)).status, "DRAFT");
  assert.equal(f.calls, 0);
});
test("JSON concurrent authoritative business change is retained instead of overwritten by a late ERP result", async (t) => {
  const f = await cancellationFixture(t),
    o = await f.order({
      status: "CONFIRMED",
      integration: "SUCCESS",
      linked: true,
    });
  let arrived, release;
  const entered = new Promise((r) => (arrived = r)),
    wait = new Promise((r) => (release = r));
  const cancel = f.make({
    async cancel(p) {
      arrived();
      await wait;
      return f.gateway.cancel(p);
    },
  });
  const pending = cancel(f.customer, f.company, o.id, "late", reason);
  await entered;
  await f.security.run(async () =>
    f.security.store.replace(
      "orders",
      (await f.security.store.read("orders")).map((r) =>
        r.id === o.id ? { ...r, status: "DELIVERED" } : r,
      ),
    ),
  );
  release();
  await assert.rejects(pending, { code: "conflict" });
  assert.equal((await f.raw(o.id)).status, "DELIVERED");
  assert.equal((await f.ledger())[0].attempt.status, "PROCESSING");
  const retained = await f.cancel(f.customer, f.company, o.id, "late", reason);
  assert.equal(retained.status, "PENDING");
  assert.equal(f.calls, 1);
});

test("JSON cancellation retains immutable financial snapshot, confirmed decision and private notes across later writers", async (t) => {
  const f = await cancellationFixture(t),
    o = await f.order({
      status: "CONFIRMED",
      integration: "SUCCESS",
      linked: true,
    }),
    address = randomUUID(),
    item = randomUUID();
  const snapshot = createOrderSnapshot({
    orderId: o.id,
    companyId: f.company,
    submittedAt: new Date(f.now()).toISOString(),
    submittedBy: {
      id: f.customer.userId,
      companyId: f.company,
      displayName: "Synthetic approver",
      role: "CUSTOMER_ADMIN",
    },
    delivery: {
      id: address,
      companyId: f.company,
      label: "Delivery",
      line1: "Synthetic",
      contactName: null,
      contactPhone: null,
    },
    items: [
      {
        itemId: item,
        productId: f.data.products[0].id,
        sku: "DEMO-RICE",
        name: "Synthetic rice",
        sellingUom: "Bag",
        minimumOrderQuantity: "1",
        quantity: "2",
        unitPrice: "27.5",
        currency: "AED",
      },
    ],
  });
  await f.security.run(async () =>
    f.security.store.replace(
      "orders",
      (await f.security.store.read("orders")).map((r) =>
        r.id === o.id
          ? {
              ...r,
              deliveryAddressId: address,
              items: [
                { id: item, productId: f.data.products[0].id, quantity: "2" },
              ],
              submittedSnapshot: snapshot,
            }
          : r,
      ),
    ),
  );
  const noteFile = join(f.directory, "order_internal_notes.json");
  await writeFile(noteFile, '[{"synthetic":"private notes untouched"}]');
  const noteBytes = await readFile(noteFile, "utf8");
  await f.cancel(f.customer, f.company, o.id, "snapshot", reason);
  assert.deepEqual((await f.raw(o.id)).submittedSnapshot, snapshot);
  assert.equal(await readFile(noteFile, "utf8"), noteBytes);
  const assisted = await f.order({
    status: "PENDING_CUSTOMER_CONFIRMATION",
    creator: f.sales.userId,
  });
  const confirmation = {
    id: randomUUID(),
    companyId: f.company,
    orderId: assisted.id,
    customerUserId: f.buyer.userId,
    status: "CONFIRMED",
    createdAt: new Date(f.now() - 300).toISOString(),
    fingerprint: "a".repeat(64),
    decidedByUserId: f.buyer.userId,
    decidedAt: new Date(f.now() - 100).toISOString(),
    reason: null,
  };
  await f.security.run(async () =>
    f.security.store.replace(
      "orders",
      (await f.security.store.read("orders")).map((r) =>
        r.id === assisted.id ? { ...r, confirmation } : r,
      ),
    ),
  );
  await f.cancel(f.sales, f.company, assisted.id, "confirmed-private", reason);
  await f.drafts.create({ ...f.customer, companyId: f.company }, null);
  assert.deepEqual((await f.raw(assisted.id)).confirmation, confirmation);
  assert.deepEqual((await f.raw(o.id)).submittedSnapshot, snapshot);
  assert.equal(await readFile(noteFile, "utf8"), noteBytes);
});
test("JSON offline account/catalog writers preserve the cancellation ledger and explicit disposable reset clears it", async (t) => {
  const f = await cancellationFixture(t),
    o = await f.order();
  await f.cancel(f.customer, f.company, o.id, "offline-preserve", reason);
  const target = "b2b_demo_cancellation_195",
    directory = join(f.directory, target);
  await seedJson(directory, { mode: "seed", confirmTarget: target });
  for (const name of ["order_cancellations.json", "audit_logs.json"])
    await fs.copyFile(join(f.directory, name), join(directory, name));
  const store = new JsonFileStore(directory);
  await store.replace("orders", [
    ...(await store.read("orders")),
    await f.raw(o.id),
  ]);
  const before = await readFile(
    join(directory, "order_cancellations.json"),
    "utf8",
  );
  const secrets = Object.fromEntries(
    demoAccounts.map((a) => [a.secret, "SyntheticDemoAccount195A1!"]),
  );
  await provisionJsonAccounts(directory, target, "all", secrets, true);
  assert.equal(
    await readFile(join(directory, "order_cancellations.json"), "utf8"),
    before,
  );
  await createCatalogSync(
    createMockCatalogSource({ baseUrl: f.base, timeoutMs: 5000 }),
    createJsonCatalogCache(directory, target, true),
    randomUUID,
  ).synchronize(new AbortController().signal);
  assert.equal(
    await readFile(join(directory, "order_cancellations.json"), "utf8"),
    before,
  );
  assert.equal(
    (await store.read("orders")).find((r) => r.id === o.id).status,
    "CANCELLED",
  );
  await writeFile(
    join(directory, "cancellation_publication_intent.json"),
    "{}",
  );
  await assert.rejects(
    provisionJsonAccounts(directory, target, "all", secrets, true),
  );
  await assert.rejects(
    seedJson(directory, { mode: "reset", confirmTarget: target }),
  );
  await fs.unlink(join(directory, "cancellation_publication_intent.json"));
  await seedJson(directory, { mode: "reset", confirmTarget: target });
  await assert.rejects(readFile(join(directory, "order_cancellations.json")), {
    code: "ENOENT",
  });
});
