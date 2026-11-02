import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SessionClient } from "../src/features/authentication/session.ts";
let server,
  AddressClient,
  addressCollection,
  addressInput,
  addressErrors,
  addressHttpAdapter,
  AddressView,
  AddressEditor,
  DeactivateAddress,
  RemoteModel,
  App;
const companyId = "12345678-1234-4234-8234-123456789abc",
  a = "22345678-1234-4234-8234-123456789abc",
  b = "32345678-1234-4234-8234-123456789abc",
  c = "42345678-1234-4234-8234-123456789abc",
  newId = "52345678-1234-4234-8234-123456789abc";
const identity = {
  companyId,
  role: "CUSTOMER_ADMIN",
  mustChangePassword: false,
};
// Explicit test-only scoped producer snapshot. No fixture is shipped in the UI.
const first = {
  id: a,
  label: "Synthetic Main",
  address: { line1: "Synthetic street" },
  contactName: null,
  contactPhone: null,
  active: true,
  isDefault: true,
};
const second = { ...first, id: b, label: "Synthetic Branch", isDefault: false };
const inactive = {
  ...first,
  id: c,
  label: "Synthetic Inactive",
  active: false,
  isDefault: false,
};
const collection = {
  companyId,
  version: "v1",
  items: [first, second, inactive],
};
const draft = {
  label: " New location ",
  line1: " New street ",
  contactName: " Contact ",
  contactPhone: " 555 ",
};
const signal = () => new AbortController().signal;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  ({
    AddressClient,
    addressCollection,
    addressInput,
    addressErrors,
    addressHttpAdapter,
  } = await server.ssrLoadModule("/src/features/delivery-addresses/api.ts"));
  ({ AddressView, AddressEditor, DeactivateAddress } =
    await server.ssrLoadModule(
      "/src/features/delivery-addresses/AddressPage.tsx",
    ));
  ({ RemoteModel } = await server.ssrLoadModule("/src/shared/remote.ts"));
  ({ App } = await server.ssrLoadModule("/src/app.tsx"));
});
after(async () => server?.close());
const render = (component, props, path = "/company/addresses") =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(component, props),
    ),
  );
