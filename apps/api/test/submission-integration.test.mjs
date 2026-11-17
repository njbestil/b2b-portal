import test from "node:test";
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
