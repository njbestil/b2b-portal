import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { businessFixture } from "./helpers/order-business-fixture.mjs";
import { createOrderDrafts } from "../dist/services/order-drafts.js";
import { createPostgresOrderSubmission } from "../dist/infrastructure/postgres-order-submission.js";
import { createMockSubmissionAdapter } from "../dist/infrastructure/mock-submission-adapter.js";
import { createOrderSnapshot } from "../dist/services/order-snapshot.js";
import { commitJsonOrderSnapshot } from "../dist/infrastructure/json/order-snapshots.js";
const opts = {
  skip:
    !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
    "Disposable PostgreSQL required",
};
async function setup(t, provider) {
  const f = await businessFixture(t, provider);
  f.catalog = await f.source.readSnapshot(new AbortController().signal);
  f.current = { readSnapshot: async () => structuredClone(f.catalog) };
  f.service = createOrderDrafts(f.repo, f.record, {
    minimum: { amount: "27.5", currency: "AED" },
    source: f.current,
  });
  f.product = () => f.catalog.products.find((p) => p.reference === "DEMO-P001");
  f.price = () =>
    f.catalog.prices.find(
      (p) =>
        p.productReference === "DEMO-P001" &&
        p.customerReference === "DEMO-C001",
    ).price;
  f.address = f.draft.deliveryAddressId;
  return f;
}
for (const provider of ["json", "postgresql"]) {
  test(
    `${provider}: composed validation uses current MOQ/stock/price/account and leaves persisted draft unchanged`,
    { skip: provider === "postgresql" ? opts.skip : false },
    async (t) => {
      const f = await setup(t, provider),
        original = structuredClone(f.catalog),
        before = await f.service.items(f.ca, f.draft.id);
      const cases = [
        {
          code: "BELOW_MOQ",
          change: () => (f.product().minimumOrderQuantity = "2"),
        },
        {
          code: "INSUFFICIENT_STOCK",
          change: () => (f.product().metadata.availableQuantity = "0"),
        },
        {
          code: "STOCK_UNKNOWN",
          change: () => (f.product().metadata.availableQuantity = null),
        },
        {
          code: "PRICE_CHANGED",
          change: () => (f.price().amount = "30.000000"),
        },
        {
          code: "PRICE_CURRENCY_MISMATCH",
          change: () => (f.price().currency = "USD"),
        },
        {
          code: "ACCOUNT_INELIGIBLE",
          change: () =>
            (f.catalog.customers.find(
              (c) => c.reference === "DEMO-C001",
            ).active = false),
        },
        {
          code: "PRODUCT_UNAVAILABLE",
          change: () => (f.product().active = false),
        },
      ];
      for (const scenario of cases) {
        f.catalog = structuredClone(original);
        scenario.change();
        const result = await f.service.validate(f.ca, f.draft.id, {
          version: f.draft.version,
        });
        assert.equal(result.valid, false, scenario.code);
        assert.ok(
          result.issues.some((i) => i.code === scenario.code),
          `${scenario.code}: ${JSON.stringify(result.issues)}`,
        );
        assert.deepEqual(await f.service.items(f.ca, f.draft.id), before);
      }
      f.catalog = original;
      assert.equal(
        (
          await f.service.validate(f.ca, f.draft.id, {
            version: f.draft.version,
          })
        ).valid,
        true,
      );
    },
  );
  test(
    `${provider}: exact fractional quantity above MOQ does not require arbitrary pack multiples`,
    { skip: provider === "postgresql" ? opts.skip : false },
    async (t) => {
      const f = await setup(t, provider),
        line = (await f.service.items(f.ca, f.draft.id)).items[0];
      f.draft = (
        await f.service.changeItem(
          f.ca,
          f.draft.id,
          line.id,
          "update",
          { version: f.draft.version, quantity: "2.750000" },
          randomUUID(),
        )
      ).draft;
      f.product().minimumOrderQuantity = "1.500000";
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
      const valid = await f.service.validate(f.ca, f.draft.id, {
        version: f.draft.version,
      });
      assert.equal(valid.valid, true);
      assert.equal(
        (await f.service.items(f.ca, f.draft.id)).items[0].quantity,
        "2.75",
      );
    },
  );
  test(
    `${provider}: address removal after acknowledgement blocks validation without changing ownership`,
    { skip: provider === "postgresql" ? opts.skip : false },
    async (t) => {
      const f = await setup(t, provider);
      if (provider === "json") {
        const path = join(f.directory, "delivery_addresses.json"),
          rows = JSON.parse(await fs.readFile(path, "utf8"));
        await fs.writeFile(
          path,
          JSON.stringify(rows.map((r) => ({ ...r, active: false }))),
        );
      } else
        await f.pool.query(
          "UPDATE delivery_addresses SET active=false WHERE id=$1",
          [f.address],
        );
      const result = await f.service.validate(f.ca, f.draft.id, {
        version: f.draft.version,
      });
      assert.equal(result.valid, false);
      assert.ok(result.issues.some((i) => i.code === "ADDRESS_UNAVAILABLE"));
      await assert.rejects(
        f.service.validate(f.cu, f.draft.id, { version: f.draft.version }),
        { code: "not_found" },
      );
    },
  );
}
test(
  "postgresql: every preflight rule prevents snapshot, reservation and ERP dispatch at submission",
  opts,
  async (t) => {
    const f = await setup(t, "postgresql"),
      original = structuredClone(f.catalog);
    let sends = 0;
    const submit = createPostgresOrderSubmission(
      f.pool,
      f.current,
      { amount: "27.5", currency: "AED" },
      {
        async send() {
          sends++;
          throw Error("must not send");
        },
      },
    );
    const cases = [
      () => (f.product().minimumOrderQuantity = "2"),
      () => (f.product().metadata.availableQuantity = "0"),
      () => (f.product().metadata.availableQuantity = null),
      () => (f.price().amount = "30"),
      () => (f.price().currency = "USD"),
      () =>
        (f.catalog.customers.find((c) => c.reference === "DEMO-C001").active =
          false),
    ];
    for (const change of cases) {
      f.catalog = structuredClone(original);
      change();
      await assert.rejects(
        submit(f.ca, f.draft.id, randomUUID(), { version: f.draft.version }),
      );
      const row = (
        await f.pool.query(
          "SELECT order_status,order_snapshot,submitted_at FROM orders WHERE id=$1",
          [f.draft.id],
        )
      ).rows[0];
      assert.deepEqual(row, {
        order_status: "DRAFT",
        order_snapshot: null,
        submitted_at: null,
      });
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
          await f.pool.query(
            "SELECT count(*)::int AS n FROM integration_transactions WHERE order_id=$1",
            [f.draft.id],
          )
        ).rows[0].n,
        0,
      );
    }
    f.catalog = original;
    await f.pool.query(
      "UPDATE delivery_addresses SET active=false WHERE id=$1",
      [f.address],
    );
    await assert.rejects(
      submit(f.ca, f.draft.id, "inactive-address", {
        version: f.draft.version,
      }),
    );
    assert.equal(sends, 0);
  },
);
test(
  "postgresql: accepted minimum value creates one immutable snapshot; replay and later reorder use separate current terms",
  opts,
  async (t) => {
    const f = await setup(t, "postgresql"),
      mock = createMockSubmissionAdapter({
        baseUrl: `http://127.0.0.1:${f.server.address().port}/mock-erp/v1/`,
        timeoutMs: 5000,
      });
    let sends = 0;
    const submit = createPostgresOrderSubmission(
        f.pool,
        f.current,
        { amount: "27.5", currency: "AED" },
        {
          async send(body) {
            sends++;
            return mock.send(body);
          },
        },
      ),
      body = { version: f.draft.version },
      key = "business-exact-minimum";
    const results = await Promise.all([
      submit(f.ca, f.draft.id, key, body),
      submit(f.ca, f.draft.id, key, body),
    ]);
    assert.deepEqual(results, [
      { orderId: f.draft.id },
      { orderId: f.draft.id },
    ]);
    assert.equal(sends, 1);
    const before = (
      await f.pool.query("SELECT order_snapshot FROM orders WHERE id=$1", [
        f.draft.id,
      ])
    ).rows[0].order_snapshot;
    assert.equal(before.total, "27.5");
    assert.equal(before.items[0].unitPrice, "27.50");
    await f.pool.query("UPDATE products SET name='Current label' WHERE id=$1", [
      f.data.products[0].id,
    ]);
    await f.pool.query("UPDATE delivery_addresses SET address=$1 WHERE id=$2", [
      '{"line1":"Current location"}',
      f.address,
    ]);
    f.price().amount = "30";
    f.product().minimumOrderQuantity = "2";
    f.product().metadata.availableQuantity = "0";
    assert.deepEqual(await submit(f.ca, f.draft.id, key, body), {
      orderId: f.draft.id,
    });
    assert.equal(sends, 1);
    await assert.rejects(submit(f.ca, f.draft.id, "other-key", body));
    const reordered = await f.service.reorder(
      f.cu,
      f.draft.id,
      {},
      randomUUID(),
    );
    assert.equal(reordered.draft.createdByUserId, f.cu.userId);
    assert.notEqual(reordered.draft.id, f.draft.id);
    assert.equal(reordered.draft.deliveryAddressId, null);
    assert.equal(reordered.items[0].quantity, "1");
    assert.equal(reordered.prices[0].current, "30");
    assert.deepEqual(reordered.issues.map((i) => i.code).sort(), [
      "BELOW_MOQ",
      "INSUFFICIENT_STOCK",
    ]);
    assert.deepEqual(
      (
        await f.pool.query("SELECT order_snapshot FROM orders WHERE id=$1", [
          f.draft.id,
        ])
      ).rows[0].order_snapshot,
      before,
    );
  },
);
test("json: component snapshot survives source changes and reorder remains a new unsent owned draft", async (t) => {
  const f = await setup(t, "json"),
    line = (await f.service.items(f.ca, f.draft.id)).items[0],
    p = f.data.products[0];
  const snapshot = createOrderSnapshot({
    orderId: f.draft.id,
    companyId: f.ca.companyId,
    submittedAt: new Date(f.now() + 1).toISOString(),
    submittedBy: {
      id: f.ca.userId,
      companyId: f.ca.companyId,
      displayName: "Historic buyer",
      role: "CUSTOMER_ADMIN",
    },
    delivery: {
      id: f.address,
      companyId: f.ca.companyId,
      label: "Historic kitchen",
      line1: "Historic location",
      contactName: null,
      contactPhone: null,
    },
    items: [
      {
        itemId: line.id,
        productId: line.productId,
        sku: p.sku,
        name: p.name,
        sellingUom: p.sellingUom,
        minimumOrderQuantity: "1",
        quantity: line.quantity,
        unitPrice: "27.50",
        currency: "AED",
      },
    ],
  });
  await commitJsonOrderSnapshot(
    f.security,
    f.draft.id,
    f.draft.version,
    async (row) => ({
      transitionedOrder: { ...row, status: "SUBMITTED" },
      snapshot,
    }),
    () => {},
  );
  f.price().amount = "30";
  f.product().minimumOrderQuantity = "2";
  f.product().metadata.availableQuantity = "0";
  const result = await f.service.reorder(f.cu, f.draft.id, {}, randomUUID());
  assert.equal(result.draft.createdByUserId, f.cu.userId);
  assert.notEqual(result.draft.id, f.draft.id);
  assert.equal(result.draft.deliveryAddressId, null);
  assert.equal(result.prices[0].current, "30");
  assert.deepEqual(result.issues.map((i) => i.code).sort(), [
    "BELOW_MOQ",
    "INSUFFICIENT_STOCK",
  ]);
  assert.deepEqual(
    (await f.security.store.read("orders")).find((o) => o.id === f.draft.id)
      .submittedSnapshot,
    snapshot,
  );
});