const updated = (items) => ({ ...collection, version: "v2", items });
test("address snapshot validates unique active/default state and projects only portal fields", () => {
  const result = addressCollection({
    ...collection,
    items: [
      { ...first, privateOrderIds: ["DO_NOT_PROJECT"], contactName: undefined },
    ],
  });
  assert.equal(result.items[0].privateOrderIds, undefined);
  assert.equal(result.items[0].contactName, null);
  for (const items of [
    [first, first],
    [{ ...first, active: false }],
    [first, { ...second, isDefault: true }],
  ])
    assert.throws(() => addressCollection({ ...collection, items }), {
      code: "unavailable",
    });
});
test("address inputs validate required label/line1 and refuse tenant, ID, status and arbitrary JSON fields", () => {
  assert.deepEqual(addressInput(draft), {
    label: "New location",
    address: { line1: "New street" },
    contactName: "Contact",
    contactPhone: "555",
  });
  for (const key of ["companyId", "id", "active", "isDefault", "actorUserId"])
    assert.throws(() => addressInput({ ...draft, [key]: "forged" }), {
      code: "invalid",
    });
  const errors = addressErrors({ ...draft, label: "", line1: "x".repeat(501) });
  assert.ok(errors.label);
  assert.ok(errors.line1);
});
test("Customer User selects known active addresses but cannot manage, select inactive or cross-company choices", async () => {
  let calls = 0;
  const adapter = {
    async change() {
      calls++;
      return {};
    },
  };
  const user = new AddressClient(
    { ...identity, role: "CUSTOMER_USER" },
    adapter,
  );
  assert.equal(user.select(collection, a).id, a);
  assert.throws(() => user.select(collection, c), { code: "invalid" });
  assert.throws(() => user.select(collection, newId), { code: "not-found" });
  assert.throws(() => user.select({ ...collection, companyId: newId }, a), {
    code: "unavailable",
  });
  await assert.rejects(user.create(collection, draft, false, signal()), {
    code: "forbidden",
  });
  await assert.rejects(user.setDefault(collection, b, signal()), {
    code: "forbidden",
  });
  assert.equal(calls, 0);
  const internal = new AddressClient(
    { role: "INTERNAL_ADMIN", companyId: null, mustChangePassword: false },
    adapter,
    companyId,
  );
  assert.throws(() => internal.select(collection, a), { code: "forbidden" });
  await assert.rejects(internal.activate(collection, c, signal()), {
    code: "forbidden",
  });
});
test("creation sends exact portal fields/version, uses a server ID and never deletes existing history", async () => {
  let command;
  const client = new AddressClient(identity, {
    async change(scope, input) {
      command = { scope, input };
      return {
        addresses: updated([
          ...collection.items,
          { id: newId, ...addressInput(draft), active: true, isDefault: false },
        ]),
        addressId: newId,
      };
    },
  });
  const result = await client.create(collection, draft, false, signal());
  assert.deepEqual(command.scope, { kind: "own" });
  assert.deepEqual(command.input, {
    version: "v1",
    action: "create",
    fields: addressInput(draft),
    makeDefault: false,
  });
  assert.equal(result.items.length, 4);
  assert.equal(result.items.find((x) => x.isDefault).id, a);
  const lost = new AddressClient(identity, {
    async change() {
      return {
        addresses: updated([{ ...first, label: "Updated" }, second]),
        addressId: a,
      };
    },
  });
  await assert.rejects(lost.update(collection, a, draft, signal()), {
    code: "unavailable",
  });
});
test("set-default accepts one canonical atomic switch and refuses inactive, duplicate-default and unknown targets", async () => {
  const client = new AddressClient(identity, {
    async change() {
      return {
        addresses: updated([
          { ...first, isDefault: false },
          { ...second, isDefault: true },
          inactive,
        ]),
        addressId: b,
      };
    },
  });
  const result = await client.setDefault(collection, b, signal());
  assert.equal(result.items.filter((x) => x.isDefault).length, 1);
  assert.equal(result.items.find((x) => x.isDefault).id, b);
  await assert.rejects(client.setDefault(collection, c, signal()), {
    code: "invalid",
  });
  await assert.rejects(client.setDefault(collection, newId, signal()), {
    code: "not-found",
  });
  const invalid = new AddressClient(identity, {
    async change() {
      return {
        addresses: updated([first, { ...second, isDefault: true }, inactive]),
        addressId: b,
      };
    },
  });
  await assert.rejects(invalid.setDefault(collection, b, signal()), {
    code: "unavailable",
  });
});
test("default deactivation explicitly clears or selects an active replacement and retains the inactive record", async () => {
  const cleared = new AddressClient(identity, {
    async change(scope, input) {
      assert.equal(input.replacementId, null);
      return {
        addresses: updated([
          { ...first, active: false, isDefault: false },
          second,
          inactive,
        ]),
        addressId: a,
      };
    },
  });
  const result = await cleared.deactivate(collection, a, null, signal());
  assert.equal(result.items.length, 3);
  assert.ok(!result.items.some((x) => x.isDefault));
  assert.equal(result.items[0].active, false);
  const replaced = new AddressClient(identity, {
    async change() {
      return {
        addresses: updated([
          { ...first, active: false, isDefault: false },
          { ...second, isDefault: true },
          inactive,
        ]),
        addressId: a,
      };
    },
  });
  assert.equal(
    (await replaced.deactivate(collection, a, b, signal())).items.find(
      (x) => x.isDefault,
    ).id,
    b,
  );
  await assert.rejects(replaced.deactivate(collection, a, c, signal()), {
    code: "invalid",
  });
  await assert.rejects(replaced.deactivate(collection, a, null, signal()), {
    code: "unavailable",
  });
});
test("activation does not silently assign a default; missing producer and malformed targets never succeed", async () => {
  const withoutDefault = {
    ...collection,
    items: [{ ...first, isDefault: false }, second, inactive],
  };
  const client = new AddressClient(identity, {
    async change() {
      return {
        addresses: updated([
          { ...first, isDefault: false },
          second,
          { ...inactive, active: true },
        ]),
        addressId: c,
      };
    },
  });
  assert.ok(
    !(await client.activate(withoutDefault, c, signal())).items.some(
      (x) => x.isDefault,
    ),
  );
  const forced = new AddressClient(identity, {
    async change() {
      return {
        addresses: updated([
          { ...first, isDefault: false },
          second,
          { ...inactive, active: true, isDefault: true },
        ]),
        addressId: c,
      };
    },
  });
  await assert.rejects(forced.activate(withoutDefault, c, signal()), {
    code: "unavailable",
  });
  await assert.rejects(new AddressClient(identity).read(signal()), {
    code: "unavailable",
  });
  assert.throws(() => client.select(collection, "../foreign"), {
    code: "not-found",
  });
});
test("HTTP adapter uses authorized own route and explicit action/version, with no DELETE/tenant/actor payload", async () => {
  const calls = [];
  const adapter = addressHttpAdapter(
    async (operation) => {
      calls.push(operation);
      return operation.method === "GET"
        ? collection
        : {
            addresses: updated([
              { ...first, isDefault: false },
              { ...second, isDefault: true },
              inactive,
            ]),
            addressId: b,
          };
    },
    {
      own: "/api/v1/company/addresses",
      internal: (id) => `/api/v1/admin/companies/${id}/addresses`,
    },
  );
  const client = new AddressClient(identity, adapter);
  await client.read(signal());
  await client.setDefault(collection, b, signal());
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].path, "/api/v1/company/addresses");
  assert.deepEqual(calls[1].body, {
    version: "v1",
    action: "set-default",
    addressId: b,
  });
});
test("duplicate default requests are guarded and a cancelled write cannot publish into another company screen", async () => {
  const model = new RemoteModel();
  await model.load(async () => collection);
  let release,
    calls = 0;
  const promise = model.write(async () => {
    calls++;
    await new Promise((r) => {
      release = r;
    });
    return updated([
      { ...first, isDefault: false },
      { ...second, isDefault: true },
      inactive,
    ]);
  });
  assert.equal(
    await model.write(async () => {
      calls++;
      return collection;
    }),
    false,
  );
  assert.equal(calls, 1);
  model.cancel();
  await model.load(async () => ({
    ...collection,
    companyId: newId,
    items: [],
  }));
  release();
  await promise;
  assert.equal(model.snapshot().data.companyId, newId);
  assert.equal(model.snapshot().saved, false);
});
test("actual view gives Customer User active-only radio choices and no management or invented ordering success", () => {
  const state = {
    data: collection,
    busy: false,
    error: null,
    needsReload: false,
    saved: false,
  };
  const html = render(AddressView, {
    state,
    canManage: false,
    canSelect: true,
    canInspectInactive: false,
    reload() {},
    open() {},
    activate() {},
    setDefault() {},
    select() {
      return first;
    },
  });
  assert.ok(html.includes('type="radio"'));
  assert.ok(html.includes("Synthetic Main"));
  assert.ok(!html.includes("Synthetic Inactive"));
  assert.ok(!html.includes("3 addresses supplied"));
  assert.ok(html.includes("2 active delivery addresses"));
  assert.ok(!html.includes("Add delivery address"));
  assert.ok(!html.includes("Manage addresses"));
  assert.ok(!html.includes("Order saved"));
  const empty = render(AddressView, {
    state: { ...state, data: { ...collection, items: [] } },
    canManage: false,
    canSelect: true,
    canInspectInactive: false,
    reload() {},
  });
  assert.ok(empty.includes("No active delivery addresses"));
  assert.ok(!empty.includes('type="submit"'));
});
test("editor exposes only bounded portal fields and default deactivation requires an explicit replacement/clear choice", () => {
  const editor = render(AddressEditor, {
    busy: false,
    commit() {},
    cancel() {},
  });
  for (const name of [
    "label",
    "line1",
    "contactName",
    "contactPhone",
    "makeDefault",
  ])
    assert.ok(editor.includes(`name="${name}"`));
  assert.ok(!editor.includes('name="companyId"'));
  assert.ok(!editor.includes('disabled=""'));
  const form = render(DeactivateAddress, {
    current: first,
    choices: collection.items,
    busy: false,
    commit() {},
    cancel() {},
  });
  assert.ok(form.includes("Clear default without replacement"));
  assert.ok(form.includes(`value="${b}"`));
  assert.ok(!form.includes(`value="${c}"`));
  assert.ok(form.includes("No address will be chosen automatically"));
});
test("actual address routes cannot fetch through preview role and a normal customer reaches the scoped screen", async () => {
  let calls = 0;
  const deliveryAddresses = {
    async read() {
      calls++;
      return collection;
    },
  };
  assert.ok(
    render(App, { initialRole: "Customer Admin", deliveryAddresses }).includes(
      "authorized company context",
    ),
  );
  assert.equal(calls, 0);
  const now = Date.now(),
    user = {
      id: newId,
      companyId,
      displayName: "Synthetic Buyer",
      role: "CUSTOMER_USER",
      mustChangePassword: false,
    };
  const sessionClient = new SessionClient(
    async (path) =>
      new Response(
        JSON.stringify({
          success: true,
          requestId: companyId,
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
  const html = render(App, { sessionClient, deliveryAddresses });
  assert.ok(html.includes("Loading or saving addresses"));
  assert.equal((html.match(/<main[\s>]/g) ?? []).length, 1);
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
});
