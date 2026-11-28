import { authFixture } from "./auth-fixture.mjs";
import { createAuthorization } from "../../dist/services/authorization.js";
import {
  createJsonCancellation,
  createJsonCancellationStatus,
} from "../../dist/infrastructure/json/cancellation.js";
import { createPostgresCancellation } from "../../dist/infrastructure/postgres-cancellation.js";
import { createPostgresCancellationStatus } from "../../dist/infrastructure/postgres-cancellation-status.js";
import { createMockCancellationAdapter } from "../../dist/infrastructure/mock-cancellation-adapter.js";
import { createJsonOrderDrafts } from "../../dist/infrastructure/json/order-drafts.js";
import { createApp as mockApp } from "../../../mock-erp/dist/app.js";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
export async function cancellationFixture(t, provider = "json", scenario) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.company = f.data.companies[0].id;
  if (provider === "postgresql")
    await f.pool.query(
      "UPDATE companies SET erp_customer_reference='DEMO-C001' WHERE id=$1",
      [f.company],
    );
  const auth = createAuthorization(f.auth.authenticateAccess);
  f.actor = async (i) =>
    auth.admit((await f.login(i)).accessToken, "profile.read");
  f.customer = await f.actor(2);
  f.buyer = await f.actor(3);
  f.sales = await f.actor(1);
  f.other = await f.actor(4);
  f.admin = await f.actor(0);
  const assignment = {
    id: randomUUID(),
    companyId: f.company,
    salesStaffUserId: f.sales.userId,
    assignedByUserId: f.admin.userId,
    isPrimary: true,
    active: true,
    createdAt: new Date(f.now() - 1000).toISOString(),
    endedAt: null,
  };
  f.assign = async (active = true) =>
    provider === "json"
      ? f.security.run(() =>
          writeFile(
            join(f.directory, "customer_sales_assignments.json"),
            JSON.stringify(active ? [assignment] : []),
          ),
        )
      : active
        ? f.pool.query(
            "INSERT INTO customer_sales_assignments(id,company_id,sales_staff_user_id,assigned_by_user_id,is_primary,active,created_at) VALUES($1,$2,$3,$4,true,true,$5)",
            [
              assignment.id,
              f.company,
              f.sales.userId,
              f.admin.userId,
              assignment.createdAt,
            ],
          )
        : f.pool.query(
            "DELETE FROM customer_sales_assignments WHERE company_id=$1",
            [f.company],
          );
  await f.assign();
  const app = express();
  app.use((req, _res, next) => {
    if (scenario) req.headers["x-mock-erp-cancellation-scenario"] = scenario;
    next();
  });
  app.use(mockApp());
  const server = app.listen(0, "127.0.0.1");
  f.server = server;
  await once(server, "listening");
  t.after(
    () =>
      new Promise((r) => {
        f.server.closeAllConnections();
        f.server.close(r);
      }),
  );
  f.base = "http://127.0.0.1:" + server.address().port + "/mock-erp/v1/";
  const gateway = createMockCancellationAdapter({
    baseUrl: f.base,
    timeoutMs: 5000,
  });
  f.restartMock = async () => {
    await new Promise((r) => {
      f.server.closeAllConnections();
      f.server.close(r);
    });
    f.server = mockApp().listen(0, "127.0.0.1");
    await once(f.server, "listening");
    return createMockCancellationAdapter({
      baseUrl: "http://127.0.0.1:" + f.server.address().port + "/mock-erp/v1/",
      timeoutMs: 5000,
    });
  };
  f.calls = 0;
  f.gateway = {
    async cancel(p) {
      f.calls++;
      return gateway.cancel(p);
    },
  };
  f.make = (g = f.gateway, options = {}, security = f.security) =>
    provider === "json"
      ? createJsonCancellation(security, g, f.now, options)
      : createPostgresCancellation(f.pool, g);
  f.cancel = f.make();
  f.status =
    provider === "json"
      ? createJsonCancellationStatus(f.security)
      : createPostgresCancellationStatus(f.pool);
  f.order = async ({
    status = "DRAFT",
    integration = "NOT_SENT",
    linked = false,
    creator = f.customer.userId,
  } = {}) => {
    const id = randomUUID();
    let erp;
    if (linked) {
      const r = await fetch(f.base + "orders", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({
          portalOrderId: id,
          customerId: "DEMO-C001",
          items: [{ productId: "DEMO-P001", quantity: "2" }],
        }),
      });
      if (r.status !== 201) throw Error("Mock fixture failed");
      erp = (await r.json()).erpOrderId;
    }
    const createdAt = new Date(f.now() - 500).toISOString();
    if (provider === "json")
      await f.security.run(async () =>
        f.security.store.replace("orders", [
          ...(await f.security.store.read("orders")),
          {
            id,
            companyId: f.company,
            createdByUserId: creator,
            createdAt,
            updatedAt: createdAt,
            deliveryAddressId: null,
            orderNumber: null,
            status,
            integrationStatus: integration,
            ...(erp ? { erpOrderReference: erp } : {}),
          },
        ]),
      );
    else
      await f.pool.query(
        "INSERT INTO orders(id,company_id,created_by_user_id,order_status,integration_status,erp_order_reference,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)",
        [id, f.company, creator, status, integration, erp ?? null, createdAt],
      );
    return { id, erp };
  };
  f.raw = async (id) =>
    provider === "json"
      ? (await f.security.store.read("orders")).find((r) => r.id === id)
      : (
          await f.pool.query(
            'SELECT order_status AS status,integration_status AS "integrationStatus" FROM orders WHERE id=$1',
            [id],
          )
        ).rows[0];
  f.ledger = async () =>
    JSON.parse(
      await readFile(join(f.directory, "order_cancellations.json"), "utf8"),
    );
  f.audits = async (id) =>
    provider === "json"
      ? JSON.parse(
          await readFile(join(f.directory, "audit_logs.json"), "utf8"),
        ).filter((r) => r.targetId === id)
      : (
          await f.pool.query(
            'SELECT action,company_id AS "companyId",actor_user_id AS "actorUserId",actor_role AS "actorRole",target_id AS "targetId",metadata FROM audit_logs WHERE target_id=$1',
            [id],
          )
        ).rows;
  if (provider === "json") f.drafts = createJsonOrderDrafts(f.security, f.now);
  return f;
}
