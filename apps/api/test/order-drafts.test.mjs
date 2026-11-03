import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { authFixture, barrier } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createOrderDrafts } from "../dist/services/order-drafts.js";
import { createJsonOrderDrafts } from "../dist/infrastructure/json/order-drafts.js";
import { createPostgresOrderDrafts } from "../dist/infrastructure/postgres-order-drafts.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { createJsonInternalNotes } from "../dist/infrastructure/json/internal-notes.js";
import { createPostgresInternalNotes } from "../dist/infrastructure/postgres-internal-notes.js";
import { createApp } from "../dist/app.js";
const isCode = (code) => (e) => e.code === code;
const denied = (e) =>
  e.name === "AuthorizationError" ||
  ["forbidden", "invalid_proof", "restricted"].includes(e.code);
async function fixture(t, provider, options = {}) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.repo =
    provider === "json"
      ? createJsonOrderDrafts(f.security, f.now, options)
      : createPostgresOrderDrafts(f.pool, f.now);
  f.events = [];
  f.service = createOrderDrafts(f.repo, async (e) => {
    f.events.push(e);
    return f.record(e);
  });
  f.actor = async (i = 2) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(i)).accessToken,
      "profile.read",
    );
  f.ca = await f.actor();
  f.cu = await f.actor(3);
  f.other = await f.actor(4);
  f.ia = await f.actor(0);
  f.sales = await f.actor(1);
  f.companyId = f.data.companies[0].id;
  f.addresses = [
    {
      id: randomUUID(),
      companyId: f.companyId,
      label: "Active",
      address: { line1: "Synthetic delivery" },
      active: true,
      isDefault: false,
    },
    {
      id: randomUUID(),
      companyId: f.companyId,
      label: "Inactive",
      address: { line1: "Inactive" },
      active: false,
      isDefault: false,
    },
    {
      id: randomUUID(),
      companyId: f.data.companies[1].id,
      label: "Other",
      address: { line1: "Foreign" },
      active: true,
      isDefault: false,
    },
  ];
  if (provider === "json")
    await fs.writeFile(
      join(f.directory, "delivery_addresses.json"),
      JSON.stringify(f.addresses),
    );
  else
    for (const r of f.addresses)
      await f.pool.query(
        "INSERT INTO delivery_addresses(id,company_id,label,address,active,is_default) VALUES($1,$2,$3,$4::jsonb,$5,false)",
        [r.id, r.companyId, r.label, JSON.stringify(r.address), r.active],
      );
  if (provider === "postgresql")
    for (const row of f.data.orders)
      await f.pool.query(
        "INSERT INTO orders(id,company_id,order_number,created_by_user_id,created_at,updated_at,order_status,integration_status) VALUES($1,$2,$3,$4,$5,$5,$6,$7)",
        [
          row.id,
          row.companyId,
          row.orderNumber,
          row.createdByUserId,
          row.createdAt,
          row.status,
          row.integrationStatus,
        ],
      );
  f.create = async (actor = f.ca, body = {}) =>
    (await f.service.create(actor, body, randomUUID())).draft;
  f.orders = async () =>
    provider === "json"
      ? f.security.store.read("orders")
      : (
          await f.pool.query(
            'SELECT id,company_id AS "companyId",created_by_user_id AS "createdByUserId",order_number AS "orderNumber",order_status AS status,integration_status AS "integrationStatus",delivery_address_id AS "deliveryAddressId",created_at AS "createdAt",updated_at AS "updatedAt" FROM orders ORDER BY id',
          )
        ).rows;
  f.state = async (id, status, integrationStatus = "NOT_SENT") => {
    if (provider === "json")
      await f.security.store.replace(
        "orders",
        (await f.security.store.read("orders")).map((r) =>
          r.id === id ? { ...r, status, integrationStatus } : r,
        ),
      );
    else
      await f.pool.query(
        "UPDATE orders SET order_status=$1,integration_status=$2 WHERE id=$3",
        [status, integrationStatus, id],
      );
  };
  f.notes =
    provider === "json"
      ? createJsonInternalNotes(f.directory, f.security)
      : createPostgresInternalNotes(f.pool);
  f.note = (id) => ({
    id: randomUUID(),
    companyId: f.companyId,
    orderId: id,
    authorUserId: f.data.users[0].id,
    note: "PRIVATE internal history",
    createdAt: new Date(f.now()).toISOString(),
  });
  f.noteActor = {
    id: f.data.users[0].id,
    role: "INTERNAL_ADMIN",
    status: "ACTIVE",
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
      ": both customer roles create/read/update/delete only server-owned drafts; unrelated history and summary contracts remain intact",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        before = await f.orders(),
        draft = await f.create(f.ca, { deliveryAddressId: f.addresses[0].id });
      assert.deepEqual(
        Object.keys(draft).sort(),
        [
          "id",
          "companyId",
          "createdByUserId",
          "orderNumber",
          "createdAt",
          "updatedAt",
          "status",
          "integrationStatus",
          "deliveryAddressId",
          "version",
        ].sort(),
      );
      assert.equal(draft.companyId, f.companyId);
      assert.equal(draft.createdByUserId, f.ca.userId);
      assert.equal(draft.orderNumber, null);
      assert.equal(draft.status, "DRAFT");
      assert.equal(draft.integrationStatus, "NOT_SENT");
      assert.equal(draft.deliveryAddressId, f.addresses[0].id);
      assert.equal(draft.createdAt, new Date(f.now()).toISOString());
      assert.equal(draft.updatedAt, draft.createdAt);
      assert.match(draft.version, /^draft-[a-f0-9]{64}$/);
      assert.deepEqual((await f.service.find(f.ca, draft.id)).draft, draft);
      const updated = (
        await f.service.update(
          f.ca,
          draft.id,
          { version: draft.version, deliveryAddressId: null },
          randomUUID(),
        )
      ).draft;
      assert.equal(updated.deliveryAddressId, null);
      assert.ok(Date.parse(updated.updatedAt) > Date.parse(draft.updatedAt));
      assert.notEqual(updated.version, draft.version);
      const readPorts =
        provider === "json"
          ? createJsonRepositories(f.security.store)
          : createPostgresRepositories(f.pool);
      const summary = await readPorts.orders.findById(
        { companyId: f.companyId },
        draft.id,
      );
      assert.equal("deliveryAddressId" in summary, false);
      assert.equal("updatedAt" in summary, false);
      assert.equal("version" in summary, false);
      const cu = await f.create(f.cu);
      assert.equal(cu.createdByUserId, f.cu.userId);
      assert.equal(cu.deliveryAddressId, null);
      assert.notEqual(cu.id, draft.id);
      assert.deepEqual(
        await f.service.remove(
          f.ca,
          updated.id,
          { version: updated.version },
          randomUUID(),
        ),
        { deleted: true, draftId: updated.id },
      );
      await assert.rejects(
        f.service.find(f.ca, updated.id),
        isCode("not_found"),
      );
      assert.deepEqual((await f.service.find(f.cu, cu.id)).draft, cu);
      const remaining = await f.orders();
      for (const old of before)
        assert.deepEqual(
          remaining.find((r) => r.id === old.id),
          old,
        );
      assert.ok(f.events.some((e) => e.action === "order.created"));
      assert.ok(f.events.some((e) => e.action === "order.draft_deleted"));
      assert.equal(JSON.stringify(draft).includes("passwordHash"), false);
    },
  );
  test(
    provider +
      ": creator ownership, company scope and active references deny uniformly before writes",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        draft = await f.create(f.cu),
        before = await f.orders();
      for (const actor of [f.ca, f.other]) {
        await assert.rejects(
          f.service.find(actor, draft.id),
          isCode("not_found"),
        );
        await assert.rejects(
          f.service.update(
            actor,
            draft.id,
            { version: draft.version, deliveryAddressId: null },
            randomUUID(),
          ),
          isCode("not_found"),
        );
        await assert.rejects(
          f.service.remove(
            actor,
            draft.id,
            { version: draft.version },
            randomUUID(),
          ),
          isCode("not_found"),
        );
      }
      for (const id of [f.addresses[1].id, f.addresses[2].id, randomUUID()])
        await assert.rejects(
          f.create(f.ca, { deliveryAddressId: id }),
          isCode("not_found"),
        );
      await assert.rejects(
        f.service.update(
          f.cu,
          draft.id,
          { version: draft.version, deliveryAddressId: f.addresses[2].id },
          randomUUID(),
        ),
        isCode("not_found"),
      );
      assert.deepEqual(await f.orders(), before);
      for (const actor of [f.ia, f.sales, { ...f.ca }])
        await assert.rejects(f.service.create(actor, {}, randomUUID()), denied);
      for (const body of [
        { companyId: f.companyId },
        { createdByUserId: f.ca.userId },
        { status: "DRAFT" },
        { items: [] },
        { deliveryAddressId: undefined },
        { id: randomUUID() },
      ])
        await assert.rejects(
          f.service.create(f.ca, body, randomUUID()),
          isCode("invalid_input"),
        );
    },
  );
  test(
    provider +
      ": conflicting edits/deletes have one winner and non-DRAFT or already-sent state is preserved",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        draft = await f.create();
      const updates = await Promise.allSettled(
        [null, f.addresses[0].id].map((deliveryAddressId) =>
          f.service.update(
            f.ca,
            draft.id,
            { version: draft.version, deliveryAddressId },
            randomUUID(),
          ),
        ),
      );
      assert.equal(updates.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        updates.find((r) => r.status === "rejected").reason.code,
        "conflict",
      );
      const current = (await f.service.find(f.ca, draft.id)).draft;
      const deletes = await Promise.allSettled(
        [1, 2].map(() =>
          f.service.remove(
            f.ca,
            draft.id,
            { version: current.version },
            randomUUID(),
          ),
        ),
      );
      assert.equal(deletes.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        deletes.find((r) => r.status === "rejected").reason.code,
        "not_found",
      );
      for (const [status, integration] of [
        ["SUBMITTED", "PENDING"],
        ["CONFIRMED", "SUCCESS"],
        ["REJECTED", "NOT_SENT"],
        ["DRAFT", "PENDING"],
      ]) {
        const protectedDraft = await f.create();
        await f.state(protectedDraft.id, status, integration);
        const before = await f.orders();
        await assert.rejects(
          f.service.find(f.ca, protectedDraft.id),
          isCode("not_found"),
        );
        await assert.rejects(
          f.service.update(
            f.ca,
            protectedDraft.id,
            { version: protectedDraft.version, deliveryAddressId: null },
            randomUUID(),
          ),
          isCode("conflict"),
        );
        await assert.rejects(
          f.service.remove(
            f.ca,
            protectedDraft.id,
            { version: protectedDraft.version },
            randomUUID(),
          ),
          isCode("conflict"),
        );
        assert.deepEqual(await f.orders(), before);
      }
    },
  );
  test(
    provider +
      ": live account, first-login restriction, revocation and access expiry deny stale capabilities",
    options,
    async (t) => {
      for (const scenario of [
        "suspended",
        "restricted",
        "revoked",
        "expired",
        "company",
      ]) {
        const f = await fixture(t, provider),
          before = await f.orders();
        if (scenario === "suspended")
          await f.setUser({ status: "SUSPENDED" }, 2);
        if (scenario === "restricted")
          await f.setUser({ mustChangePassword: true }, 2);
        if (scenario === "revoked")
          await f.sessions.revoke(f.ca.sessionId, f.ca.userId);
        if (scenario === "expired")
          f.clock.value = Date.parse(f.ca.accessExpiresAt) + 1;
        if (scenario === "company") {
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
        }
        await assert.rejects(f.service.create(f.ca, {}, randomUUID()), denied);
        assert.deepEqual(await f.orders(), before);
      }
    },
  );
  test(
    provider + ": child notes block deletion without disclosure or orphaning",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        draft = await f.create();
      await f.notes.add(
        f.noteActor,
        { companyId: f.companyId },
        f.note(draft.id),
      );
      await assert.rejects(
        f.service.remove(
          f.ca,
          draft.id,
          { version: draft.version },
          randomUUID(),
        ),
        isCode("conflict"),
      );
      assert.deepEqual((await f.service.find(f.ca, draft.id)).draft, draft);
      assert.equal(JSON.stringify(draft).includes("PRIVATE"), false);
    },
  );
  test(
    provider +
      ": required audit failure reports unconfirmed committed state without replay or rollback",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        before = new Set((await f.orders()).map((r) => r.id)),
        unconfirmed = createOrderDrafts(f.repo, async () => {
          throw Error("PRIVATE_AUDIT");
        });
      await assert.rejects(
        unconfirmed.create(f.ca, {}, randomUUID()),
        isCode("unavailable"),
      );
      const row = (await f.orders()).find((r) => !before.has(r.id));
      assert.ok(row);
      const draft = (await f.service.find(f.ca, row.id)).draft;
      await assert.rejects(
        unconfirmed.remove(
          f.ca,
          draft.id,
          { version: draft.version },
          randomUUID(),
        ),
        isCode("unavailable"),
      );
      await assert.rejects(f.service.find(f.ca, draft.id), isCode("not_found"));
    },
  );
  test(
    provider +
      ": actual HTTP methods/envelopes enforce role, owner, body and version boundaries",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        logs = [],
        server = createApp({
          sessions: f.auth,
          orderDrafts: f.service,
          logger: (level, event) => logs.push({ level, event }),
        }).listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(
        () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(r);
          }),
      );
      const base =
          "http://127.0.0.1:" + server.address().port + "/api/v1/order-drafts",
        token = (await f.login(2)).accessToken,
        other = (await f.login(3)).accessToken;
      const send = (path, method = "GET", body, proof = token) =>
        fetch(base + path, {
          method,
          headers: {
            authorization: "Bearer " + proof,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const response = await send("", "POST", {});
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const envelope = await response.json();
      assert.equal(envelope.success, true);
      const draft = envelope.data.draft;
      assert.ok(envelope.requestId);
      assert.equal(
        (await send("/" + draft.id, "GET", undefined, other)).status,
        404,
      );
      assert.equal(
        (await send("?companyId=" + f.companyId, "POST", {})).status,
        400,
      );
      assert.equal((await send("", "POST", { items: [] })).status, 400);
      const ia = (await f.login(0)).accessToken;
      assert.equal((await send("", "POST", {}, ia)).status, 403);
      assert.equal(
        (await send("/" + draft.id, "PATCH", { version: draft.version }))
          .status,
        400,
      );
      const updatedResponse = await send("/" + draft.id, "PATCH", {
        version: draft.version,
        deliveryAddressId: f.addresses[0].id,
      });
      assert.equal(updatedResponse.status, 200);
      const updated = (await updatedResponse.json()).data.draft;
      const stale = await send("/" + draft.id, "DELETE", {
        version: draft.version,
      });
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).error.code, "ORDER_DRAFT_CONFLICT");
      const deleted = await send("/" + draft.id, "DELETE", {
        version: updated.version,
      });
      assert.equal(deleted.status, 200);
      assert.deepEqual((await deleted.json()).data, {
        deleted: true,
        draftId: draft.id,
      });
      assert.equal((await send("/" + draft.id)).status, 404);
      assert.equal(JSON.stringify(logs).includes("passwordHash"), false);
    },
  );
}
test("JSON failures before/after atomic publication preserve complete state for create/update/delete", async (t) => {
  for (const stage of ["before", "after"]) {
    let armed = false,
      security;
    const f = await fixture(t, "json", {
      writeOrders: async (rows) => {
        if (armed && stage === "before") throw Error("PRIVATE");
        await security.store.replace("orders", rows);
        if (armed && stage === "after") throw Error("PRIVATE");
      },
    });
    security = f.security;
    const count = (await f.orders()).length;
    armed = true;
    await assert.rejects(f.create(), isCode("unavailable"));
    armed = false;
    assert.equal(
      (await f.orders()).length,
      count + (stage === "after" ? 1 : 0),
    );
    const draft = await f.create();
    armed = true;
    await assert.rejects(
      f.service.update(
        f.ca,
        draft.id,
        { version: draft.version, deliveryAddressId: f.addresses[0].id },
        randomUUID(),
      ),
      isCode("unavailable"),
    );
    armed = false;
    const current = (await f.service.find(f.ca, draft.id)).draft;
    assert.equal(
      current.deliveryAddressId,
      stage === "after" ? f.addresses[0].id : null,
    );
    armed = true;
    await assert.rejects(
      f.service.remove(
        f.ca,
        current.id,
        { version: current.version },
        randomUUID(),
      ),
      isCode("unavailable"),
    );
    armed = false;
    if (stage === "after")
      await assert.rejects(
        f.service.find(f.ca, current.id),
        isCode("not_found"),
      );
    else
      assert.deepEqual((await f.service.find(f.ca, current.id)).draft, current);
  }
});
test("JSON note publication and draft deletion share ownership and cannot race to an orphan", async (t) => {
  const f = await fixture(t, "json");
  for (let i = 0; i < 6; i++) {
    const draft = await f.create();
    const results = await Promise.allSettled([
      f.notes.add(f.noteActor, { companyId: f.companyId }, f.note(draft.id)),
      f.service.remove(
        f.ca,
        draft.id,
        { version: draft.version },
        randomUUID(),
      ),
    ]);
    const exists = (await f.orders()).some((r) => r.id === draft.id);
    let notes = [];
    try {
      notes = JSON.parse(
        await fs.readFile(
          join(f.directory, "order_internal_notes.json"),
          "utf8",
        ),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const hasNote = notes.some((n) => n.orderId === draft.id);
    assert.equal(hasNote && !exists, false);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  }
});
test("JSON queued expiry is sampled after shared ownership and unsupported private order data is never discarded", async (t) => {
  const f = await fixture(t, "json"),
    entered = barrier(),
    release = barrier();
  const locked = f.security.run(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const creation = f.create();
  f.clock.value = Date.parse(f.ca.accessExpiresAt) + 1;
  release.resolve();
  await locked;
  await assert.rejects(creation, denied);
  f.clock.value -= 120000;
  const actor = await f.actor();
  const raw = JSON.parse(
    await fs.readFile(join(f.directory, "orders.json"), "utf8"),
  );
  raw[0].orderSnapshot = { private: "retained" };
  const bytes = JSON.stringify(raw);
  await fs.writeFile(join(f.directory, "orders.json"), bytes);
  await assert.rejects(f.create(actor), isCode("unavailable"));
  assert.equal(
    await fs.readFile(join(f.directory, "orders.json"), "utf8"),
    bytes,
  );
});
const sqlOptions = {
  skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
    ? "PostgreSQL URL required"
    : false,
};
test(
  "real SQL write failure rolls back create/update/delete and never consumes unrelated history",
  sqlOptions,
  async (t) => {
    const f = await fixture(t, "postgresql");
    const draft = await f.create(),
      before = await f.orders();
    await f.pool.query(
      "CREATE FUNCTION reject_draft_write() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''synthetic failure''; END';CREATE TRIGGER reject_draft_write BEFORE INSERT OR UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION reject_draft_write()",
    );
    await assert.rejects(f.create(), isCode("unavailable"));
    await assert.rejects(
      f.service.update(
        f.ca,
        draft.id,
        { version: draft.version, deliveryAddressId: null },
        randomUUID(),
      ),
      isCode("unavailable"),
    );
    await assert.rejects(
      f.service.remove(
        f.ca,
        draft.id,
        { version: draft.version },
        randomUUID(),
      ),
      isCode("unavailable"),
    );
    assert.deepEqual(await f.orders(), before);
  },
);
test(
  "real SQL company lock wait rechecks access expiry before publication",
  sqlOptions,
  async (t) => {
    const f = await fixture(t, "postgresql"),
      name = "draft-wait-" + randomUUID();
    const pool = new Pool({
      ...f.pool.options,
      max: 1,
      application_name: name,
    });
    t.after(() => pool.end());
    const service = createOrderDrafts(
      createPostgresOrderDrafts(pool, f.now),
      f.record,
    );
    await f.admin.query("BEGIN");
    await f.admin.query("SELECT id FROM companies WHERE id=$1 FOR UPDATE", [
      f.companyId,
    ]);
    const pending = service.create(f.ca, {}, randomUUID());
    let waiting = false;
    try {
      for (let i = 0; i < 100; i++) {
        const result = await f.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
          [name],
        );
        if (result.rows.length) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(waiting, true);
      f.clock.value = Date.parse(f.ca.accessExpiresAt) + 1;
    } finally {
      await f.admin.query("COMMIT");
    }
    await assert.rejects(pending, denied);
    assert.equal((await f.orders()).length, f.data.orders.length);
  },
);

test(
  "real PostgreSQL and JSON legacy draft reads and monotonic updates have the same canonical representation",
  sqlOptions,
  async (t) => {
    const json = await fixture(t, "json"),
      sql = await fixture(t, "postgresql"),
      legacy = json.data.orders.find(
        (r) =>
          r.status === "DRAFT" &&
          r.companyId === json.companyId &&
          r.createdByUserId === json.cu.userId,
      );
    assert.ok(legacy);
    const a = (await json.service.find(json.cu, legacy.id)).draft,
      b = (await sql.service.find(sql.cu, legacy.id)).draft;
    assert.deepEqual(a, b);
    const time = Math.max(json.now(), sql.now());
    json.clock.value = time;
    sql.clock.value = time;
    const left = (
        await json.service.update(
          json.cu,
          a.id,
          { version: a.version, deliveryAddressId: null },
          randomUUID(),
        )
      ).draft,
      right = (
        await sql.service.update(
          sql.cu,
          b.id,
          { version: b.version, deliveryAddressId: null },
          randomUUID(),
        )
      ).draft;
    assert.deepEqual(left, right);
  },
);
test(
  "SQL retains submission evidence even if a legacy row still says DRAFT",
  sqlOptions,
  async (t) => {
    const f = await fixture(t, "postgresql"),
      draft = await f.create();
    await f.pool.query(
      "UPDATE orders SET order_snapshot=$1::jsonb,submitted_at=$2 WHERE id=$3",
      [
        JSON.stringify({ immutable: "retained" }),
        new Date(f.now()).toISOString(),
        draft.id,
      ],
    );
    await assert.rejects(f.service.find(f.ca, draft.id), isCode("not_found"));
    await assert.rejects(
      f.service.update(
        f.ca,
        draft.id,
        { version: draft.version, deliveryAddressId: null },
        randomUUID(),
      ),
      isCode("conflict"),
    );
    await assert.rejects(
      f.service.remove(
        f.ca,
        draft.id,
        { version: draft.version },
        randomUUID(),
      ),
      isCode("conflict"),
    );
    assert.deepEqual(
      (
        await f.pool.query("SELECT order_snapshot FROM orders WHERE id=$1", [
          draft.id,
        ])
      ).rows[0].order_snapshot,
      { immutable: "retained" },
    );
  },
);
test("public service rejects misrouted repository results and never projects private fields", async (t) => {
  const f = await fixture(t, "json"),
    draft = await f.create();
  for (const extra of [
    { companyId: f.other.companyId },
    { createdByUserId: f.cu.userId },
    { id: randomUUID() },
  ]) {
    const service = createOrderDrafts(
      { ...f.repo, find: async () => ({ ...draft, ...extra }) },
      f.record,
    );
    await assert.rejects(service.find(f.ca, draft.id), isCode("unavailable"));
  }
  const service = createOrderDrafts(
    {
      ...f.repo,
      find: async () => ({
        ...draft,
        internalNotes: "PRIVATE",
        orderSnapshot: { private: true },
      }),
    },
    f.record,
  );
  assert.deepEqual((await service.find(f.ca, draft.id)).draft, draft);
});
