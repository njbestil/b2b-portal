import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createDeliveryAddresses } from "../dist/services/delivery-addresses.js";
import { createJsonDeliveryAddresses } from "../dist/infrastructure/json/delivery-addresses.js";
import { createPostgresDeliveryAddresses } from "../dist/infrastructure/postgres-delivery-addresses.js";
import { createJsonApplications } from "../dist/infrastructure/json/applications.js";
import { createPostgresApplications } from "../dist/infrastructure/postgres-applications.js";
import {
  addressCollection,
  changeAddresses,
} from "../dist/infrastructure/delivery-address-state.js";
import { createApp } from "../dist/app.js";
const fields = (label = "Kitchen") => ({
  label,
  address: { line1: "Synthetic delivery" },
  contactName: "Contact",
  contactPhone: null,
});
async function fixture(t, provider, io = fs, after = async () => {}) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.repo =
    provider === "json"
      ? createJsonDeliveryAddresses(f.security, f.now, io, after)
      : createPostgresDeliveryAddresses(f.pool, f.now);
  f.service = createDeliveryAddresses(f.repo);
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
  f.legacy = {
    id: randomUUID(),
    companyId: f.companyId,
    label: "Initial",
    address: { line1: "Legacy delivery" },
    active: true,
    isDefault: true,
  };
  f.foreign = { ...f.legacy, id: randomUUID(), companyId: f.otherId };
  if (provider === "json")
    await fs.writeFile(
      join(f.directory, "delivery_addresses.json"),
      JSON.stringify([f.legacy, f.foreign]),
    );
  else
    for (const row of [f.legacy, f.foreign])
      await f.pool.query(
        "INSERT INTO delivery_addresses(id,company_id,label,address,active,is_default) VALUES($1,$2,$3,$4::jsonb,true,true)",
        [row.id, row.companyId, row.label, JSON.stringify(row.address)],
      );
  f.change = async (command) =>
    f.service.change(f.ca, {
      version: (await f.service.own(f.ca)).version,
      ...command,
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
      ": legacy contacts, create/update/active/default transitions are canonical and preserve history",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        initial = await f.service.own(f.ca);
      assert.equal(initial.items[0].contactName, null);
      assert.match(initial.version, /^addresses-[a-f0-9]{64}$/);
      const created = await f.change({
        action: "create",
        fields: fields("Second"),
        makeDefault: true,
      });
      assert.equal(created.addresses.items.length, 2);
      assert.equal(
        created.addresses.items.find((r) => r.id === created.addressId)
          .isDefault,
        true,
      );
      assert.equal(
        created.addresses.items.find((r) => r.id === f.legacy.id).isDefault,
        false,
      );
      const updated = await f.change({
        action: "update",
        addressId: created.addressId,
        fields: fields(" Updated "),
      });
      assert.equal(
        updated.addresses.items.find((r) => r.id === created.addressId).label,
        "Updated",
      );
      const replaced = await f.change({
        action: "deactivate",
        addressId: created.addressId,
        replacementId: f.legacy.id,
      });
      assert.equal(
        replaced.addresses.items.find((r) => r.id === f.legacy.id).isDefault,
        true,
      );
      assert.equal(
        replaced.addresses.items.find((r) => r.id === created.addressId).active,
        false,
      );
      const cu = await f.service.own(f.cu);
      assert.deepEqual(
        cu.items.map((r) => r.id),
        [f.legacy.id],
      );
      assert.equal(cu.version, replaced.addresses.version);
      const active = await f.change({
        action: "activate",
        addressId: created.addressId,
      });
      assert.equal(
        active.addresses.items.find((r) => r.id === created.addressId)
          .isDefault,
        false,
      );
      const switched = await f.change({
        action: "set-default",
        addressId: created.addressId,
      });
      assert.equal(
        switched.addresses.items.find((r) => r.id === created.addressId)
          .isDefault,
        true,
      );
      const cleared = await f.change({
        action: "deactivate",
        addressId: created.addressId,
        replacementId: null,
      });
      assert.equal(
        cleared.addresses.items.some((r) => r.isDefault),
        false,
      );
      assert.equal(cleared.addresses.items.length, 2);
      const other = await f.service.own(await f.actor(4));
      assert.equal(other.items.length, 1);
      assert.equal(other.items[0].id, f.foreign.id);
      assert.equal(other.items[0].isDefault, true);
      assert.equal(
        (await f.service.internal(f.ia, f.companyId)).items.length,
        2,
      );
    },
  );
  test(
    provider +
      ": concurrent version checks have one winner; invalid/foreign/default actions and copied authority deny",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        snapshot = await f.service.own(f.ca),
        commands = ["A", "B"].map((label) => ({
          version: snapshot.version,
          action: "create",
          fields: fields(label),
          makeDefault: false,
        }));
      const results = await Promise.allSettled(
        commands.map((c) => f.service.change(f.ca, c)),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.find((r) => r.status === "rejected").reason.code,
        "conflict",
      );
      for (const bad of [
        {
          action: "deactivate",
          addressId: f.legacy.id,
          replacementId: f.foreign.id,
        },
        { action: "set-default", addressId: f.legacy.id },
        { action: "update", addressId: f.foreign.id, fields: fields() },
        {
          action: "create",
          fields: fields(),
          makeDefault: false,
          companyId: f.otherId,
        },
      ])
        await assert.rejects(f.change(bad));
      await assert.rejects(
        f.service.change({ ...f.ca }, commands[0]),
        (e) => e.name === "AuthorizationError",
      );
      await assert.rejects(
        f.service.change(f.cu, commands[0]),
        (e) => e.name === "AuthorizationError",
      );
      await assert.rejects(f.service.internal(f.ca, f.companyId));
      await assert.rejects(f.service.own(f.ia));
      await f.setUser({ status: "SUSPENDED" }, 2);
      await assert.rejects(f.service.own(f.ca));
    },
  );
  test(
    provider +
      ": current Sales assignment gates active-only internal reads, Admin retains historical reads",
    options,
    async (t) => {
      const f = await fixture(t, provider);
      await assert.rejects(f.service.internal(f.sales, f.companyId));
      await f.assign();
      assert.equal(
        (await f.service.internal(f.sales, f.companyId)).items.length,
        1,
      );
      await assert.rejects(f.service.internal(f.sales, f.otherId));
      await f.change({
        action: "deactivate",
        addressId: f.legacy.id,
        replacementId: null,
      });
      assert.equal(
        (await f.service.internal(f.sales, f.companyId)).items.length,
        0,
      );
      assert.equal(
        (await f.service.internal(f.ia, f.companyId)).items.length,
        1,
      );
      await f.assign(false);
      await assert.rejects(f.service.internal(f.sales, f.companyId));
    },
  );
  test(
    provider +
      ": managed contacts remain compatible with another intake and its Pending read",
    options,
    async (t) => {
      const f = await fixture(t, provider);
      await f.change({
        action: "update",
        addressId: f.legacy.id,
        fields: fields(),
      });
      const intake =
        provider === "json"
          ? createJsonApplications(
              f.directory,
              f.security.store,
              undefined,
              f.security,
            )
          : createPostgresApplications(f.pool);
      const row = {
        companyId: randomUUID(),
        administratorUserId: randomUUID(),
        deliveryAddressId: randomUUID(),
        companyName: "Applicant",
        tradeLicenseReference: randomUUID(),
        businessEmail: "business@example.test",
        phone: "555",
        billingAddress: "Billing",
        deliveryAddress: "Delivery",
        administratorName: "Applicant",
        administratorEmail: randomUUID() + "@example.test",
        administratorMobile: "556",
        passwordHash: f.passwordHash,
        createdAt: new Date(f.now()).toISOString(),
      };
      await intake.submit(row);
      assert.equal(
        (await intake.pending(row.companyId)).deliveryAddress,
        "Delivery",
      );
      assert.equal((await f.service.own(f.ca)).items[0].contactName, "Contact");
    },
  );
  test(
    provider +
      ": HTTP enforces own/internal routes, body bounds, version and canonical envelopes",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        server = createApp({
          sessions: f.auth,
          deliveryAddresses: f.service,
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
      const base = "http://127.0.0.1:" + server.address().port + "/api/v1";
      const token = (await f.login(2)).accessToken,
        cu = (await f.login(3)).accessToken;
      const request = (path, proof = token, body) =>
        fetch(base + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: "Bearer " + proof,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const response = await request("/delivery-addresses");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const current = (await response.json()).data;
      assert.equal(current.companyId, f.companyId);
      const body = {
        version: current.version,
        action: "create",
        fields: fields(),
        makeDefault: false,
      };
      assert.equal(
        (await request("/delivery-addresses", cu, body)).status,
        403,
      );
      assert.equal(
        (await request("/companies/" + f.companyId + "/delivery-addresses"))
          .status,
        403,
      );
      assert.equal(
        (await request("/delivery-addresses?companyId=" + f.otherId)).status,
        400,
      );
      assert.equal(
        (
          await request("/delivery-addresses", token, {
            ...body,
            actorUserId: randomUUID(),
          })
        ).status,
        400,
      );
      const result = await request("/delivery-addresses", token, body);
      assert.equal(result.status, 200);
      const saved = (await result.json()).data;
      assert.equal(saved.addresses.items.length, 2);
      assert.ok(saved.addresses.items.some((r) => r.id === saved.addressId));
      assert.equal(
        (await request("/delivery-addresses", token, body)).status,
        409,
      );
      assert.equal(
        (
          await request("/delivery-addresses", token, {
            version: saved.addresses.version,
            action: "update",
            addressId: f.foreign.id,
            fields: fields(),
          })
        ).status,
        404,
      );
    },
  );
}
test("collection cap includes retained inactive history; no mutation or silent truncation on overflow", () => {
  const companyId = randomUUID(),
    items = Array.from({ length: 200 }, () => ({
      id: randomUUID(),
      ...fields(),
      active: false,
      isDefault: false,
    })),
    current = addressCollection(companyId, items);
  assert.throws(
    () =>
      changeAddresses(current, {
        version: current.version,
        action: "create",
        fields: fields(),
        makeDefault: false,
      }),
    (e) => e.code === "conflict",
  );
  assert.throws(
    () =>
      addressCollection(companyId, [
        ...items,
        { ...items[0], id: randomUUID() },
      ]),
    (e) => e.code === "unavailable",
  );
  assert.equal(current.items.length, 200);
});
test("JSON atomic publication failure before and after rename leaves an intact old or new collection", async (t) => {
  for (const stage of ["before", "after"]) {
    let armed = false;
    const io = {
      ...fs,
      rename: async (...args) => {
        if (armed && stage === "before") throw Error("PRIVATE");
        return fs.rename(...args);
      },
    };
    const f = await fixture(t, "json", io, async () => {
      if (armed && stage === "after") throw Error("PRIVATE");
    });
    const initial = await f.service.own(f.ca);
    armed = true;
    await assert.rejects(
      f.service.change(f.ca, {
        version: initial.version,
        action: "create",
        fields: fields(),
        makeDefault: true,
      }),
      (e) => e.code === "unavailable",
    );
    armed = false;
    const current = await f.service.own(f.ca);
    assert.equal(current.items.length, stage === "before" ? 1 : 2);
    assert.equal(current.items.filter((r) => r.isDefault).length, 1);
  }
});
test(
  "real SQL failure rolls back default clear and all address updates",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, "postgresql");
    await f.pool.query(
      "CREATE FUNCTION reject_address() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''synthetic failure''; END';CREATE TRIGGER reject_address BEFORE UPDATE ON delivery_addresses FOR EACH ROW EXECUTE FUNCTION reject_address()",
    );
    const current = await f.service.own(f.ca);
    await assert.rejects(
      f.service.change(f.ca, {
        version: current.version,
        action: "create",
        fields: fields(),
        makeDefault: true,
      }),
      (e) => e.code === "unavailable",
    );
    const after = await f.service.own(f.ca);
    assert.deepEqual(after, current);
  },
);

test("corrupt address fields are unavailable provider state rather than invalid caller input", async (t) => {
  const f = await fixture(t, "json");
  await fs.writeFile(
    join(f.directory, "delivery_addresses.json"),
    JSON.stringify([{ ...f.legacy, label: "" }, f.foreign]),
  );
  await assert.rejects(f.service.own(f.ca), (e) => e.code === "unavailable");
});
