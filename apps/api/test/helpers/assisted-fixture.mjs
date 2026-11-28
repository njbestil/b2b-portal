import { randomUUID } from "node:crypto";
import { businessFixture } from "./order-business-fixture.mjs";
import { createSalesDrafts } from "../../dist/services/order-drafts.js";
import { createConfirmationRequests } from "../../dist/services/confirmation-requests.js";
import { createPostgresConfirmationRequests } from "../../dist/infrastructure/postgres-confirmation-requests.js";
import { createCustomerConfirmations } from "../../dist/services/customer-confirmations.js";
import { createPostgresCustomerConfirmations } from "../../dist/infrastructure/postgres-customer-confirmations.js";
import { createPostgresOrderSubmission } from "../../dist/infrastructure/postgres-order-submission.js";
import { createMockSubmissionAdapter } from "../../dist/infrastructure/mock-submission-adapter.js";
export async function assistedFixture(t, decision = "CONFIRMED", approver = 3) {
  const f = await businessFixture(t, "postgresql");
  f.company = f.data.companies[0].id;
  f.sales = await f.actor(1);
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
  const sales = createSalesDrafts(f.repo, f.record)(f.company);
  let draft = (
    await sales.create(
      f.sales,
      { deliveryAddressId: f.draft.deliveryAddressId },
      randomUUID(),
    )
  ).draft;
  draft = (
    await sales.changeItem(
      f.sales,
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
  f.id = draft.id;
  const requests = createConfirmationRequests(
    createPostgresConfirmationRequests(f.pool, f.now),
    f.record,
  );
  const requested = await requests.request(
    f.sales,
    f.company,
    f.id,
    randomUUID(),
    { version: draft.version, customerUserId: f.cu.userId },
    randomUUID(),
  );
  f.confirmationId = requested.confirmation.id;
  f.decisions = createCustomerConfirmations(
    createPostgresCustomerConfirmations(f.pool, f.now),
    f.record,
  );
  f.approver = approver === 3 ? f.cu : f.ca;
  if (decision)
    await f.decisions.decide(
      f.approver,
      f.id,
      {
        confirmationId: f.confirmationId,
        decision,
        reason: decision === "REJECTED" ? "Synthetic rejection" : null,
      },
      randomUUID(),
    );
  const mock = createMockSubmissionAdapter({
    baseUrl: "http://127.0.0.1:" + f.server.address().port + "/mock-erp/v1/",
    timeoutMs: 5000,
  });
  f.calls = [];
  f.gateway = {
    async send(body) {
      f.calls.push(body);
      return mock.send(body);
    },
  };
  f.make = (source = f.source, gateway = f.gateway) =>
    createPostgresOrderSubmission(
      f.pool,
      source,
      { amount: "27.5", currency: "AED" },
      gateway,
    );
  f.submit = f.make();
  f.quote = () => f.submit.quote(f.approver, f.id, f.confirmationId);
  f.send = (q, key = randomUUID(), actor = f.approver) =>
    f.submit(actor, f.id, key, {
      confirmationId: f.confirmationId,
      quoteToken: q.token,
    });
  f.state = async () =>
    (await f.pool.query("SELECT * FROM orders WHERE id=$1", [f.id])).rows[0];
  f.count = async (table) =>
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM " + table + " WHERE order_id=$1",
        [f.id],
      )
    ).rows[0].n;
  return f;
}
