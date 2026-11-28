import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createPostgresCancellation } from "../dist/infrastructure/postgres-cancellation.js";
import { createMockCancellationAdapter } from "../dist/infrastructure/mock-cancellation-adapter.js";
import { createPostgresSubmissionDispatch } from "../dist/infrastructure/postgres-submission-dispatch.js";
import { createApp as createMock } from "../../mock-erp/dist/app.js";
import { createApp } from "../dist/app.js";
import { cancellationReason } from "../dist/services/cancellation.js";
import { createIntegrationMonitor } from "../dist/services/integration-monitor.js";
import { createPostgresIntegrationMonitor } from "../dist/infrastructure/postgres-integration-monitor.js";
const opts = {
  skip:
    !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL && "PostgreSQL URL required",
};
test("cancellation reason is required, bounded and rejects controls", () => {
  assert.equal(cancellationReason("  change of plans  "), "change of plans");
  for (const value of [
    "",
    " ",
    "x".repeat(501),
    "abc\u0000def",
    "\ud800",
    null,
  ])
    assert.throws(
      () => cancellationReason(value),
      (e) => e.code === "invalid_input",
    );
});
async function fixture(t, scenario) {
  const f = await authFixture(t, "postgresql");
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.company = f.data.companies[0].id;
  await f.pool.query(
    "UPDATE companies SET erp_customer_reference='DEMO-C001' WHERE id=$1",
    [f.company],
  );
  f.actor = async (i) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(i)).accessToken,
      "orders.cancel",
    );
  f.customer = await f.actor(2);
  f.buyer = await f.actor(3);
  f.sales = await f.actor(1);
  f.other = await f.actor(4);
  const app = express();
  app.use((req, _res, next) => {
    if (scenario) req.headers["x-mock-erp-cancellation-scenario"] = scenario;
    next();
  });
  app.use(createMock());
  f.server = app.listen(0, "127.0.0.1");
  await once(f.server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        f.server.closeAllConnections();
        f.server.close(resolve);
      }),
  );
  f.base = `http://127.0.0.1:${f.server.address().port}/mock-erp/v1/`;
  f.gateway = createMockCancellationAdapter({
    baseUrl: f.base,
    timeoutMs: 4000,
  });
  f.cancel = createPostgresCancellation(f.pool, f.gateway);
  f.order = async (
    status = "DRAFT",
    integration = "NOT_SENT",
    linked = false,
  ) => {
    const id = randomUUID();
    let erp = null;
    if (linked) {
      const response = await fetch(f.base + "orders", {
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
      assert.equal(response.status, 201);
      erp = (await response.json()).erpOrderId;
    }
    await f.pool.query(
      "INSERT INTO orders(id,company_id,created_by_user_id,order_status,integration_status,erp_order_reference) VALUES($1,$2,$3,$4,$5,$6)",
      [id, f.company, f.customer.userId, status, integration, erp],
    );
    return { id, erp };
  };
  return f;
}
test(
  "monitoring a cancellation transaction preserves provider and reason privacy",
  opts,
  async (t) => {
    const f = await fixture(t),
      order = await f.order("CONFIRMED", "SUCCESS", true),
      reason = "PRIVATE CANCELLATION REASON";
    await f.cancel(
      f.customer,
      f.company,
      order.id,
      "private-cancellation-key",
      { reason },
    );
    const admin = await createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(0)).accessToken,
      "integration-transactions.read",
    );
    const monitor = createIntegrationMonitor(
      createPostgresIntegrationMonitor(f.pool),
    );
    const result = await monitor.list(
      admin,
      { orderId: order.id },
      new AbortController().signal,
    );
    assert.equal(result.total, 1);
    assert.equal(result.items[0].operation, "OTHER");
    assert.equal(result.items[0].status, "SUCCESS");
    const text = JSON.stringify(result);
    for (const secret of [
      reason,
      "private-cancellation-key",
      "DEMO-C001",
      order.erp,
    ])
      assert.equal(text.includes(secret), false);
  },
);
test(
  "PostgreSQL direct cancellation prevents a not-yet-sent submission and replays once",
  opts,
  async (t) => {
    const f = await fixture(t),
      order = await f.order("SUBMITTED", "PENDING"),
      transaction = randomUUID();
    await f.pool.query(
      "INSERT INTO integration_transactions(id,company_id,order_id,operation,idempotency_key,status) VALUES($1,$2,$3,'ORDER_SUBMISSION',$4,'PENDING')",
      [transaction, f.company, order.id, randomUUID()],
    );
    const submit = () =>
      f.cancel(f.customer, f.company, order.id, "same-key", {
        reason: " changed plan ",
      });
    const values = await Promise.all([submit(), submit()]);
    assert.deepEqual(values[0], values[1]);
    assert.equal(values[0].status, "APPROVED");
    let calls = 0;
    await createPostgresSubmissionDispatch(f.pool, {
      async send() {
        calls++;
        return { outcome: "uncertain" };
      },
    })(f.company, order.id);
    assert.equal(calls, 0);
    const row = (
      await f.pool.query(
        "SELECT order_status,integration_status FROM orders WHERE id=$1",
        [order.id],
      )
    ).rows[0];
    assert.deepEqual(row, {
      order_status: "CANCELLED",
      integration_status: "FAILED",
    });
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM order_cancellation_requests WHERE order_id=$1",
          [order.id],
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      f.cancel(f.customer, f.company, order.id, "same-key", {
        reason: "changed",
      }),
      (e) => e.code === "conflict",
    );
  },
);
test(
  "PostgreSQL authorizes only same-company customers and currently assigned Sales",
  opts,
  async (t) => {
    const f = await fixture(t),
      draft = await f.order(),
      order = await f.order("PENDING_CUSTOMER_CONFIRMATION", "NOT_SENT");
    await assert.rejects(
      f.cancel(f.buyer, f.company, draft.id, "other-draft", {
        reason: "reason",
      }),
      (e) => e.code === "not_found",
    );
    await assert.rejects(
      f.cancel(f.other, f.company, order.id, "cross", { reason: "reason" }),
    );
    await assert.rejects(
      f.cancel(f.sales, f.company, order.id, "sales", { reason: "reason" }),
      (e) => e.code === "not_found",
    );
    await f.pool.query(
      "INSERT INTO customer_sales_assignments(id,company_id,sales_staff_user_id,assigned_by_user_id,is_primary,active,created_at) VALUES($1,$2,$3,$4,true,true,$5)",
      [
        randomUUID(),
        f.company,
        f.sales.userId,
        f.data.users[0].id,
        new Date(f.now() - 1000),
      ],
    );
    assert.equal(
      (
        await f.cancel(f.sales, f.company, order.id, "sales", {
          reason: "reason",
        })
      ).status,
      "APPROVED",
    );
  },
);
test(
  "Mock approved and rejected decisions update business state and retain safe audit",
  opts,
  async (t) => {
    for (const scenario of [undefined, "rejected"]) {
      const f = await fixture(t, scenario),
        order = await f.order("CONFIRMED", "SUCCESS", true);
      const value = await f.cancel(f.customer, f.company, order.id, "erp-key", {
        reason: "synthetic reason",
      });
      assert.equal(value.status, scenario ? "REJECTED" : "APPROVED");
      const row = (
        await f.pool.query(
          "SELECT order_status,integration_status FROM orders WHERE id=$1",
          [order.id],
        )
      ).rows[0];
      assert.deepEqual(row, {
        order_status: scenario ? "CONFIRMED" : "CANCELLED",
        integration_status: "SUCCESS",
      });
      const tx = (
        await f.pool.query(
          "SELECT status,response_payload FROM integration_transactions WHERE order_id=$1 AND operation='ORDER_CANCELLATION'",
          [order.id],
        )
      ).rows[0];
      assert.equal(tx.status, "SUCCESS");
      const auditRows = (
        await f.pool.query(
          "SELECT company_id,actor_user_id,actor_role,action,target_type,target_id,metadata,created_at FROM audit_logs WHERE target_id=$1 ORDER BY action",
          [value.requestId],
        )
      ).rows;
      assert.deepEqual(
        auditRows.map((r) => r.action),
        ["order.cancellation_decided", "order.cancellation_requested"],
      );
      for (const e of auditRows) {
        assert.equal(e.company_id, f.company);
        assert.equal(e.actor_user_id, f.customer.userId);
        assert.equal(e.actor_role, "CUSTOMER_ADMIN");
        assert.equal(e.target_type, "cancellation_request");
        assert.equal(e.metadata.orderId, order.id);
        assert.equal(e.metadata.outcome, "success");
        assert.ok(e.created_at instanceof Date);
        assert.doesNotMatch(
          JSON.stringify(e),
          /synthetic reason|Simulated|password|token|payload/i,
        );
      }

      assert.ok(!JSON.stringify(tx.response_payload).includes("Simulated"));
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM audit_logs WHERE metadata->>'orderId'=$1 AND target_type='cancellation_request' AND action LIKE 'order.cancellation_%'",
            [order.id],
          )
        ).rows[0].n,
        2,
      );
    }
  },
);
test(
  "delivered, in-flight and ambiguous submission states refuse cancellation",
  opts,
  async (t) => {
    const f = await fixture(t);
    for (const [status, integration] of [
      ["DELIVERED", "SUCCESS"],
      ["SUBMITTED", "PROCESSING"],
      ["SUBMITTED", "FAILED"],
    ]) {
      const order = await f.order(status, integration);
      await assert.rejects(
        f.cancel(f.customer, f.company, order.id, randomUUID(), {
          reason: "reason",
        }),
        (e) => e.code === "conflict",
      );
    }
  },
);
test(
  "ERP unknown outcome and restart remain pending and never resend",
  opts,
  async (t) => {
    const f = await fixture(t),
      order = await f.order("CONFIRMED", "SUCCESS", true);
    let calls = 0;
    const service = createPostgresCancellation(f.pool, {
      async cancel(input) {
        calls++;
        assert.equal((await f.gateway.cancel(input)).outcome, "approved");
        return { outcome: "unknown" };
      },
    });
    const first = await service(
      f.customer,
      f.company,
      order.id,
      "uncertain-key",
      { reason: "reason" },
    );
    assert.equal(first.status, "PENDING");
    await new Promise((resolve) => {
      f.server.closeAllConnections();
      f.server.close(resolve);
    });
    f.server = createMock().listen(0, "127.0.0.1");
    await once(f.server, "listening");
    assert.deepEqual(
      await service(f.customer, f.company, order.id, "uncertain-key", {
        reason: "reason",
      }),
      first,
    );
    assert.equal(calls, 1);
    assert.equal(
      (
        await f.pool.query(
          "SELECT error_code FROM integration_transactions WHERE order_id=$1",
          [order.id],
        )
      ).rows[0].error_code,
      "OUTCOME_UNKNOWN",
    );
  },
);
test(
  "HTTP requires reason, key and auth and returns no ERP identity",
  opts,
  async (t) => {
    const f = await fixture(t),
      order = await f.order(),
      app = createApp({ sessions: f.auth, orderCancellation: f.cancel }),
      server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const url = `http://127.0.0.1:${server.address().port}/api/v1/companies/${f.company}/orders/${order.id}/cancellations`,
      token = (await f.login(2)).accessToken;
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
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
            "idempotency-key": "k",
          },
          body: JSON.stringify({ reason: " " }),
        })
      ).status,
      400,
    );
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "idempotency-key": "k",
      },
      body: JSON.stringify({ reason: "reason" }),
    });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.ok(!(await response.text()).includes("DEMO-C001"));
  },
);
test(
  "cancellation and initial ERP dispatch race cannot both send and cancel locally",
  opts,
  async (t) => {
    const f = await fixture(t),
      order = await f.order("SUBMITTED", "PENDING"),
      transaction = randomUUID();
    await f.pool.query(
      "INSERT INTO integration_transactions(id,company_id,order_id,operation,idempotency_key,status,request_payload) VALUES($1,$2,$3,'ORDER_SUBMISSION',$4,'PENDING',$5::jsonb)",
      [
        transaction,
        f.company,
        order.id,
        transaction,
        JSON.stringify({
          externalRequestReference: transaction,
          portalOrderId: order.id,
          customerId: "DEMO-C001",
          items: [],
        }),
      ],
    );
    let sends = 0;
    const dispatch = createPostgresSubmissionDispatch(f.pool, {
      async send() {
        sends++;
        return { outcome: "uncertain" };
      },
    });
    await Promise.allSettled([
      f.cancel(f.customer, f.company, order.id, "race-key", {
        reason: "reason",
      }),
      dispatch(f.company, order.id),
    ]);
    const row = (
      await f.pool.query("SELECT order_status FROM orders WHERE id=$1", [
        order.id,
      ])
    ).rows[0];
    assert.ok(
      (sends === 0 && row.order_status === "CANCELLED") ||
        (sends === 1 && row.order_status === "SUBMITTED"),
    );
  },
);
test(
  "a concurrent fulfillment change prevents a stale ERP cancellation decision from overwriting it",
  opts,
  async (t) => {
    const f = await fixture(t),
      order = await f.order("CONFIRMED", "SUCCESS", true);
    const service = createPostgresCancellation(f.pool, {
      async cancel(input) {
        const decision = await f.gateway.cancel(input);
        await f.pool.query(
          "UPDATE orders SET order_status='DELIVERED' WHERE id=$1",
          [order.id],
        );
        return decision;
      },
    });
    await assert.rejects(
      service(f.customer, f.company, order.id, "concurrent-key", {
        reason: "reason",
      }),
      (e) => e.code === "conflict",
    );
    const row = (
      await f.pool.query(
        "SELECT o.order_status,r.status,t.status AS transaction_status FROM orders o JOIN order_cancellation_requests r ON r.order_id=o.id JOIN integration_transactions t ON t.order_id=o.id WHERE o.id=$1",
        [order.id],
      )
    ).rows[0];
    assert.deepEqual(row, {
      order_status: "DELIVERED",
      status: "PENDING",
      transaction_status: "PROCESSING",
    });
  },
);
test(
  "a submission that becomes in-flight while ERP decides prevents stale cancellation publication",
  opts,
  async (t) => {
    const f = await fixture(t),
      order = await f.order("CONFIRMED", "SUCCESS", true);
    const service = createPostgresCancellation(f.pool, {
      async cancel(input) {
        const decision = await f.gateway.cancel(input);
        await f.pool.query(
          "INSERT INTO integration_transactions(id,company_id,order_id,operation,idempotency_key,status) VALUES($1,$2,$3,'ORDER_SUBMISSION',$4,'PROCESSING')",
          [randomUUID(), f.company, order.id, randomUUID()],
        );
        return decision;
      },
    });
    await assert.rejects(
      service(f.customer, f.company, order.id, "new-flight", {
        reason: "reason",
      }),
      (e) => e.code === "conflict",
    );
    const row = (
      await f.pool.query("SELECT order_status FROM orders WHERE id=$1", [
        order.id,
      ])
    ).rows[0];
    assert.equal(row.order_status, "CONFIRMED");
  },
);
test(
  "required audit failure rolls back the local cancellation",
  opts,
  async (t) => {
    const f = await fixture(t),
      order = await f.order();
    await f.pool.query(
      "ALTER TABLE audit_logs ADD CONSTRAINT reject_cancellation_audit CHECK (action <> 'order.cancellation_requested')",
    );
    await assert.rejects(
      f.cancel(f.customer, f.company, order.id, "audit-key", {
        reason: "reason",
      }),
      (e) => e.code === "unavailable",
    );
    assert.equal(
      (
        await f.pool.query("SELECT order_status FROM orders WHERE id=$1", [
          order.id,
        ])
      ).rows[0].order_status,
      "DRAFT",
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM cancellation_idempotency WHERE order_id=$1",
          [order.id],
        )
      ).rows[0].n,
      0,
    );
  },
);
test(
  "a corrupted or in-flight submission transaction cannot be cancelled as an unsubmitted order",
  opts,
  async (t) => {
    const f = await fixture(t),
      order = await f.order("DRAFT", "NOT_SENT");
    await f.pool.query(
      "INSERT INTO integration_transactions(id,company_id,order_id,operation,idempotency_key,status) VALUES($1,$2,$3,'ORDER_SUBMISSION',$4,'PROCESSING')",
      [randomUUID(), f.company, order.id, randomUUID()],
    );
    await assert.rejects(
      f.cancel(f.customer, f.company, order.id, "inconsistent-key", {
        reason: "reason",
      }),
      (e) => e.code === "conflict",
    );
    assert.equal(
      (
        await f.pool.query("SELECT order_status FROM orders WHERE id=$1", [
          order.id,
        ])
      ).rows[0].order_status,
      "DRAFT",
    );
  },
);
test(
  "legacy draft rows with submission evidence cannot be directly cancelled",
  opts,
  async (t) => {
    const f = await fixture(t);
    for (const assignment of [
      "submitted_at=clock_timestamp()",
      "order_snapshot='{}'::jsonb",
      "idempotency_key='legacy-key'",
    ]) {
      const order = await f.order();
      await f.pool.query(`UPDATE orders SET ${assignment} WHERE id=$1`, [
        order.id,
      ]);
      await assert.rejects(
        f.cancel(f.customer, f.company, order.id, randomUUID(), {
          reason: "reason",
        }),
        (e) => e.code === "conflict",
      );
      assert.equal(
        (
          await f.pool.query("SELECT order_status FROM orders WHERE id=$1", [
            order.id,
          ])
        ).rows[0].order_status,
        "DRAFT",
      );
    }
  },
);
test("the Mock adapter refuses invalid ERP identity before network I/O", async () => {
  const adapter = createMockCancellationAdapter({
    baseUrl: "http://127.0.0.1:1/mock-erp/v1/",
    timeoutMs: 1000,
  });
  assert.deepEqual(
    await adapter.cancel({
      requestId: randomUUID(),
      orderId: randomUUID(),
      erpOrderId: "../../unexpected",
      customerReference: "DEMO-C001",
      reason: "reason",
    }),
    { outcome: "unknown" },
  );
});
test(
  "a linked order cannot request ERP cancellation while its submission is still in flight",
  opts,
  async (t) => {
    const f = await fixture(t),
      order = await f.order("SUBMITTED", "SUCCESS", true);
    await f.pool.query(
      "INSERT INTO integration_transactions(id,company_id,order_id,operation,idempotency_key,status) VALUES($1,$2,$3,'ORDER_SUBMISSION',$4,'PROCESSING')",
      [randomUUID(), f.company, order.id, randomUUID()],
    );
    await assert.rejects(
      f.cancel(f.customer, f.company, order.id, "linked-inflight", {
        reason: "reason",
      }),
      (e) => e.code === "conflict",
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM order_cancellation_requests WHERE order_id=$1",
          [order.id],
        )
      ).rows[0].n,
      0,
    );
  },
);
test(
  "actor suspension while ERP responds never applies a stale decision",
  opts,
  async (t) => {
    const f = await fixture(t),
      order = await f.order("CONFIRMED", "SUCCESS", true);
    const service = createPostgresCancellation(f.pool, {
      async cancel(input) {
        const result = await f.gateway.cancel(input);
        await f.pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [
          f.customer.userId,
        ]);
        return result;
      },
    });
    await assert.rejects(
      service(f.customer, f.company, order.id, "suspended-key", {
        reason: "reason",
      }),
    );
    const row = (
      await f.pool.query(
        "SELECT o.order_status,r.status,t.status AS transaction_status FROM orders o JOIN order_cancellation_requests r ON r.order_id=o.id JOIN integration_transactions t ON t.order_id=o.id WHERE o.id=$1",
        [order.id],
      )
    ).rows[0];
    assert.deepEqual(row, {
      order_status: "CONFIRMED",
      status: "PENDING",
      transaction_status: "PROCESSING",
    });
  },
);
test(
  "missing ERP provider fails closed for linked orders without recording a request",
  opts,
  async (t) => {
    const f = await fixture(t),
      order = await f.order("CONFIRMED", "SUCCESS", true),
      service = createPostgresCancellation(f.pool);
    await assert.rejects(
      service(f.customer, f.company, order.id, "no-provider", {
        reason: "reason",
      }),
      (e) => e.code === "unavailable",
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM order_cancellation_requests WHERE order_id=$1",
          [order.id],
        )
      ).rows[0].n,
      0,
    );
  },
);
test("JSON-backed cancellation fails closed without modifying the order", async (t) => {
  const f = await authFixture(t, "json");
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  const server = createApp({ sessions: f.auth }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const company = f.data.companies[0].id,
    order = f.data.orders[0].id,
    token = (await f.login(2)).accessToken,
    before = await f.security.store.read("orders");
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/v1/companies/${company}/orders/${order}/cancellations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "idempotency-key": "json-key",
      },
      body: JSON.stringify({ reason: "reason" }),
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await f.security.store.read("orders"), before);
});
