import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import {
  SessionClient,
  AuthError,
} from "../src/features/authentication/session.ts";

// Explicit test-only session producer. These proofs are synthetic, not credentials.
const now = Date.parse("2026-11-01T08:00:00Z");
const id = "12345678-1234-4234-8234-123456789abc";
const companyId = "22345678-1234-4234-8234-123456789abc";
const user = {
  id,
  companyId,
  displayName: "Synthetic Admin",
  role: "CUSTOMER_ADMIN",
  mustChangePassword: false,
};
const result = (changes = {}) => ({
  user,
  accessToken: "synthetic-access",
  refreshToken: "synthetic-refresh",
  tokenType: "Bearer",
  expiresIn: 900,
  refreshExpiresAt: new Date(now + 604800000).toISOString(),
  ...changes,
});
const ok = (data) =>
  new Response(JSON.stringify({ success: true, requestId: id, data }), {
    headers: { "content-type": "application/json" },
  });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("normal login confirms current identity with me, sends only exact credentials and keeps proofs out of UI snapshots", async () => {
  const calls = [];
  const client = new SessionClient(
    async (path, init) => {
      calls.push({ path, init });
      return ok(
        path.endsWith("/login")
          ? result({ user: { ...user, unknown: "do-not-project" } })
          : { user },
      );
    },
    () => now,
  );
  await client.login("admin@example.test", " synthetic password ");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    email: "admin@example.test",
    password: " synthetic password ",
  });
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[1].path, "/api/v1/auth/me");
  assert.equal(calls[1].init.headers.Authorization, "Bearer synthetic-access");
  for (const { init } of calls) {
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
  }
  assert.deepEqual(client.snapshot(), user);
  assert.ok(!JSON.stringify(client.snapshot()).includes("synthetic-access"));
});
test("restricted proof never calls normal me or permits business reads", async () => {
  const calls = [];
  const client = new SessionClient(
    async (path) => {
      calls.push(path);
      return ok(result({ user: { ...user, mustChangePassword: true } }));
    },
    () => now,
  );
  await client.login("admin@example.test", "temporary");
  await assert.rejects(client.read("/api/v1/catalog"), { code: "restricted" });
  assert.equal(calls.length, 1);
  assert.equal(client.snapshot().mustChangePassword, true);
});
test("profile-only and malformed token/envelope responses cannot create a session", async () => {
  for (const response of [
    ok({ user }),
    ok(result({ accessToken: "" })),
    ok(result({ expiresIn: 901 })),
    ok(result({ user: { ...user, companyId: null } })),
    new Response("<html>SPA fallback</html>", {
      headers: { "content-type": "text/html" },
    }),
    new Response(JSON.stringify({ success: true, data: result() }), {
      headers: { "content-type": "application/json" },
    }),
  ]) {
    const client = new SessionClient(
      async () => response,
      () => now,
    );
    await assert.rejects(
      client.login("admin@example.test", "temporary"),
      AuthError,
    );
    assert.equal(client.snapshot(), null);
  }
});
test("current-user mismatch and restricted current state deny normal admission", async () => {
  for (const current of [
    { ...user, id: companyId },
    { ...user, role: "CUSTOMER_USER" },
    { ...user, mustChangePassword: true },
  ]) {
    const client = new SessionClient(
      async (path) => ok(path.endsWith("login") ? result() : { user: current }),
      () => now,
    );
    await assert.rejects(client.login("admin@example.test", "temporary"), {
      code: "session",
    });
    assert.equal(client.snapshot(), null);
  }
});
test("concurrent refresh is single-flight; clearing the tab prevents late proof resurrection", async () => {
  const barrier = deferred();
  let refreshes = 0;
  const client = new SessionClient(
    async (path) => {
      if (path.endsWith("/login")) return ok(result());
      if (path.endsWith("/me")) return ok({ user });
      refreshes++;
      await barrier.promise;
      return ok(
        result({ accessToken: "fresh-access", refreshToken: "fresh-refresh" }),
      );
    },
    () => now,
  );
  await client.login("admin@example.test", "temporary");
  const first = client.refresh(),
    second = client.refresh();
  assert.equal(refreshes, 1);
  client.clear();
  barrier.resolve();
  for (const pending of [first, second])
    await assert.rejects(pending, { code: "session" });
  assert.equal(client.snapshot(), null);
});
test("lost refresh response clears proof and is never retried with consumed refresh evidence", async () => {
  let refreshes = 0;
  const client = new SessionClient(
    async (path) => {
      if (path.endsWith("/login")) return ok(result());
      if (path.endsWith("/me")) return ok({ user });
      refreshes++;
      throw new Error("DO_NOT_RENDER");
    },
    () => now,
  );
  await client.login("admin@example.test", "temporary");
  await assert.rejects(client.refresh(), { code: "unavailable" });
  await assert.rejects(client.refresh(), { code: "session" });
  assert.equal(refreshes, 1);
  assert.equal(client.snapshot(), null);
});
test("expired access rotates once for concurrent reads; 401 clears and does not replay business requests", async () => {
  let clock = now,
    refreshes = 0,
    reads = 0;
  const client = new SessionClient(
    async (path, init) => {
      if (path.endsWith("/login")) return ok(result());
      if (path.endsWith("/me")) return ok({ user });
      if (path.endsWith("/refresh")) {
        refreshes++;
        assert.deepEqual(JSON.parse(init.body), {
          refreshToken: "synthetic-refresh",
        });
        return ok(
          result({
            accessToken: "fresh-access",
            refreshToken: "fresh-refresh",
          }),
        );
      }
      reads++;
      assert.equal(init.headers.Authorization, "Bearer fresh-access");
      return new Response("", { status: reads === 3 ? 401 : 200 });
    },
    () => clock,
  );
  await client.login("admin@example.test", "temporary");
  clock += 900000;
  await Promise.all([
    client.read("/api/v1/catalog"),
    client.read("/api/v1/catalog"),
  ]);
  assert.equal(refreshes, 1);
  await assert.rejects(client.read("/api/v1/catalog"), { code: "session" });
  assert.equal(reads, 3);
  assert.equal(client.snapshot(), null);
});
test("safe auth failures never expose response bodies or send proofs to non-API destinations", async () => {
  for (const [status, code] of [
    [400, "invalid"],
    [401, "credentials"],
    [429, "rate"],
    [503, "unavailable"],
  ]) {
    const client = new SessionClient(
      async () => new Response("DO_NOT_RENDER", { status }),
      () => now,
    );
    await assert.rejects(
      client.login("admin@example.test", "temporary"),
      (e) =>
        e instanceof AuthError &&
        e.code === code &&
        !e.message.includes("DO_NOT_RENDER"),
    );
  }
  const client = new SessionClient();
  for (const path of [
    "https://example.test",
    "//example.test",
    "/api/v1/../outside",
    "/api/v1/auth/login",
  ])
    await assert.rejects(client.read(path), { code: "invalid" });
});

