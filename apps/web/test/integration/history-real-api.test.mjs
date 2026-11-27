import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import {
  authFixture,
  oldPassword,
} from "../../../api/test/helpers/auth-fixture.mjs";
import { createApp } from "../../../api/dist/app.js";
import { createLogin } from "../../../api/dist/services/login.js";
import { verifyPassword } from "../../../api/dist/infrastructure/passwords.js";
import { createJsonRepositories } from "../../../api/dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../../../api/dist/infrastructure/postgres-repositories.js";
import { createOrderSnapshot } from "../../../api/dist/services/order-snapshot.js";
for (const provider of ["json", "postgresql"])
  test(
    provider +
      ": actual history client/API filters and immutable detail stay company-scoped",
    {
      skip:
        provider === "postgresql" &&
        !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
          ? "PostgreSQL required"
          : false,
    },
    async (t) => {
      const f = await authFixture(t, provider);
      for (let n = 0; n < f.data.users.length; n++)
        await f.setUser({ mustChangePassword: false }, n);
      const company = f.data.companies[0].id,
        id = randomUUID(),
        address = randomUUID(),
        item = randomUUID(),
        product = f.data.products[0];
      const snapshot = createOrderSnapshot({
        orderId: id,
        companyId: company,
        submittedAt: "2026-11-27T10:01:00.000Z",
        submittedBy: {
          id: f.data.users[2].id,
          companyId: company,
          displayName: "Historic buyer",
          role: "CUSTOMER_ADMIN",
        },
        delivery: {
          id: address,
          companyId: company,
          label: "Historic kitchen",
          line1: "Historic address",
          contactName: null,
          contactPhone: null,
        },
        items: [
          {
            itemId: item,
            productId: product.id,
            sku: product.sku,
            name: "Historical rice",
            sellingUom: product.sellingUom,
            minimumOrderQuantity: "1",
            quantity: "1",
            unitPrice: "27.500000",
            currency: "AED",
          },
        ],
      });
      if (provider === "json")
        await f.security.store.replace("orders", [
          ...f.data.orders,
          {
            id,
            companyId: company,
            orderNumber: "UI-HISTORY-001",
            createdByUserId: f.data.users[2].id,
            createdAt: "2026-11-27T10:00:00.000Z",
            updatedAt: "2026-11-27T10:01:00.000Z",
            deliveryAddressId: address,
            status: "FULFILLING",
            integrationStatus: "SUCCESS",
            items: [{ id: item, productId: product.id, quantity: "1" }],
            submittedSnapshot: snapshot,
          },
        ]);
      else {
        await f.pool.query(
          "INSERT INTO delivery_addresses(id,company_id,label,address,active,is_default) VALUES($1,$2,$3,$4,true,false)",
          [address, company, "Kitchen", '{"line1":"Current address"}'],
        );
        await f.pool.query(
          "INSERT INTO orders(id,company_id,created_by_user_id,order_number,created_at,updated_at,delivery_address_id,order_status,integration_status,order_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            id,
            company,
            f.data.users[2].id,
            "UI-HISTORY-001",
            "2026-11-27T10:00:00Z",
            "2026-11-27T10:01:00Z",
            address,
            "FULFILLING",
            "SUCCESS",
            snapshot,
          ],
        );
      }
      const http = createApp({
        sessions: f.auth,
        sessionLogin: f.auth.login,
        login: createLogin(f.authentication, verifyPassword, f.record),
        companyRepositories:
          provider === "json"
            ? createJsonRepositories(f.security.store)
            : createPostgresRepositories(f.pool),
        logger() {},
      }).listen(0, "127.0.0.1");
      await once(http, "listening");
      t.after(
        () =>
          new Promise((r) => {
            http.closeAllConnections();
            http.close(r);
          }),
      );
      const vite = await createServer({
        root: fileURLToPath(new URL("../../", import.meta.url)),
        configFile: false,
        server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      });
      t.after(() => vite.close());
      const { SessionClient } = await vite.ssrLoadModule(
          "/src/features/authentication/session.ts",
        ),
        { HistoryClient } = await vite.ssrLoadModule(
          "/src/features/order-history/api.ts",
        );
      const session = new SessionClient(
        (path, init) =>
          fetch("http://127.0.0.1:" + http.address().port + path, init),
        f.now,
      );
      await session.login(f.data.users[2].email, oldPassword);
      const client = new HistoryClient(session, session.snapshot()),
        signal = new AbortController().signal;
      const page = await client.list(
        {
          search: "HISTORY",
          status: "FULFILLING",
          from: "2026-11-27",
          to: "2026-11-27",
        },
        0,
        signal,
      );
      assert.equal(page.total, 1);
      assert.equal(page.items[0].id, id);
      const { order } = await client.find(id, signal);
      assert.equal(order.snapshot.items[0].name, "Historical rice");
      assert.equal(order.snapshot.delivery.line1, "Historic address");
      assert.equal(order.snapshot.total, "27.5");
      assert.ok(!JSON.stringify(order).includes("password"));
      await session.login(f.data.users[4].email, oldPassword);
      await assert.rejects(
        new HistoryClient(session, session.snapshot()).find(id, signal),
        { code: "not-found" },
      );
    },
  );
