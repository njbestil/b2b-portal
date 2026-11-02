import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SessionClient } from "../src/features/authentication/session.ts";
let server,
  ReviewClient,
  reviewApplication,
  ReviewDetail,
  RemoteModel,
  RemoteError,
  createApiTransport,
  App;
const id = "12345678-1234-4234-8234-123456789abc",
  other = "22345678-1234-4234-8234-123456789abc";
// Explicit test-only normalized producer data; never imported into production UI.
const application = {
  companyId: id,
  version: "version-1",
  status: "PENDING",
  companyName: "Synthetic Catering",
  tradeLicenseReference: "TEST-1",
  businessEmail: "business@example.test",
  phone: "555",
  billingAddress: "Synthetic billing",
  deliveryAddress: "Synthetic delivery",
  administratorName: "Synthetic Admin",
  administratorEmail: "admin@example.test",
  administratorMobile: "556",
  createdAt: "2026-11-02T08:00:00Z",
  rejectionReason: null,
  auditState: "unknown",
  notificationState: "unknown",
};
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  ({ ReviewClient, reviewApplication } = await server.ssrLoadModule(
    "/src/features/application-review/api.ts",
  ));
  ({ ReviewDetail } = await server.ssrLoadModule(
    "/src/features/application-review/ReviewPage.tsx",
  ));
  ({ RemoteModel, RemoteError, createApiTransport } =
    await server.ssrLoadModule("/src/shared/remote.ts"));
  ({ App } = await server.ssrLoadModule("/src/app.tsx"));
});
after(async () => server?.close());
const signal = () => new AbortController().signal;
const render = (component, props, path = "/customer-applications") =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(component, props),
    ),
  );
