import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createJsonOrderDrafts } from "../dist/infrastructure/json/order-drafts.js";
import { createPostgresOrderDrafts } from "../dist/infrastructure/postgres-order-drafts.js";
import { createOrderDrafts } from "../dist/services/order-drafts.js";
import { createOrderSnapshot } from "../dist/services/order-snapshot.js";
import { createApp } from "../dist/app.js";
import { createAuthorization } from "../dist/services/authorization.js";

for (const provider of ["json", "postgresql"]) {
  test(
    `${provider}: reorder atomically creates an owned draft and reports current terms and restrictions`,
    {
      skip:
        provider === "postgresql" &&
        !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
          ? "PostgreSQL URL required"
          : false,
    },
    async (t) => {
      const f = await authFixture(t, provider);
      for (let i = 0; i < f.data.users.length; i++)
        await f.setUser({ mustChangePassword: false }, i);
      const company = f.data.companies[0],
        product = f.data.products[0],
        creator = f.data.users[2],
        sourceId = randomUUID(),
        itemId = randomUUID(),
        addressId = randomUUID();
      const snapshot = createOrderSnapshot({
        orderId: sourceId,
        companyId: company.id,
        submittedAt: "2026-01-02T13:00:00.000Z",
        submittedBy: {
          id: creator.id,
          companyId: company.id,
          displayName: "Historic Buyer",
          role: "CUSTOMER_ADMIN",
        },
        delivery: {
          id: addressId,
          companyId: company.id,
          label: "Old",
          line1: "Historic street",
          contactName: null,
          contactPhone: null,
        },
        items: [
          {
            itemId,
            productId: product.id,
            sku: product.sku,
            name: product.name,
            sellingUom: "CASE",
            minimumOrderQuantity: "1",
            quantity: "2",
            unitPrice: "25",
            currency: "AED",
          },
        ],
      });
      const source = {
        id: sourceId,
        companyId: company.id,
        createdByUserId: creator.id,
        orderNumber: "OLD",
        createdAt: "2026-01-02T12:00:00.000Z",
        updatedAt: "2026-01-02T13:00:00.000Z",
        deliveryAddressId: addressId,
        items: [{ id: itemId, productId: product.id, quantity: "2" }],
        status: "SUBMITTED",
        integrationStatus: "SUCCESS",
        submittedSnapshot: snapshot,
      };
      if (provider === "json")
        await f.security.store.replace("orders", [source]);
      else {
        await f.pool.query(
          "UPDATE companies SET erp_customer_reference=$1 WHERE id=$2",
          [company.erpCustomerReference, company.id],
        );
        await f.pool.query(
          "INSERT INTO products(id,erp_product_reference,sku,name,selling_uom,minimum_order_quantity,active) VALUES($1,$2,$3,$4,$5,$6,true)",
          [
            product.id,
            product.erpProductReference,
            product.sku,
            product.name,
            product.sellingUom,
            "1",
          ],
        );
        await f.pool.query(
          "INSERT INTO customer_product_access(id,company_id,product_id,eligible) VALUES($1,$2,$3,true)",
          [randomUUID(), company.id, product.id],
        );
        await f.pool.query(
          "INSERT INTO orders(id,company_id,created_by_user_id,order_number,created_at,order_status,integration_status,order_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
          [
            source.id,
            source.companyId,
            source.createdByUserId,
            source.orderNumber,
            source.createdAt,
            source.status,
            source.integrationStatus,
            JSON.stringify(snapshot),
          ],
        );
        await f.pool.query(
          "INSERT INTO order_items(id,company_id,order_id,product_id,quantity) VALUES($1,$2,$3,$4,$5)",
          [itemId, company.id, sourceId, product.id, "2"],
        );
      }
      const catalog = {
        customers: [{ reference: company.erpCustomerReference, active: true }],
        products: [
          {
            reference: product.erpProductReference,
            sku: product.sku,
            name: product.name,
            sellingUom: "CASE",
            minimumOrderQuantity: "3",
            active: true,
            metadata: { category: null, brand: null, availableQuantity: "1" },
          },
        ],
        prices: [
          {
            productReference: product.erpProductReference,
            customerReference: company.erpCustomerReference,
            price: {
              amount: "30",
              currency: "AED",
              validFrom: null,
              validTo: null,
            },
          },
        ],
        access: [
          {
            customerReference: company.erpCustomerReference,
            productReference: product.erpProductReference,
            eligible: true,
          },
        ],
      };
      const repo =
        provider === "json"
          ? createJsonOrderDrafts(f.security, f.now)
          : createPostgresOrderDrafts(f.pool, f.now);
      const service = createOrderDrafts(repo, f.record, {
        minimum: { amount: "0", currency: "AED" },
        source: { readSnapshot: async () => catalog },
      });
      const server = createApp({
        sessions: f.auth,
        orderDrafts: service,
        logger: () => {},
      }).listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(
        () =>
          new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          }),
      );
      const base = `http://127.0.0.1:${server.address().port}/api/v1/orders/${sourceId}/reorder`;
      const admin = (await f.login(2)).accessToken,
        user = (await f.login(3)).accessToken,
        foreign = (await f.login(4)).accessToken,
        internal = (await f.login(0)).accessToken;
      const post = (token, body = {}) =>
        fetch(base, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      assert.equal((await post(foreign)).status, 404);
      assert.equal((await post(internal)).status, 403);
      assert.equal((await post(admin, { companyId: company.id })).status, 400);
      const response = await post(user);
      assert.equal(response.status, 201);
      const result = (await response.json()).data;
      assert.equal(result.draft.createdByUserId, f.data.users[3].id);
      assert.equal(result.draft.deliveryAddressId, null);
      assert.notEqual(result.draft.id, sourceId);
      assert.notEqual(result.items[0].id, itemId);
      assert.equal(result.items[0].quantity, "2");
      assert.equal(result.prices[0].current, "30");
      assert.equal(result.prices[0].changed, true);
      assert.deepEqual(result.issues.map((issue) => issue.code).sort(), [
        "BELOW_MOQ",
        "INSUFFICIENT_STOCK",
      ]);
      assert.ok(
        result.issues.every((issue) => issue.itemId === result.items[0].id),
      );
      const stored =
        provider === "json"
          ? await f.security.store.read("orders")
          : (
              await f.pool.query(
                'SELECT id,order_snapshot AS "submittedSnapshot" FROM orders WHERE company_id=$1',
                [company.id],
              )
            ).rows;
      assert.equal(stored.length, 2);
      assert.deepEqual(
        stored.find((row) => row.id === sourceId).submittedSnapshot,
        snapshot,
      );
      assert.ok(
        !stored.find((row) => row.id === result.draft.id).submittedSnapshot,
      );
      catalog.access[0].eligible = false;
      const unavailable = await post(admin);
      assert.equal(unavailable.status, 201);
      assert.equal(
        (await unavailable.json()).data.issues[0].code,
        "PRODUCT_UNAVAILABLE",
      );
      catalog.access[0].eligible = true;
      const originalPrices = catalog.prices;
      catalog.prices = [];
      catalog.products[0].metadata.availableQuantity = null;
      const missing = await post(admin);
      assert.equal(missing.status, 201);
      const missingData = (await missing.json()).data;
      assert.ok(
        missingData.issues.some((issue) => issue.code === "PRICE_UNAVAILABLE"),
      );
      assert.ok(
        missingData.issues.some((issue) => issue.code === "STOCK_UNKNOWN"),
      );
      assert.equal(missingData.prices[0].current, null);
      catalog.prices = originalPrices;
      const count = async () =>
        provider === "json"
          ? (await f.security.store.read("orders")).length
          : Number(
              (await f.pool.query("SELECT count(*) FROM orders")).rows[0].count,
            );
      const before = await count();
      if (provider === "json") {
        const failing = createJsonOrderDrafts(f.security, f.now, {
          writeOrders: async () => {
            throw new Error("synthetic publication failure");
          },
        });
        const blocked = createOrderDrafts(failing, f.record, {
          minimum: { amount: "0", currency: "AED" },
          source: { readSnapshot: async () => catalog },
        });
        const actor = await createAuthorization(
          f.auth.authenticateAccess,
        ).admit(user, "profile.read");
        await assert.rejects(
          () => blocked.reorder(actor, sourceId, {}, randomUUID()),
          (error) => error.code === "unavailable",
        );
      } else {
        await f.pool.query(
          "CREATE FUNCTION reject_reorder_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$",
        );
        await f.pool.query(
          "CREATE TRIGGER reject_reorder_item BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION reject_reorder_item()",
        );
        assert.equal((await post(user)).status, 503);
      }
      assert.equal(await count(), before);
    },
  );
}
