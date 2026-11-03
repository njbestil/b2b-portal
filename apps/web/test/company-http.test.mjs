import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

let server,
  CompanyClient,
  authenticatedCompanyAdapter,
  SessionClient,
  RemoteModel;
const companyId = "12345678-1234-4234-8234-123456789abc",
  userId = "22345678-1234-4234-8234-123456789abc";
const profile = {
  id: companyId,
  version: "opaque-v1",
  legalName: "Synthetic Company LLC",
  status: "ACTIVE",
  tradeLicenseReference: "SYNTHETIC-LICENCE",
  portal: {
    tradeName: "Synthetic Trading",
    primaryContact: "Synthetic contact",
    businessEmail: "contact@example.test",
    phone: "555",
    billingAddress: "Synthetic billing street",
  },
  commercial: {
    erpCustomerReference: "SYNTHETIC-ERP",
    paymentTerms: null,
    creditStatus: null,
  },
};
const routes = {
  own: "/api/v1/company-profile",
  internal: (id) => `/api/v1/companies/${id}/profile`,
};
const signal = () => new AbortController().signal;
const ok = (data) =>
  new Response(JSON.stringify({ success: true, requestId: companyId, data }), {
    headers: { "content-type": "application/json" },
  });
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  ({ CompanyClient, authenticatedCompanyAdapter } = await server.ssrLoadModule(
    "/src/features/company-profile/api.ts",
  ));
  ({ SessionClient } = await server.ssrLoadModule(
    "/src/features/authentication/session.ts",
  ));
  ({ RemoteModel } = await server.ssrLoadModule("/src/shared/remote.ts"));
});
after(async () => server?.close());

async function connected(send, role = "CUSTOMER_ADMIN") {
  const now = Date.now(),
    internal = role === "INTERNAL_ADMIN" || role === "SALES_STAFF";
  const user = {
    id: userId,
    companyId: internal ? null : companyId,
    displayName: "Synthetic buyer",
    role,
    mustChangePassword: false,
  };
  const session = new SessionClient(
    async (path, init) => {
      if (path.endsWith("/login"))
        return ok({
          user,
          accessToken: "synthetic-access",
          refreshToken: "synthetic-refresh",
          tokenType: "Bearer",
          expiresIn: 900,
          refreshExpiresAt: new Date(now + 600000).toISOString(),
        });
      if (path.endsWith("/me")) return ok({ user });
      return send(path, init);
    },
    () => now,
  );
  await session.login("buyer@example.test", "synthetic");
  return {
    session,
    client: new CompanyClient(
      user,
      authenticatedCompanyAdapter(session),
      internal ? companyId : undefined,
    ),
  };
}

test("profile read/save use session authentication, five exact portal fields and the server's canonical response", async () => {
  const calls = [],
    canonical = {
      ...profile,
      version: "opaque-v2",
      portal: { ...profile.portal, tradeName: "Canonical Trading" },
    };
  const { client } = await connected(async (path, init) => {
    calls.push({ path, init });
    return ok({ company: init.method === "GET" ? profile : canonical });
  });
  const loaded = await client.read(signal());
  assert.deepEqual(
    await client.save(
      loaded,
      { ...loaded.portal, tradeName: " Entered Trading " },
      signal(),
    ),
    canonical,
  );
  assert.deepEqual(
    calls.map((x) => [x.path, x.init.method]),
    [
      [routes.own, "GET"],
      [routes.own, "PATCH"],
    ],
  );
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    version: "opaque-v1",
    ...profile.portal,
    tradeName: "Entered Trading",
  });
  for (const { init } of calls) {
    assert.equal(init.headers.Authorization, "Bearer synthetic-access");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");
  for (const key of [
    "id",
    "companyId",
    "legalName",
    "status",
    "tradeLicenseReference",
    "commercial",
    "creditLimit",
  ])
    assert.ok(!Object.hasOwn(JSON.parse(calls[1].init.body), key));
});

test("optional blank fields clear to null, and invalid/ERP/identity edits never reach HTTP", async () => {
  let writes = 0;
  const cleared = {
    tradeName: "Trading",
    primaryContact: null,
    businessEmail: null,
    phone: null,
    billingAddress: null,
  };
  const { client } = await connected(async (path, init) => {
    writes++;
    assert.deepEqual(JSON.parse(init.body), {
      version: "opaque-v1",
      ...cleared,
    });
    return ok({
      company: { ...profile, version: "opaque-v2", portal: cleared },
    });
  });
  await client.save(
    profile,
    {
      tradeName: " Trading ",
      primaryContact: " ",
      businessEmail: "",
      phone: null,
      billingAddress: "",
    },
    signal(),
  );
  for (const draft of [
    { ...profile.portal, tradeName: " " },
    { ...profile.portal, businessEmail: "invalid" },
    { ...profile.portal, phone: "x".repeat(41) },
    { ...profile.portal, billingAddress: "x".repeat(501) },
    ...[
      "companyId",
      "legalName",
      "status",
      "tradeLicenseReference",
      "commercial",
      "creditLimit",
    ].map((key) => ({ ...profile.portal, [key]: "forged" })),
  ])
    await assert.rejects(client.save(profile, draft, signal()), {
      code: "invalid",
    });
  assert.equal(writes, 1);
});