let server, App;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  ({ App } = await server.ssrLoadModule("/src/app.tsx"));
});
after(async () => server?.close());
const render = (path, props = {}) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(App, props),
    ),
  );
test("production workspace routes require sign-in; explicit story roles never become authentication", () => {
  for (const path of ["/dashboard", "/catalog", "/orders", "/company"])
    assert.equal(render(path), "");
  const preview = render("/dashboard", { initialRole: "Internal Admin" });
  assert.ok(preview.includes("Shell preview"));
  assert.ok(preview.includes("Sample personas only"));
});
test("login renders the real form with correct autocomplete, recovery/apply links and no durable remember-me promise", () => {
  const html = render("/login");
  assert.equal((html.match(/<main[\s>]/g) ?? []).length, 1);
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.match(html, /autoComplete="current-password"/i);
  assert.match(html, /name="email"/);
  assert.match(html, /name="password"/);
  assert.match(html, /type="submit"/);
  assert.ok(!html.includes('disabled=""'));
  assert.match(html, /href="\/forgot-password"/);
  assert.match(html, /href="\/apply"/);
  assert.ok(!html.includes("Remember me"));
  assert.ok(!html.includes("Explore workspace preview"));
});
test("reset/recovery screens expose the connected forms and protected operator delivery", () => {
  for (const path of ["/forgot-password", "/reset-password"]) {
    const html = render(path);
    assert.match(html, /protected.*operator/);
    assert.ok(!html.includes("awaiting its API connection"));
    assert.ok(!html.includes("send a secure reset link"));
    assert.match(html, /href="\/login"/);
  }
  const html = render("/reset-password");
  for (const name of ["proof", "newPassword", "confirmPassword"])
    assert.match(html, new RegExp(`name="${name}"`));
});
test("restricted and normal API fixtures control the actual router and remove preview identity from connected chrome", async () => {
  for (const restricted of [true, false]) {
    const client = new SessionClient(
      async (path) =>
        ok(
          path.endsWith("/login")
            ? result({ user: { ...user, mustChangePassword: restricted } })
            : { user },
        ),
      () => now,
    );
    await client.login("admin@example.test", "temporary");
    const html = render(restricted ? "/first-login" : "/dashboard", {
      sessionClient: client,
    });
    if (restricted) {
      assert.match(html, /name="currentPassword"/);
      assert.ok(!html.includes('aria-label="Workspace"'));
      assert.equal(render("/dashboard", { sessionClient: client }), "");
    } else {
      assert.ok(html.includes("Synthetic Admin"));
      assert.ok(!html.includes("Omar Khalid"));
      assert.ok(!html.includes("<select"));
      client.clear();
      assert.equal(render("/dashboard", { sessionClient: client }), "");
    }
  }
});
