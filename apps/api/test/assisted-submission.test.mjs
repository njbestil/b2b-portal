import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { createTenantQueries } from "../dist/services/tenant-queries.js";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../dist/app.js";
import { assistedFixture as setup } from "./helpers/assisted-fixture.mjs";
const opts = {
  skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL && "PostgreSQL required",
};
const code = (c) => (e) => e.code === c;

test(
  "assisted: confirmed customer order uses shared transaction/dispatch, immutable Sales creator and one reservation across keys",
  opts,
  async (t) => {
    const f = await setup(t);
    const q = await f.quote();
    assert.equal(q.total, "27.5");
    assert.equal(await f.count("submission_idempotency"), 0);
    assert.equal(f.calls.length, 0);
    await Promise.all([f.send(q, "one"), f.send(q, "two"), f.send(q, "three")]);
    const row = await f.state();
    assert.equal(row.order_status, "SUBMITTED");
    assert.equal(row.integration_status, "SUCCESS");
    assert.equal(row.created_by_user_id, f.sales.userId);
    assert.equal(row.order_snapshot.submittedBy.id, f.cu.userId);
    assert.equal(f.calls.length, 1);
    assert.equal(await f.count("submission_idempotency"), 1);
    assert.equal(await f.count("integration_transactions"), 1);
    const events = (
      await f.pool.query(
        "SELECT * FROM audit_logs WHERE target_id=$1 AND action='order.submitted'",
        [f.id],
      )
    ).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].actor_user_id, f.cu.userId);
    assert.equal(
      (await f.decisions.find(f.cu, f.id)).order.status,
      "SUBMITTED",
    );
    const history = await createTenantQueries(
      createPostgresRepositories(f.pool),
    ).getOrderHistory(f.cu, f.company, f.id);
    assert.equal(history.snapshot.submittedBy.role, "CUSTOMER_USER");
    assert.equal(history.snapshot.total, q.total);
    assert.doesNotMatch(
      JSON.stringify(history),
      /confirmedByUserId|fingerprint/,
    );
    const reordered = await f.repo.reorder(
      { ...f.cu, companyId: f.company },
      f.id,
      await f.source.readSnapshot(new AbortController().signal),
    );
    assert.equal(reordered.draft.createdByUserId, f.cu.userId);
    await f.pool.query(
      "UPDATE order_confirmations SET decided_by_user_id=$1 WHERE order_id=$2",
      [f.ca.userId, f.id],
    );
    await assert.rejects(
      createTenantQueries(createPostgresRepositories(f.pool)).getOrderHistory(
        f.cu,
        f.company,
        f.id,
      ),
      code("unavailable"),
    );
    await f.pool.query(
      "UPDATE order_confirmations SET decided_by_user_id=$1 WHERE order_id=$2",
      [f.cu.userId, f.id],
    );
    await f.send(q, "four");
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.quote(), code("conflict"));
  },
);
for (const decision of [null, "REJECTED"])
  test(
    "assisted: no submission for " + (decision ?? "pending confirmation"),
    opts,
    async (t) => {
      const f = await setup(t, decision);
      await assert.rejects(f.quote(), code("conflict"));
      assert.equal(await f.count("submission_idempotency"), 0);
      assert.equal(f.calls.length, 0);
    },
  );