test("Customer User and authorized internal views read but never submit an update", async () => {
  for (const role of ["CUSTOMER_USER", "INTERNAL_ADMIN", "SALES_STAFF"]) {
    const calls = [];
    const { client } = await connected(async (path, init) => {
      calls.push({ path, init });
      return ok({ company: profile });
    }, role);
    const loaded = await client.read(signal());
    assert.equal(client.canEdit(loaded), false);
    await assert.rejects(client.save(loaded, loaded.portal, signal()), {
      code: "forbidden",
    });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].path,
      role === "CUSTOMER_USER" ? routes.own : routes.internal(companyId),
    );
    assert.equal(calls[0].init.method, "GET");
  }
  let calls = 0;
  const adapter = authenticatedCompanyAdapter(
    {
      async request() {
        calls++;
        return ok({ company: profile });
      },
    },
    routes,
  );
  await assert.rejects(
    adapter.save(
      { kind: "internal", companyId },
      { version: "v1", fields: profile.portal },
      signal(),
    ),
    { code: "forbidden" },
  );
  assert.equal(calls, 0);
});

test("stale and uncertain profile saves retain prior data and require reload without replay", async () => {
  for (const status of [409, 412, 503, "network"]) {
    let writes = 0;
    const { client } = await connected(async (path, init) => {
      if (init.method === "GET") return ok({ company: profile });
      writes++;
      if (status === "network")
        throw new TypeError("synthetic connection loss");
      return new Response("PRIVATE_SERVER_DETAIL", { status });
    });
    const model = new RemoteModel();
    await model.load((s) => client.read(s));
    assert.equal(
      await model.write((data, s) => client.save(data, data.portal, s)),
      false,
    );
    const state = model.snapshot();
    assert.equal(
      state.error.code,
      [409, 412].includes(status) ? "conflict" : "unavailable",
    );
    assert.equal(state.needsReload, true);
    assert.equal(state.saved, false);
    assert.equal(state.data.version, "opaque-v1");
    assert.ok(!state.error.message.includes("PRIVATE_SERVER_DETAIL"));
    await model.write((data, s) => client.save(data, data.portal, s));
    assert.equal(writes, 1);
  }
});

test("profile HTTP failures map to safe session, permission, validation, rate and unavailable states", async () => {
  for (const [status, code] of [
    [400, "invalid"],
    [401, "session"],
    [403, "forbidden"],
    [404, "not-found"],
    [413, "invalid"],
    [415, "invalid"],
    [429, "rate"],
    [503, "unavailable"],
  ]) {
    const { session, client } = await connected(
      async () => new Response("PRIVATE", { status }),
    );
    await assert.rejects(client.read(signal()), { code });
    if (status === 401) assert.equal(session.snapshot(), null);
  }
});

test("HTML, malformed envelopes, foreign profiles and unsafe commercial values never become valid data", async () => {
  for (const response of [
    () => new Response("SPA fallback"),
    () => ok(profile),
    () => ok({ company: { ...profile, id: userId } }),
    () => ok({ company: { ...profile, version: "" } }),
    () =>
      ok({
        company: { ...profile, commercial: { creditStatus: "bad\u0000value" } },
      }),
    () =>
      new Response(
        JSON.stringify({
          success: true,
          requestId: "bad",
          data: { company: profile },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    () =>
      new Response(ok({ company: profile }).body, {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
  ]) {
    const { client } = await connected(async () => response());
    await assert.rejects(client.read(signal()), { code: "unavailable" });
  }
});

test("late profile writes after cancellation cannot publish into a new screen", async () => {
  let release, started;
  const entered = new Promise((r) => (started = r)),
    barrier = new Promise((r) => (release = r));
  const { client } = await connected(async (path, init) => {
    if (init.method === "GET") return ok({ company: profile });
    started();
    await barrier;
    return ok({ company: { ...profile, version: "opaque-v2" } });
  });
  const model = new RemoteModel();
  await model.load((s) => client.read(s));
  const writing = model.write((data, s) => client.save(data, data.portal, s));
  await entered;
  model.cancel();
  await model.load(async () => ({ ...profile, id: userId }));
  release();
  await writing;
  assert.equal(model.snapshot().data.id, userId);
  assert.equal(model.snapshot().saved, false);
});

test("email is normalized and a canonical no-op save may retain its opaque version", async () => {
  let calls = 0;
  const { client } = await connected(async (path, init) => {
    calls++;
    assert.equal(path, routes.own);
    assert.deepEqual(JSON.parse(init.body), {
      version: profile.version,
      ...profile.portal,
    });
    return ok({ company: profile });
  });
  const result = await client.save(
    profile,
    { ...profile.portal, businessEmail: " CONTACT@EXAMPLE.TEST " },
    signal(),
  );
  assert.equal(result.version, profile.version);
  assert.equal(result.portal.businessEmail, "contact@example.test");
  assert.equal(calls, 1);
});