test("review projection strips credentials/private IDs and refuses incomplete bundles or duplicate queue rows", async () => {
  const projected = reviewApplication({
    ...application,
    passwordHash: "DO_NOT_PROJECT",
    administratorUserId: other,
  });
  assert.equal(projected.passwordHash, undefined);
  assert.equal(projected.administratorUserId, undefined);
  for (const value of [
    { ...application, administratorEmail: undefined },
    { ...application, version: "" },
    { ...application, status: "ACTIVE" },
  ])
    assert.throws(() => reviewApplication(value), { code: "unavailable" });
  const client = new ReviewClient({
    async list() {
      return { items: [application, application], total: 2 };
    },
  });
  await assert.rejects(client.list(0, signal()), { code: "unavailable" });
});
test("decisions carry only loaded ID/version and required reason, without actor/status fields or optimistic success", async () => {
  const calls = [];
  const client = new ReviewClient({
    async decide(command) {
      calls.push(command);
      return {
        ...application,
        version: "version-2",
        status: command.decision === "approve" ? "APPROVED" : "REJECTED",
        rejectionReason: command.reason ?? null,
        auditState: "completed",
        notificationState: "pending",
      };
    },
  });
  await assert.rejects(client.decide(application, "reject", " ", signal()), {
    code: "invalid",
  });
  assert.equal(calls.length, 0);
  const rejected = await client.decide(
    application,
    "reject",
    " Review needed ",
    signal(),
  );
  assert.deepEqual(calls[0], {
    companyId: id,
    version: "version-1",
    decision: "reject",
    reason: "Review needed",
  });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.notificationState, "pending");
  await assert.rejects(client.decide(rejected, "approve", "", signal()), {
    code: "conflict",
  });
  const approved = await client.decide(
    application,
    "approve",
    "not sent",
    signal(),
  );
  assert.equal(approved.status, "APPROVED");
  assert.ok(!("reason" in calls[1]));
});
test("wrong target/unchanged success and unavailable producer cannot be interpreted as a saved decision", async () => {
  await assert.rejects(new ReviewClient().detail(id, signal()), {
    code: "unavailable",
  });
  for (const response of [
    application,
    { ...application, companyId: other, status: "APPROVED" },
  ]) {
    const client = new ReviewClient({
      async decide() {
        return response;
      },
    });
    await assert.rejects(client.decide(application, "approve", "", signal()), {
      code: "unavailable",
    });
  }
});
test("model suppresses duplicate writes, preserves old data on uncertainty and demands reload without auto retry", async () => {
  const model = new RemoteModel();
  await model.load(async () => application);
  let release,
    calls = 0;
  const barrier = new Promise((r) => {
    release = r;
  });
  const first = model.write(async () => {
    calls++;
    await barrier;
    throw new RemoteError("unavailable");
  });
  assert.equal(
    await model.write(async () => {
      calls++;
      return application;
    }),
    false,
  );
  assert.equal(model.snapshot().data.status, "PENDING");
  release();
  await first;
  assert.equal(model.snapshot().needsReload, true);
  assert.equal(model.snapshot().saved, false);
  assert.equal(
    await model.write(async () => {
      calls++;
      return application;
    }),
    false,
  );
  assert.equal(calls, 1);
  await model.load(async () => ({ ...application, status: "APPROVED" }));
  assert.equal(model.snapshot().needsReload, false);
  assert.equal(model.snapshot().data.status, "APPROVED");
});
test("cancelled/stale loads cannot publish another application's details", async () => {
  const model = new RemoteModel();
  let release;
  const slow = model.load(async () => {
    await new Promise((r) => {
      release = r;
    });
    return application;
  });
  await model.load(async () => ({ ...application, companyId: other }));
  release();
  await slow;
  assert.equal(model.snapshot().data.companyId, other);
});
test("HTTP boundary requires safe envelopes and maps conflict/forbidden/unavailable without reflecting bodies", async () => {
  for (const [status, code] of [
    [403, "forbidden"],
    [409, "conflict"],
    [412, "conflict"],
    [503, "unavailable"],
  ]) {
    const transport = createApiTransport(
      async () => new Response("DO_NOT_RENDER", { status }),
    );
    await assert.rejects(
      transport(
        {
          path: "/api/v1/admin/applications",
          method: "POST",
          body: { decision: "approve" },
        },
        signal(),
      ),
      (e) => e.code === code && !e.message.includes("DO_NOT_RENDER"),
    );
  }
  const fallback = createApiTransport(
    async () => new Response("<html>fallback</html>"),
  );
  await assert.rejects(
    fallback({ path: "/api/v1/admin/applications", method: "GET" }, signal()),
    { code: "unavailable" },
  );
});
test("real review view has grouped submitted fields/reason labels, active submit buttons and truthful partial event states", () => {
  const state = {
    data: application,
    busy: false,
    error: null,
    needsReload: false,
    saved: false,
  };
  const html = render(ReviewDetail, { state, reload() {}, decide() {} });
  assert.match(html, /name="reason"/);
  assert.match(html, /Reject with reason/);
  assert.match(html, /Approve application/);
  assert.ok(!html.includes('disabled=""'));
  assert.match(html, /role="status"/);
  const recorded = render(ReviewDetail, {
    state: {
      ...state,
      data: {
        ...application,
        status: "APPROVED",
        notificationState: "pending",
      },
      saved: true,
    },
    reload() {},
    decide() {},
  });
  assert.ok(recorded.includes("Decision saved by the server"));
  assert.ok(recorded.includes("pending"));
  assert.ok(!recorded.includes("Approve application"));
  assert.ok(
    recorded.includes(
      "Unknown or pending does not mean a notification was delivered",
    ),
  );
});
test("preview Internal Admin cannot load review data; normal trusted admin gets the actual queue screen", async () => {
  let calls = 0;
  const applicationReview = {
    async list() {
      calls++;
      return { items: [application], total: 1 };
    },
  };
  const preview = render(App, {
    initialRole: "Internal Admin",
    applicationReview,
  });
  assert.ok(preview.includes("authorized Internal Admin"));
  assert.ok(!preview.includes("Synthetic Catering"));
  assert.equal(calls, 0);
  const now = Date.now(),
    user = {
      id,
      companyId: null,
      displayName: "Synthetic Operator",
      role: "INTERNAL_ADMIN",
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
  await sessionClient.login("operator@example.test", "synthetic");
  const real = render(App, { sessionClient, applicationReview });
  assert.ok(real.includes("Review queue"));
  assert.ok(real.includes("Loading applications"));
  assert.equal((real.match(/<main[\s>]/g) ?? []).length, 1);
});
test("normal mutation transport sends Bearer proof once, omits cookies and never replays a failed write", async () => {
  const now = Date.now(),
    user = {
      id,
      companyId: null,
      displayName: "Synthetic Operator",
      role: "INTERNAL_ADMIN",
      mustChangePassword: false,
    };
  let posts = 0;
  const session = new SessionClient(
    async (path, init) => {
      if (path.startsWith("/api/v1/auth/"))
        return new Response(
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
        );
      posts++;
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, "Bearer synthetic-access");
      assert.equal(init.credentials, "omit");
      return new Response("", { status: 401 });
    },
    () => now,
  );
  await session.login("operator@example.test", "synthetic");
  await assert.rejects(
    session.request("/api/v1/admin/applications", {
      method: "POST",
      body: "{}",
    }),
    { code: "session" },
  );
  assert.equal(posts, 1);
  assert.equal(session.snapshot(), null);
});
