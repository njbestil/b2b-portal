import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SessionClient } from "../src/features/authentication/session.ts";
let server,
  CompanyClient,
  companyProfile,
  profileInput,
  profileErrors,
  companyHttpAdapter,
  CompanyView,
  CompanySections,
  companyAccess,
  App;
const id = "12345678-1234-4234-8234-123456789abc",
  other = "22345678-1234-4234-8234-123456789abc";
const identity = {
  companyId: id,
  role: "CUSTOMER_ADMIN",
  mustChangePassword: false,
};
// Explicit test-only projection, not production company/commercial data.
const profile = {
  id,
  version: "v1",
  legalName: "Synthetic Company LLC",
  status: "ACTIVE",
  tradeLicenseReference: "TEST-LICENCE",
  portal: {
    tradeName: "Synthetic Trading",
    primaryContact: "Synthetic Contact",
    businessEmail: "contact@example.test",
    phone: "555",
    billingAddress: "Synthetic billing",
  },
  commercial: {
    erpCustomerReference: "ERP-SYNTHETIC",
    paymentTerms: "Synthetic terms",
    creditStatus: "Synthetic credit",
  },
};
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  ({
    CompanyClient,
    companyProfile,
    profileInput,
    profileErrors,
    companyHttpAdapter,
  } = await server.ssrLoadModule("/src/features/company-profile/api.ts"));
  ({ CompanyView, CompanySections } = await server.ssrLoadModule(
    "/src/features/company-profile/CompanyPage.tsx",
  ));
  ({ companyAccess } = await server.ssrLoadModule(
    "/src/shared/company-scope.ts",
  ));
  ({ App } = await server.ssrLoadModule("/src/app.tsx"));
});
after(async () => server?.close());
const signal = () => new AbortController().signal;
const render = (component, props, path = "/company") =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(component, props),
    ),
  );
