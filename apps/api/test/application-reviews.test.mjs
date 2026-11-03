import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createJsonApplications } from "../dist/infrastructure/json/applications.js";
import { createPostgresApplications } from "../dist/infrastructure/postgres-applications.js";
import { createJsonApplicationReviews } from "../dist/infrastructure/json/application-reviews.js";
import { createPostgresApplicationReviews } from "../dist/infrastructure/postgres-application-reviews.js";
import { createApplicationDecisions } from "../dist/services/application-decisions.js";
import { createAuthorization } from "../dist/services/authorization.js";
import { createApp } from "../dist/app.js";
const record = (hash) => ({
  companyId: randomUUID(),
  administratorUserId: randomUUID(),
  deliveryAddressId: randomUUID(),
  companyName: "Synthetic company",
  tradeLicenseReference: randomUUID(),
  businessEmail: "business@example.test",
  phone: "555",
  billingAddress: "Billing",
  deliveryAddress: "Delivery",
  administratorName: "Applicant",
  administratorEmail: randomUUID() + "@example.test",
  administratorMobile: "556",
  passwordHash: hash,
  createdAt: new Date().toISOString(),
});
async function fixture(t, provider, hook) {
  const f = await authFixture(t, provider);
  await f.setUser({ mustChangePassword: false }, 0);
  f.intake =
    provider === "json"
      ? createJsonApplications(
          f.directory,
          f.security.store,
          undefined,
          f.security,
        )
      : createPostgresApplications(f.pool);
  f.repo =
    provider === "json"
      ? createJsonApplicationReviews(f.security, f.now, hook)
      : createPostgresApplicationReviews(f.pool, f.now);
  f.events = [];
  f.notices = [];
  f.service = createApplicationDecisions(
    f.repo,
    async (e) => f.events.push(e),
    async (e) => f.notices.push(e),
  );
  f.token = (await f.login(0)).accessToken;
  f.actor = await createAuthorization(f.auth.authenticateAccess).admit(
    (await f.login(0)).accessToken,
    "applications.read",
  );
  f.application = record(f.passwordHash);
  await f.intake.submit(f.application);
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
      ": approve/reject pairs state, retains safe snapshot, replays without duplicate effects and conflicts",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        id = f.application.companyId;
      const page = await f.service.list(f.actor, 0, 20);
      assert.equal(page.total, 1);
      const original = page.items[0];
      assert.equal(original.status, "PENDING");
      assert.equal("passwordHash" in original, false);
      assert.equal("administratorUserId" in original, false);
      const cmd = { version: original.version, decision: "approve" };
      const results = await Promise.all([
        f.service.decide(f.actor, id, cmd, randomUUID()),
        f.service.decide(f.actor, id, cmd, randomUUID()),
      ]);
      for (const r of results) assert.equal(r.application.status, "APPROVED");
      assert.equal(f.events.length, 1);
      assert.equal(f.notices.length, 1);
      const detail = (await f.service.detail(f.actor, id)).application;
      assert.equal(detail.auditState, "completed");
      assert.equal(detail.notificationState, "completed");
      assert.equal((await f.service.list(f.actor, 0, 20)).total, 0);
      await assert.rejects(
        f.service.decide(
          f.actor,
          id,
          { ...cmd, decision: "reject", reason: "No" },
          randomUUID(),
        ),
        (e) => e.code === "conflict",
      );
      const account = await f.authentication.findByEmail(
        f.application.administratorEmail,
      );
      assert.equal(account.status, "ACTIVE");
      assert.equal(account.companyStatus, "ACTIVE");
      assert.equal(account.passwordHash, f.passwordHash);
      assert.equal(account.mustChangePassword, true);
      const other = record(f.passwordHash);
      await f.intake.submit(other);
      const p = (await f.service.detail(f.actor, other.companyId)).application;
      const rejected = await f.service.decide(
        f.actor,
        other.companyId,
        {
          version: p.version,
          decision: "reject",
          reason: "  Licence invalid  ",
        },
        randomUUID(),
      );
      assert.equal(rejected.application.rejectionReason, "Licence invalid");
      const rejectedAccount = await f.authentication.findByEmail(
        other.administratorEmail,
      );
      assert.equal(rejectedAccount.status, "REJECTED");
      assert.equal(rejectedAccount.companyStatus, "REJECTED");
    },
  );
  test(
    provider +
      ": effect failure retains committed outcome and is not blindly retried",
    opts,
    async (t) => {
      const f = await fixture(t, provider);
      let calls = 0;
      f.service = createApplicationDecisions(
        f.repo,
        async () => {
          calls++;
          throw Error("PRIVATE");
        },
        async () => {},
      );
      const p = (await f.service.detail(f.actor, f.application.companyId))
          .application,
        cmd = { version: p.version, decision: "approve" };
      const r = await f.service.decide(f.actor, p.companyId, cmd, randomUUID());
      assert.equal(r.application.status, "APPROVED");
      assert.equal(r.application.auditState, "unknown");
      assert.equal(r.application.notificationState, "completed");
      await f.service.decide(f.actor, p.companyId, cmd, randomUUID());
      assert.equal(calls, 1);
    },
  );
  test(
    provider +
      ": HTTP rejects other roles, selectors and invalid commands; serves canonical contracts",
    opts,
    async (t) => {
      const f = await fixture(t, provider);
      for (let i = 1; i < f.data.users.length; i++)
        await f.setUser({ mustChangePassword: false }, i);
      const server = createApp({
        sessions: f.auth,
        applicationReview: f.service,
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
        "/api/v1/admin/applications";
      const token = (await f.login(0)).accessToken;
      const get = (path, proof = token) =>
        fetch(url + path, { headers: { authorization: "Bearer " + proof } });
      for (const i of [1, 2, 3])
        assert.equal(
          (await get("", (await f.login(i)).accessToken)).status,
          403,
        );
      assert.equal((await get("?companyId=" + randomUUID())).status, 400);
      assert.equal((await get("?limit=101")).status, 400);
      assert.equal((await get("/" + randomUUID())).status, 404);
      const response = await get("");
      assert.equal(response.headers.get("cache-control"), "no-store");
      const row = (await response.json()).data.items[0];
      for (const body of [
        { version: row.version, decision: "reject", reason: "" },
        { version: row.version, decision: "approve", status: "ACTIVE" },
        { version: "bad", decision: "approve" },
      ])
        assert.equal(
          (
            await fetch(url + "/" + row.companyId + "/decision", {
              method: "POST",
              headers: {
                authorization: "Bearer " + token,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            })
          ).status,
          400,
        );
      const saved = await fetch(url + "/" + row.companyId + "/decision", {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: row.version, decision: "approve" }),
      });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json()).data.application.status, "APPROVED");
      await f.setUser({ status: "SUSPENDED" }, 0);
      await assert.rejects(f.service.detail(f.actor, row.companyId));
    },
  );
}
for (const stage of ["intent", "decision", "companies", "users"])
  test(
    "JSON restart recovers interrupted " +
      stage +
      " without credential replacement",
    async (t) => {
      let fail = true;
      const f = await fixture(t, "json", async (s) => {
        if (fail && s === stage) throw Error("PRIVATE_FAILURE");
      });
      const p = (await f.service.detail(f.actor, f.application.companyId))
        .application;
      await assert.rejects(
        f.service.decide(
          f.actor,
          p.companyId,
          { version: p.version, decision: "approve" },
          randomUUID(),
        ),
      );
      await assert.rejects(
        f.auth.authenticateAccess(f.token),
        (e) => e.code === "unavailable",
      );
      fail = false;
      const restarted = createJsonApplicationReviews(f.security, f.now);
      await restarted.recover();
      const row = await restarted.detail(f.actor, p.companyId);
      assert.equal(row.status, "APPROVED");
      const account = await f.authentication.findByEmail(
        f.application.administratorEmail,
      );
      assert.equal(account.passwordHash, f.passwordHash);
      assert.equal(account.mustChangePassword, true);
      assert.equal(account.status, "ACTIVE");
      await assert.rejects(
        fs.lstat(join(f.directory, "application_review_intent.json")),
        (e) => e.code === "ENOENT",
      );
    },
  );

test(
  "SQL failure after the company update rolls back the paired transition and decision",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, "postgresql");
    await f.pool.query(
      "CREATE FUNCTION reject_review_user() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''synthetic failure''; END'; CREATE TRIGGER reject_review_user BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION reject_review_user()",
    );
    const p = (await f.service.detail(f.actor, f.application.companyId))
      .application;
    await assert.rejects(
      f.service.decide(
        f.actor,
        p.companyId,
        { version: p.version, decision: "approve" },
        randomUUID(),
      ),
      (e) => e.code === "unavailable",
    );
    const account = await f.authentication.findByEmail(
      f.application.administratorEmail,
    );
    assert.equal(account.status, "PENDING");
    assert.equal(account.companyStatus, "PENDING");
    assert.equal(
      (await f.pool.query("SELECT count(*) FROM application_reviews")).rows[0]
        .count,
      "0",
    );
    assert.equal(f.events.length, 0);
    assert.equal(f.notices.length, 0);
  },
);