test(
  "assisted: actual Customer Admin approver is retained; other customers, Sales and tenants cannot submit",
  opts,
  async (t) => {
    const f = await setup(t, "CONFIRMED", 2);
    const q = await f.quote();
    await assert.rejects(f.send(q, "key", f.cu), code("conflict"));
    await assert.rejects(f.send(q, "key", f.sales), {
      name: "AuthorizationError",
    });
    await assert.rejects(f.send(q, "key", await f.actor(4)), code("not_found"));
    await f.send(q);
    assert.equal((await f.state()).order_snapshot.submittedBy.id, f.ca.userId);
  },
);
test(
  "assisted: stale quote, changed eligibility and unassigned creator fail before reservation/send",
  opts,
  async (t) => {
    const f = await setup(t);
    const q = await f.quote();
    const changed = {
      async readSnapshot(signal) {
        const s = structuredClone(await f.source.readSnapshot(signal));
        for (const p of s.prices) p.price.amount = "99";
        return s;
      },
    };
    await assert.rejects(
      f.make(changed)(f.approver, f.id, "changed", {
        confirmationId: f.confirmationId,
        quoteToken: q.token,
      }),
      code("conflict"),
    );
    await f.pool.query(
      "UPDATE customer_sales_assignments SET active=false WHERE company_id=$1",
      [f.company],
    );
    await assert.rejects(f.send(q), code("forbidden"));
    assert.equal(await f.count("submission_idempotency"), 0);
    assert.equal(f.calls.length, 0);
    assert.equal(
      (await f.state()).order_status,
      "PENDING_CUSTOMER_CONFIRMATION",
    );
  },
);
test(
  "assisted: audit publication failure rolls back order, financial snapshot, ledger and outbound request",
  opts,
  async (t) => {
    const f = await setup(t);
    const q = await f.quote();
    await f.pool.query(
      "ALTER TABLE audit_logs ADD CONSTRAINT synthetic_submission_audit_failure CHECK(action <> 'order.submitted')",
    );
    await assert.rejects(f.send(q), code("unavailable"));
    const row = await f.state();
    assert.equal(row.order_snapshot, null);
    assert.equal(row.order_status, "PENDING_CUSTOMER_CONFIRMATION");
    assert.equal(await f.count("submission_idempotency"), 0);
    assert.equal(await f.count("integration_transactions"), 0);
    assert.equal(f.calls.length, 0);
  },
);
for (const outcome of ["uncertain", "rejected", "retryable_rejection"])
  test(
    "assisted: shared retained " +
      outcome +
      " outcome does not resend on customer replay",
    opts,
    async (t) => {
      const f = await setup(t);
      let sent = 0;
      const submit = f.make(f.source, {
        async send() {
          sent++;
          return outcome === "uncertain"
            ? { outcome }
            : {
                outcome: "rejected",
                code:
                  outcome === "rejected"
                    ? "BUSINESS_REJECTED"
                    : "ERP_UNAVAILABLE",
              };
        },
      });
      const q = await submit.quote(f.approver, f.id, f.confirmationId);
      const body = { confirmationId: f.confirmationId, quoteToken: q.token };
      await submit(f.approver, f.id, "first", body);
      await submit(f.approver, f.id, "second", body);
      assert.equal(sent, 1);
      assert.equal((await f.state()).order_status, "SUBMITTED");
      assert.equal((await f.state()).integration_status, "FAILED");
      assert.equal(await f.count("integration_transactions"), 1);
    },
  );

test(
  "assisted: actual HTTP quotes are scoped, validate bodies and publish through the normal submission endpoint",
  opts,
  async (t) => {
    const f = await setup(t);
    const server = createApp({
      sessions: f.auth,
      orderSubmission: f.submit,
      customerConfirmations: f.decisions,
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () =>
        new Promise((r) => {
          server.closeAllConnections();
          server.close(r);
        }),
    );
    const url = "http://127.0.0.1:" + server.address().port;
    const token = (await f.login(3)).accessToken;
    const post = (path, body, extra = {}) =>
      fetch(url + path, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          ...extra,
        },
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await post("/api/v1/orders/" + f.id + "/submission-quote", {
          confirmationId: f.confirmationId,
          companyId: f.company,
        })
      ).status,
      400,
    );
    const response = await post(
      "/api/v1/orders/" + f.id + "/submission-quote",
      { confirmationId: f.confirmationId },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const q = (await response.json()).data;
    assert.equal(
      (
        await post(
          "/api/v1/order-drafts/" + f.id + "/submit",
          { confirmationId: f.confirmationId, quoteToken: q.token },
          { "Idempotency-Key": "customer-review" },
        )
      ).status,
      202,
    );
    assert.equal(f.calls.length, 1);
    assert.equal((await f.decisions.find(f.cu, f.id)).canSubmit, false);
  },
);

test(
  "assisted: a printable direct-draft key cannot reserve a confirmation's private identity",
  opts,
  async (t) => {
    const f = await setup(t);
    await f.submit(f.ca, f.draft.id, "assisted:" + f.confirmationId, {
      version: f.draft.version,
    });
    const q = await f.quote();
    await f.send(q);
    assert.equal(f.calls.length, 2);
    assert.equal(await f.count("submission_idempotency"), 1);
    assert.equal((await f.state()).order_status, "SUBMITTED");
  },
);
