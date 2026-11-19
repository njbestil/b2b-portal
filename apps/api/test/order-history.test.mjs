import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { createOrderSnapshot } from "../dist/services/order-snapshot.js";
import { createApp } from "../dist/app.js";

for (const provider of ["json", "postgresql"]) {
  test(
    `${provider}: company history filters before paging and projects immutable snapshots`,
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
      const company = f.data.companies[0].id,
        foreign = f.data.companies[1].id,
        user = f.data.users[2].id;
      const orderId = randomUUID(),
        addressId = randomUUID(),
        itemId = randomUUID(),
        productId = randomUUID();
      const snapshot = createOrderSnapshot({
        orderId,
        companyId: company,
        submittedAt: "2026-01-02T13:00:00.000Z",
        submittedBy: {
          id: user,
          companyId: company,
          displayName: "Historic Buyer",
          role: "CUSTOMER_ADMIN",
        },
        delivery: {
          id: addressId,
          companyId: company,
          label: "Original",
          line1: "Historic Street",
          contactName: null,
          contactPhone: null,
        },
        items: [
          {
            itemId,
            productId,
            sku: "OLD-SKU",
            name: "Historic Product",
            sellingUom: "KG",
            minimumOrderQuantity: "0.125",
            quantity: "0.25",
            unitPrice: "19.20",
            currency: "AED",
          },
        ],
      });
      const rows = [
        {
          id: orderId,
          companyId: company,
          orderNumber: "PO-Alpha",
          createdByUserId: user,
          createdAt: "2026-01-02T12:00:00.000Z",
          status: "SUBMITTED",
          integrationStatus: "PENDING",
          deliveryAddressId: addressId,
          updatedAt: "2026-01-02T13:00:00.000Z",
          items: [{ id: itemId, productId, quantity: "0.25" }],
          submittedSnapshot: snapshot,
        },
        {
          id: randomUUID(),
          companyId: company,
          orderNumber: "PO-Beta",
          createdByUserId: user,
          createdAt: "2026-01-03T12:00:00.000Z",
          status: "DELIVERED",
          integrationStatus: "SUCCESS",
        },
        {
          id: randomUUID(),
          companyId: company,
          orderNumber: null,
          createdByUserId: user,
          createdAt: "2026-01-04T12:00:00.000Z",
          status: "DRAFT",
          integrationStatus: "NOT_SENT",
        },
        {
          id: randomUUID(),
          companyId: foreign,
          orderNumber: "PO-Foreign",
          createdByUserId: f.data.users[4].id,
          createdAt: "2026-01-05T12:00:00.000Z",
          status: "SUBMITTED",
          integrationStatus: "PENDING",
        },
      ];
      if (provider === "json") await f.security.store.replace("orders", rows);
      else
        for (const row of rows)
          await f.pool.query(
            "INSERT INTO orders(id,company_id,order_number,created_by_user_id,created_at,order_status,integration_status,order_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
            [
              row.id,
              row.companyId,
              row.orderNumber,
              row.createdByUserId,
              row.createdAt,
              row.status,
              row.integrationStatus,
              row.submittedSnapshot
                ? JSON.stringify(row.submittedSnapshot)
                : null,
            ],
          );
      const repositories =
        provider === "json"
          ? createJsonRepositories(f.security.store, () => new Date(f.now()))
          : createPostgresRepositories(f.pool, () => new Date(f.now()));
      const server = createApp({
        sessions: f.auth,
        companyRepositories: repositories,
        logger() {},
      }).listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(
        () =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          }),
      );
      const base = `http://127.0.0.1:${server.address().port}/api/v1/companies/${company}/order-history`;
      const token = (await f.login(2)).accessToken,
        userToken = (await f.login(3)).accessToken,
        foreignToken = (await f.login(4)).accessToken,
        internalToken = (await f.login(0)).accessToken;
      const get = (path = "", proof = token) =>
        fetch(base + path, { headers: { authorization: `Bearer ${proof}` } });
      const response = await get(
        "?search=alpha&status=SUBMITTED&from=2026-01-02&to=2026-01-02&limit=1",
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const list = (await response.json()).data;
      assert.equal(list.total, 1);
      assert.equal(list.items[0].id, orderId);
      assert.equal(list.items[0].integrationStatus, "PENDING");
      assert.equal("snapshot" in list.items[0], false);
      const page = (await (await get("?limit=1&offset=1")).json()).data;
      assert.equal(page.total, 2);
      assert.equal(page.items[0].id, orderId);
      const detail = await get(`/${orderId}`, userToken);
      assert.equal(detail.status, 200);
      const result = (await detail.json()).data.order;
      assert.equal(result.snapshot.items[0].name, "Historic Product");
      assert.equal(result.snapshot.items[0].quantity, "0.25");
      assert.equal(result.snapshot.total, "4.8");
      assert.equal(result.snapshot.delivery.line1, "Historic Street");
      assert.equal(result.snapshot.submittedBy.displayName, "Historic Buyer");
      assert.equal("createdByUserId" in result, false);
      if (provider === "json") {
        const users = await f.security.store.read("users");
        await f.security.store.replace(
          "users",
          users.map((u) =>
            u.id === user ? { ...u, displayName: "Current Buyer" } : u,
          ),
        );
      } else
        await f.pool.query(
          "UPDATE users SET display_name='Current Buyer' WHERE id=$1",
          [user],
        );
      const historical = (await (await get(`/${orderId}`)).json()).data.order;
      assert.equal(
        historical.snapshot.submittedBy.displayName,
        "Historic Buyer",
      );
      assert.equal(historical.snapshot.items[0].name, "Historic Product");
      const legacy = (await (await get(`/${rows[1].id}`)).json()).data.order;
      assert.equal(legacy.snapshot, null);
      assert.equal((await get(`/${rows[2].id}`)).status, 404);
      assert.equal((await get(`/${rows[3].id}`)).status, 404);
      assert.equal((await get("", foreignToken)).status, 404);
      assert.equal((await get("", internalToken)).status, 403);
      for (const q of [
        "?status=DRAFT",
        "?from=2026-02-30",
        "?from=2026-03-01&to=2026-02-01",
        "?search=x&search=y",
        "?companyId=spoof",
        "?offset=100001",
      ])
        assert.equal((await get(q)).status, 400, q);
      assert.equal((await get("?search=%27%20OR%201%3D1--")).status, 200);
      const old = await fetch(
        `http://127.0.0.1:${server.address().port}/api/v1/companies/${company}/orders`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      assert.equal(old.status, 200);
      assert.equal((await old.json()).data.total, 3);
      if (provider === "json") {
        const path = join(f.directory, "orders.json"),
          data = JSON.parse(await readFile(path, "utf8"));
        data.find((r) => r.id === orderId).submittedSnapshot.total = "999";
        await writeFile(path, JSON.stringify(data));
      } else
        await f.pool.query(
          "UPDATE orders SET order_snapshot=jsonb_set(order_snapshot,'{total}',to_jsonb('999'::text)) WHERE id=$1",
          [orderId],
        );
      const corrupted = await get(`/${orderId}`);
      assert.equal(corrupted.status, 503);
      assert.equal((await corrupted.text()).includes("Historic Street"), false);
    },
  );
}
