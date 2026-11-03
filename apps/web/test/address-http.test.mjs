import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

let server,
  AddressClient,
  authenticatedAddressAdapter,
  SessionClient,
  RemoteModel;
const companyId = "12345678-1234-4234-8234-123456789abc",
  addressId = "22345678-1234-4234-8234-123456789abc",
  secondId = "32345678-1234-4234-8234-123456789abc";
const identity = {
  companyId,
  role: "CUSTOMER_ADMIN",
  mustChangePassword: false,
};
const first = {
  id: addressId,
  label: "Synthetic warehouse",
  address: { line1: "Synthetic street" },
  contactName: null,
  contactPhone: null,
  active: true,
  isDefault: true,
};
const collection = {
  companyId,
  version: "opaque-v1",
  items: [first, { ...first, id: secondId, isDefault: false }],
};
const routes = {
  own: "/api/v1/delivery-addresses",
  internal: (id) => `/api/v1/companies/${id}/delivery-addresses`,
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
  ({ AddressClient, authenticatedAddressAdapter } = await server.ssrLoadModule(
    "/src/features/delivery-addresses/api.ts",
  ));
  ({ SessionClient } = await server.ssrLoadModule(
    "/src/features/authentication/session.ts",
  ));
  ({ RemoteModel } = await server.ssrLoadModule("/src/shared/remote.ts"));
});
after(async () => server?.close());

async function connected(send, role = "CUSTOMER_ADMIN") {
  const now = Date.now();
  const user = {
    id: secondId,
    companyId,
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
    client: new AddressClient(
      { ...identity, role },
      authenticatedAddressAdapter(session),
    ),
  };
}

test("authenticated address read and default change use session proof, exact command and canonical snapshot", async () => {
  const calls = [];
  const canonical = {
    ...collection,
    version: "opaque-v2",
    items: [
      { ...first, isDefault: false },
      { ...first, id: secondId, isDefault: true },
    ],
  };
  const { client } = await connected(async (path, init) => {
    calls.push({ path, init });
    return ok(
      init.method === "GET"
        ? collection
        : { addresses: canonical, addressId: secondId },
    );
  });
  const loaded = await client.read(signal());
  assert.deepEqual(
    await client.setDefault(loaded, secondId, signal()),
    canonical,
  );
  assert.deepEqual(
    calls.map((x) => [x.path, x.init.method]),
    [
      [routes.own, "GET"],
      [routes.own, "POST"],
    ],
  );
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    version: "opaque-v1",
    action: "set-default",
    addressId: secondId,
  });
  for (const { init } of calls) {
    assert.equal(init.headers.Authorization, "Bearer synthetic-access");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");
});

test("Customer User reads and selects active choices without issuing management requests", async () => {
  let reads = 0;
  const { client } = await connected(async (path, init) => {
    reads++;
    assert.equal(init.method, "GET");
    return ok({
      ...collection,
      items: [
        first,
        { ...first, id: secondId, active: false, isDefault: false },
      ],
    });
  }, "CUSTOMER_USER");
  const data = await client.read(signal());
  assert.equal(client.select(data, addressId).id, addressId);
  assert.throws(() => client.select(data, secondId), { code: "invalid" });
  await assert.rejects(client.setDefault(data, secondId, signal()), {
    code: "forbidden",
  });
  assert.equal(reads, 1);
});

