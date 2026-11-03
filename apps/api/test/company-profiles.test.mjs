import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { authFixture, oldPassword } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createCompanyProfiles } from "../dist/services/company-profiles.js";
import { createJsonCompanyProfiles } from "../dist/infrastructure/json/company-profiles.js";
import { createPostgresCompanyProfiles } from "../dist/infrastructure/postgres-company-profiles.js";
import { createJsonApplications } from "../dist/infrastructure/json/applications.js";
import { createPostgresApplications } from "../dist/infrastructure/postgres-applications.js";
import { createJsonApplicationReviews } from "../dist/infrastructure/json/application-reviews.js";
import { createPostgresApplicationReviews } from "../dist/infrastructure/postgres-application-reviews.js";
import { createApplicationDecisions } from "../dist/services/application-decisions.js";
import { createApp } from "../dist/app.js";
const fields = (tradeName = "Changed trade") => ({
  tradeName,
  primaryContact: " Contact ",
  businessEmail: " UPPER@Example.test ",
  phone: " 555 ",
  billingAddress: " Billing ",
});
async function fixture(t, provider, writer) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.repo =
    provider === "json"
      ? createJsonCompanyProfiles(f.security, f.now, writer)
      : createPostgresCompanyProfiles(f.pool, f.now);
  f.service = createCompanyProfiles(f.repo);
  f.actor = async (i = 2) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(i)).accessToken,
      "profile.read",
    );
  f.ca = await f.actor();
  f.cu = await f.actor(3);
  f.ia = await f.actor(0);
  f.sales = await f.actor(1);
  f.companyId = f.data.companies[0].id;
  f.otherId = f.data.companies[1].id;
  if (provider === "json")
    await f.security.store.replace(
      "companies",
      (await f.security.store.read("companies")).map((c) =>
        c.id === f.companyId
          ? {
              ...c,
              tradeLicenseReference: "LIC-1",
              paymentTerms: "NET30",
              creditStatus: "CURRENT",
              portalProfile: {
                primaryContact: "Original",
                businessEmail: "original@example.test",
                phone: "555",
                billingAddress: "Original billing",
              },
            }
          : c,
      ),
    );
  else
    await f.pool.query(
      "UPDATE companies SET trade_license_reference='LIC-1',payment_terms='NET30',credit_status='CURRENT',contact_name='Original',contact_email='original@example.test',contact_phone='555',billing_address=$1::jsonb WHERE id=$2",
      [
        JSON.stringify({
          line1: "Original billing",
          legacyReference: "retained",
        }),
        f.companyId,
      ],
    );
  f.save = async (value = fields()) =>
    f.service.save(f.ca, {
      version: (await f.service.own(f.ca)).company.version,
      ...value,
    });
  f.assign = async (active = true) => {
    const row = {
      id: randomUUID(),
      companyId: f.companyId,
      salesStaffUserId: f.data.users[1].id,
      assignedByUserId: f.data.users[0].id,
      isPrimary: true,
      active,
      createdAt: new Date(f.now() - 1000).toISOString(),
      endedAt: active ? null : new Date(f.now()).toISOString(),
    };
    if (provider === "json")
      await fs.writeFile(
        join(f.directory, "customer_sales_assignments.json"),
        JSON.stringify([row]),
      );
    else {
      await f.pool.query(
        "DELETE FROM customer_sales_assignments WHERE company_id=$1",
        [f.companyId],
      );
      await f.pool.query(
        "INSERT INTO customer_sales_assignments(id,company_id,sales_staff_user_id,assigned_by_user_id,is_primary,active,created_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        Object.values(row),
      );
    }
  };
  return f;
}
for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "PostgreSQL URL required"
        : false,
  };
  test(
    provider +
      ": saves only five normalized portal fields, preserves readonly values, clears nullable data and reopens canonically",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        before = (await f.service.own(f.ca)).company,
        other = (await f.service.own(await f.actor(4))).company;
      const saved = (await f.save()).company;
      assert.deepEqual(saved.portal, {
        tradeName: "Changed trade",
        primaryContact: "Contact",
        businessEmail: "upper@example.test",
        phone: "555",
        billingAddress: "Billing",
      });
      assert.notEqual(saved.version, before.version);
      assert.match(saved.version, /^company-[a-f0-9]{64}$/);
      for (const key of [
        "id",
        "legalName",
        "status",
        "tradeLicenseReference",
        "commercial",
      ])
        assert.deepEqual(saved[key], before[key]);
      assert.equal(saved.commercial.paymentTerms, "NET30");
      assert.equal(saved.tradeLicenseReference, "LIC-1");
      assert.deepEqual((await f.service.own(f.cu)).company, saved);
      assert.deepEqual((await f.service.own(await f.actor(4))).company, other);
      if (provider === "postgresql")
        assert.equal(
          (
            await f.pool.query(
              "SELECT billing_address FROM companies WHERE id=$1",
              [f.companyId],
            )
          ).rows[0].billing_address.legacyReference,
          "retained",
        );
      const cleared = (
        await f.save({
          tradeName: "Changed trade",
          primaryContact: null,
          businessEmail: " ",
          phone: "",
          billingAddress: null,
        })
      ).company;
      assert.deepEqual(cleared.portal, {
        tradeName: "Changed trade",
        primaryContact: null,
        businessEmail: null,
        phone: null,
        billingAddress: null,
      });
      const reopened =
        provider === "json"
          ? createJsonCompanyProfiles(f.security, f.now)
          : createPostgresCompanyProfiles(f.pool, f.now);
      assert.deepEqual(await reopened.read(f.ca, f.companyId), cleared);
      assert.equal(JSON.stringify(cleared).includes("passwordHash"), false);
    },
  );
  test(
    provider +
      ": version race has one winner; readonly/tenant/role/invalid field changes and stale authority deny",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        version = (await f.service.own(f.ca)).company.version,
        results = await Promise.allSettled(
          ["One", "Two"].map((name) =>
            f.service.save(f.ca, { version, ...fields(name) }),
          ),
        );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.find((r) => r.status === "rejected").reason.code,
        "conflict",
      );
      for (const [key, value] of Object.entries({
        legalName: "No",
        tradeLicenseReference: "No",
        commercial: { paymentTerms: "No" },
        status: "SUSPENDED",
        companyId: f.otherId,
        role: "INTERNAL_ADMIN",
        creditLimit: "100",
      }))
        await assert.rejects(
          f.save({ ...fields(), [key]: value }),
          (e) => e.code === "invalid_input",
        );
      for (const input of [
        { ...fields(), businessEmail: "bad" },
        { ...fields(), tradeName: "" },
        { ...fields(), phone: "x".repeat(41) },
        { ...fields(), primaryContact: "bad\ncontact" },
      ])
        await assert.rejects(f.save(input), (e) => e.code === "invalid_input");
      await assert.rejects(
        f.service.save({ ...f.ca }, { version, ...fields() }),
        (e) => e.name === "AuthorizationError",
      );
      for (const actor of [f.cu, f.ia, f.sales])
        await assert.rejects(f.service.save(actor, { version, ...fields() }));
      await assert.rejects(f.service.internal(f.ca, f.companyId));
      await assert.rejects(f.service.own(f.ia));
      await f.setUser({ status: "SUSPENDED" }, 2);
      await assert.rejects(f.service.own(f.ca));
    },
  );
  test(
    provider +
      ": Sales requires current assignment and Admin retains read-only historical profile access",
    options,
    async (t) => {
      const f = await fixture(t, provider);
      await assert.rejects(f.service.internal(f.sales, f.companyId));
      await f.assign();
      assert.equal(
        (await f.service.internal(f.sales, f.companyId)).company.id,
        f.companyId,
      );
      await assert.rejects(f.service.internal(f.sales, f.otherId));
      await f.assign(false);
      await assert.rejects(f.service.internal(f.sales, f.companyId));
      if (provider === "json")
        await f.security.store.replace(
          "companies",
          (await f.security.store.read("companies")).map((c) =>
            c.id === f.companyId ? { ...c, status: "SUSPENDED" } : c,
          ),
        );
      else
        await f.pool.query(
          "UPDATE companies SET status='SUSPENDED' WHERE id=$1",
          [f.companyId],
        );
      assert.equal(
        (await f.service.internal(f.ia, f.companyId)).company.status,
        "SUSPENDED",
      );
      await assert.rejects(f.service.own(f.ca));
    },
  );
  test(
    provider +
      ": profile override preserves original application and retained approval snapshot",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        intake =
          provider === "json"
            ? createJsonApplications(
                f.directory,
                f.security.store,
                undefined,
                f.security,
              )
            : createPostgresApplications(f.pool),
        reviewRepo =
          provider === "json"
            ? createJsonApplicationReviews(f.security, f.now)
            : createPostgresApplicationReviews(f.pool, f.now),
        review = createApplicationDecisions(
          reviewRepo,
          f.record,
          async () => {},
        );
      const row = {
        companyId: randomUUID(),
        administratorUserId: randomUUID(),
        deliveryAddressId: randomUUID(),
        companyName: "Original applicant",
        tradeLicenseReference: randomUUID(),
        businessEmail: "business@example.test",
        phone: "555",
        billingAddress: "Original billing",
        deliveryAddress: "Delivery",
        administratorName: "Original contact",
        administratorEmail: randomUUID() + "@example.test",
        administratorMobile: "556",
        passwordHash: f.passwordHash,
        createdAt: new Date(f.now()).toISOString(),
      };
      await intake.submit(row);
      const pending = (await review.detail(f.ia, row.companyId)).application;
      await review.decide(
        f.ia,
        row.companyId,
        { version: pending.version, decision: "approve" },
        randomUUID(),
      );
      if (provider === "json")
        await f.security.store.replace(
          "users",
          (await f.security.store.read("users")).map((u) =>
            u.id === row.administratorUserId
              ? { ...u, mustChangePassword: false }
              : u,
          ),
        );
      else
        await f.pool.query(
          "UPDATE users SET must_change_password=false WHERE id=$1",
          [row.administratorUserId],
        );
      const login = await f.auth.login(
          { email: row.administratorEmail, password: oldPassword },
          randomUUID(),
        ),
        actor = await createAuthorization(f.auth.authenticateAccess).admit(
          login.accessToken,
          "profile.read",
        ),
        before = (await f.service.own(actor)).company;
      assert.equal(before.portal.primaryContact, row.administratorName);
      assert.equal(before.portal.billingAddress, row.billingAddress);
      await f.service.save(actor, {
        version: before.version,
        ...fields("New trading"),
      });
      const after = (await review.detail(f.ia, row.companyId)).application;
      assert.equal(after.companyName, pending.companyName);
      assert.equal(after.businessEmail, pending.businessEmail);
      assert.equal(after.billingAddress, pending.billingAddress);
      assert.equal(after.administratorEmail, pending.administratorEmail);
      if (provider === "json") {
        const company = (await f.security.store.read("companies")).find(
          (c) => c.id === row.companyId,
        );
        assert.equal(company.application.billingAddress, row.billingAddress);
        assert.equal(company.application.businessEmail, row.businessEmail);
      }
    },
  );
  test(
    provider +
      ": HTTP uses confirmed own/internal/PATCH DTOs and denies wrong roles/selectors/readonly writes",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        server = createApp({
          sessions: f.auth,
          companyProfiles: f.service,
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
      const base = "http://127.0.0.1:" + server.address().port + "/api/v1",
        token = (await f.login(2)).accessToken,
        cu = (await f.login(3)).accessToken;
      const request = (path, proof = token, body) =>
        fetch(base + path, {
          method: body === undefined ? "GET" : "PATCH",
          headers: {
            authorization: "Bearer " + proof,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const response = await request("/company-profile");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const company = (await response.json()).data.company;
      assert.equal(company.id, f.companyId);
      const body = { version: company.version, ...fields() };
      assert.equal((await request("/company-profile", cu, body)).status, 403);
      assert.equal(
        (await request("/companies/" + f.companyId + "/profile")).status,
        403,
      );
      assert.equal(
        (await request("/company-profile?companyId=" + f.otherId)).status,
        400,
      );
      assert.equal(
        (await request("/company-profile", token, { ...body, legalName: "No" }))
          .status,
        400,
      );
      const saved = await request("/company-profile", token, body);
      assert.equal(saved.status, 200);
      assert.equal(
        (await saved.json()).data.company.portal.businessEmail,
        "upper@example.test",
      );
      assert.equal(
        (await request("/company-profile", token, body)).status,
        409,
      );
      const ia = (await f.login(0)).accessToken;
      assert.equal(
        (await request("/companies/" + randomUUID() + "/profile", ia)).status,
        404,
      );
    },
  );
}
test("JSON failed publication before/after atomic company replacement retains a complete old or canonical new profile", async (t) => {
  for (const stage of ["before", "after"]) {
    let armed = false,
      security;
    const f = await fixture(t, "json", async (rows) => {
      if (armed && stage === "before") throw Error("PRIVATE");
      await security.store.replace("companies", rows);
      if (armed && stage === "after") throw Error("PRIVATE");
    });
    security = f.security;
    const before = (await f.service.own(f.ca)).company;
    armed = true;
    await assert.rejects(
      f.service.save(f.ca, { version: before.version, ...fields() }),
      (e) => e.code === "unavailable",
    );
    armed = false;
    const after = (await f.service.own(f.ca)).company;
    assert.equal(
      after.portal.tradeName,
      stage === "before" ? before.portal.tradeName : "Changed trade",
    );
    assert.deepEqual(after.commercial, before.commercial);
    assert.equal(after.legalName, before.legalName);
  }
});
test(
  "SQL update failure rolls back every portal field without changing readonly metadata",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, "postgresql");
    await f.pool.query(
      "CREATE FUNCTION reject_profile() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''synthetic failure''; END';CREATE TRIGGER reject_profile BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION reject_profile()",
    );
    const before = (await f.service.own(f.ca)).company;
    await assert.rejects(
      f.service.save(f.ca, { version: before.version, ...fields() }),
      (e) => e.code === "unavailable",
    );
    assert.deepEqual((await f.service.own(f.ca)).company, before);
  },
);
test("malformed JSON profile override is unavailable and never disclosed as a successful projection", async (t) => {
  const f = await fixture(t, "json"),
    rows = await f.security.store.read("companies");
  rows[0] = {
    ...rows[0],
    portalProfile: {
      primaryContact: 5,
      businessEmail: null,
      phone: null,
      billingAddress: null,
    },
  };
  await fs.writeFile(join(f.directory, "companies.json"), JSON.stringify(rows));
  await assert.rejects(f.service.own(f.ca), (e) => e.code === "unavailable");
});