test("company access derives own scope; customers cannot select a foreign company and internal visibility is view-only", () => {
  assert.deepEqual(companyAccess(identity).scope, { kind: "own" });
  assert.throws(() => companyAccess(identity, other), { code: "forbidden" });
  assert.throws(
    () => companyAccess({ ...identity, mustChangePassword: true }),
    { code: "forbidden" },
  );
  assert.equal(
    companyAccess({ ...identity, role: "CUSTOMER_USER" }).canEdit,
    false,
  );
  for (const role of ["INTERNAL_ADMIN", "SALES_STAFF"]) {
    const access = companyAccess(
      { companyId: null, role, mustChangePassword: false },
      other,
    );
    assert.deepEqual(access.scope, { kind: "internal", companyId: other });
    assert.equal(access.canEdit, false);
    assert.throws(
      () => companyAccess({ companyId: null, role, mustChangePassword: false }),
      { code: "forbidden" },
    );
  }
});
test("projection whitelists portal/commercial values without passwords or invented credit limits", () => {
  const data = companyProfile({
    ...profile,
    passwordHash: "DO_NOT_PROJECT",
    creditLimit: "150000",
    commercial: { ...profile.commercial, credentials: "DO_NOT_PROJECT" },
  });
  assert.equal(data.passwordHash, undefined);
  assert.equal(data.creditLimit, undefined);
  assert.equal(data.commercial.credentials, undefined);
  const unknown = companyProfile({
    ...profile,
    commercial: undefined,
    portal: { tradeName: "Synthetic" },
  });
  assert.equal(unknown.commercial.creditStatus, null);
  assert.equal(unknown.portal.businessEmail, null);
});
test("profile validation supports explicit clearing of optional contact fields and rejects ERP/identity/status writes", () => {
  const cleared = profileInput({
    tradeName: " Trading ",
    primaryContact: "",
    businessEmail: "",
    phone: "",
    billingAddress: "",
  });
  assert.deepEqual(cleared, {
    tradeName: "Trading",
    businessEmail: null,
    phone: null,
    primaryContact: null,
    billingAddress: null,
  });
  for (const extra of [
    "legalName",
    "tradeLicenseReference",
    "erpCustomerReference",
    "creditStatus",
    "creditLimit",
    "companyId",
    "status",
  ])
    assert.throws(
      () => profileInput({ ...profile.portal, [extra]: "forged" }),
      { code: "invalid" },
    );
  const errors = profileErrors({
    ...profile.portal,
    tradeName: " ",
    businessEmail: "invalid",
    phone: "x".repeat(41),
  });
  assert.ok(errors.tradeName);
  assert.ok(errors.businessEmail);
  assert.ok(errors.phone);
});
test("Customer Admin saves only allowed portal fields/version and uses the canonical response", async () => {
  let call;
  const client = new CompanyClient(identity, {
    async save(scope, input) {
      call = { scope, input };
      return {
        ...profile,
        version: "v2",
        portal: { ...input.fields, tradeName: "Canonical Trading" },
      };
    },
  });
  const saved = await client.save(profile, profile.portal, signal());
  assert.deepEqual(call.scope, { kind: "own" });
  assert.equal(call.input.version, "v1");
  assert.deepEqual(
    Object.keys(call.input.fields).sort(),
    Object.keys(profile.portal).sort(),
  );
  assert.equal(saved.portal.tradeName, "Canonical Trading");
  assert.equal(saved.version, "v2");
});
test("view-only and inactive accounts cannot save, wrong-company data is rejected, and missing API never succeeds", async () => {
  let writes = 0;
  const adapter = {
    async save() {
      writes++;
      return profile;
    },
    async read() {
      return { ...profile, id: other };
    },
  };
  const user = new CompanyClient(
    { ...identity, role: "CUSTOMER_USER" },
    adapter,
  );
  await assert.rejects(user.save(profile, profile.portal, signal()), {
    code: "forbidden",
  });
  const admin = new CompanyClient(identity, adapter);
  await assert.rejects(
    admin.save({ ...profile, status: "SUSPENDED" }, profile.portal, signal()),
    { code: "forbidden" },
  );
  await assert.rejects(admin.read(signal()), { code: "unavailable" });
  assert.equal(writes, 0);
  await assert.rejects(new CompanyClient(identity).read(signal()), {
    code: "unavailable",
  });
});
test("configured HTTP mapper does not send a tenant/ERP override in a customer update", async () => {
  const calls = [];
  const adapter = companyHttpAdapter(
    async (op) => {
      calls.push(op);
      return { company: profile };
    },
    {
      own: "/api/v1/company",
      internal: (id) => `/api/v1/admin/companies/${id}`,
    },
  );
  const client = new CompanyClient(identity, adapter);
  await client.read(signal());
  await client.save(profile, profile.portal, signal());
  assert.equal(calls[0].path, "/api/v1/company");
  assert.equal(calls[1].method, "PATCH");
  assert.deepEqual(calls[1].body, { version: "v1", ...profile.portal });
  assert.ok(!JSON.stringify(calls[1].body).includes("ERP-SYNTHETIC"));
  assert.ok(!("companyId" in calls[1].body));
});
test("actual company view separates editable fields from read-only legal/licence/commercial data", () => {
  const state = {
    data: profile,
    busy: false,
    error: null,
    needsReload: false,
    saved: false,
  };
  const edit = render(CompanyView, {
    state,
    canEdit: true,
    reload() {},
    save() {},
  });
  for (const key of Object.keys(profile.portal))
    assert.ok(edit.includes(`name="${key}"`));
  for (const key of [
    "legalName",
    "tradeLicenseReference",
    "creditLimit",
    "creditStatus",
    "erpCustomerReference",
  ])
    assert.ok(!edit.includes(`name="${key}"`));
  assert.ok(edit.includes("ERP-owned"));
  assert.ok(edit.includes("ERP-SYNTHETIC"));
  assert.ok(!edit.includes("150,000"));
  assert.ok(edit.includes("Save changes"));
  const view = render(CompanyView, {
    state,
    canEdit: false,
    reload() {},
    save() {},
  });
  assert.ok(!view.includes("<input"));
  assert.ok(!view.includes("Save changes"));
  assert.ok(view.includes("view-only"));
  const nav = render(CompanySections, {});
  assert.ok(nav.includes('href="/company/addresses"'));
  assert.ok(nav.includes('aria-current="page"'));
});
test("actual route denies preview data access and normal Customer User reaches the read screen without management authority", async () => {
  let calls = 0;
  const companyProfile = {
    async read() {
      calls++;
      return profile;
    },
  };
  const preview = render(App, {
    initialRole: "Customer Admin",
    companyProfile,
  });
  assert.ok(preview.includes("authorized company context"));
  assert.equal(calls, 0);
  const now = Date.now(),
    user = {
      id: other,
      companyId: id,
      displayName: "Synthetic Buyer",
      role: "CUSTOMER_USER",
      mustChangePassword: false,
    };
  const sessionClient = new SessionClient(
    async (path) =>
      new Response(
        JSON.stringify({
          success: true,
          requestId: id,
          data: path.endsWith("login")
            ? {
                user,
                accessToken: "synthetic-access",
                refreshToken: "synthetic-refresh",
                tokenType: "Bearer",
                expiresIn: 900,
                refreshExpiresAt: new Date(now + 600000).toISOString(),
              }
            : { user },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    () => now,
  );
  await sessionClient.login("buyer@example.test", "synthetic");
  const real = render(App, { sessionClient, companyProfile });
  assert.ok(real.includes("Loading or saving company information"));
  assert.ok(!real.includes("Save changes"));
  assert.equal((real.match(/<main[\s>]/g) ?? []).length, 1);
  assert.equal((real.match(/<h1[\s>]/g) ?? []).length, 1);
});