test("conflict and uncertain HTTP writes require reload without automatic command replay", async () => {
  for (const status of [409, 412, 503, "network"]) {
    let writes = 0;
    const { client } = await connected(async (path, init) => {
      if (init.method === "GET") return ok(collection);
      writes++;
      if (status === "network") throw new TypeError("synthetic loss");
      return new Response("PRIVATE_SERVER_MESSAGE", { status });
    });
    const model = new RemoteModel();
    await model.load((s) => client.read(s));
    assert.equal(
      await model.write((data, s) => client.setDefault(data, secondId, s)),
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
    assert.ok(!state.error.message.includes("PRIVATE_SERVER_MESSAGE"));
    await model.write((data, s) => client.setDefault(data, secondId, s));
    assert.equal(writes, 1);
  }
});

test("session expiry clears proof and fails as session; denial and invalid input are safe UI errors", async () => {
  for (const [status, code] of [
    [400, "invalid"],
    [401, "session"],
    [403, "forbidden"],
    [404, "not-found"],
    [429, "rate"],
  ]) {
    const { client, session } = await connected(
      async () => new Response("PRIVATE", { status }),
    );
    await assert.rejects(client.read(signal()), { code });
    if (status === 401) assert.equal(session.snapshot(), null);
  }
});

test("HTML, malformed envelopes, foreign snapshots and invalid default state cannot render as success", async () => {
  for (const response of [
    () =>
      new Response("SPA fallback", {
        headers: { "content-type": "text/html" },
      }),
    () => ok({ addresses: collection }),
    () =>
      new Response(
        JSON.stringify({ success: true, requestId: "bad", data: collection }),
        { headers: { "content-type": "application/json" } },
      ),
    () => ok({ ...collection, companyId: secondId }),
    () => ok({ ...collection, items: [first, { ...first, id: secondId }] }),
  ]) {
    const { client } = await connected(async () => response());
    await assert.rejects(client.read(signal()), { code: "unavailable" });
  }
});

test("aborted address reads pass cancellation into the authenticated request", async () => {
  const controller = new AbortController();
  const { client } = await connected(async (path, init) => {
    assert.equal(init.signal.aborted, true);
    throw new DOMException("Aborted", "AbortError");
  });
  controller.abort();
  await assert.rejects(client.read(controller.signal), { code: "unavailable" });
});

test("all address commands carry the loaded version and retain explicit null/default intent over HTTP", async () => {
  const createdId = "42345678-1234-4234-8234-123456789abc";
  let data = structuredClone(collection),
    counter = 1;
  const commands = [];
  const { client } = await connected(async (path, init) => {
    if (init.method === "GET") return ok(data);
    const command = JSON.parse(init.body);
    commands.push(command);
    assert.equal(command.version, data.version);
    let item = data.items.find((x) => x.id === command.addressId);
    if (command.action === "update") Object.assign(item, command.fields);
    if (command.action === "create") {
      data.items.forEach((x) => (x.isDefault = false));
      item = {
        id: createdId,
        ...command.fields,
        active: true,
        isDefault: true,
      };
      data.items.push(item);
    }
    if (command.action === "deactivate") {
      item.active = false;
      item.isDefault = false;
    }
    if (command.action === "activate") item.active = true;
    data.version = `opaque-v${++counter}`;
    return ok({ addresses: data, addressId: item.id });
  });
  const draft = {
    label: " New label ",
    line1: " New street ",
    contactName: " ",
    contactPhone: null,
  };
  let loaded = await client.read(signal());
  loaded = await client.update(loaded, addressId, draft, signal());
  assert.equal(loaded.items[0].label, "New label");
  loaded = await client.create(loaded, draft, true, signal());
  assert.equal(loaded.items.find((x) => x.isDefault).id, createdId);
  loaded = await client.deactivate(loaded, createdId, null, signal());
  assert.equal(loaded.items.length, 3);
  loaded = await client.activate(loaded, createdId, signal());
  assert.ok(!loaded.items.some((x) => x.isDefault));
  assert.deepEqual(
    commands.map((x) => x.action),
    ["update", "create", "deactivate", "activate"],
  );
  assert.deepEqual(commands[0].fields, {
    label: "New label",
    address: { line1: "New street" },
    contactName: null,
    contactPhone: null,
  });
  assert.equal(commands[1].makeDefault, true);
  assert.equal(commands[2].replacementId, null);
  assert.ok(
    commands.every((x) => !("companyId" in x) && !("actorUserId" in x)),
  );
});

test("internal address binding is read only and uses the shared company resource route", async () => {
  const calls = [];
  const adapter = authenticatedAddressAdapter({
    async request(path, init) {
      calls.push({ path, init });
      return ok(collection);
    },
  });
  const client = new AddressClient(
    { role: "INTERNAL_ADMIN", companyId: null, mustChangePassword: false },
    adapter,
    companyId,
  );
  await client.read(signal());
  await assert.rejects(
    adapter.change(
      { kind: "internal", companyId },
      { action: "activate", addressId, version: "v1" },
      signal(),
    ),
    { code: "forbidden" },
  );
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].path,
    `/api/v1/companies/${companyId}/delivery-addresses`,
  );
  assert.equal(calls[0].init.method, "GET");
});

test("only the documented 200 response confirms an address read or write", async () => {
  const adapter = authenticatedAddressAdapter({
    async request() {
      const response = ok(collection);
      return new Response(response.body, {
        status: 202,
        headers: response.headers,
      });
    },
  });
  await assert.rejects(new AddressClient(identity, adapter).read(signal()), {
    code: "unavailable",
  });
});
