import assert from "node:assert/strict";
import { after, before } from "node:test";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer } from "vite";
import {
  canViewPage,
  isRole,
  navigationFor,
  roles,
  workspacePages,
} from "../src/shell/navigation.ts";

let server;
let App;
before(async () => {
  // Exercise the actual TSX through the existing Vite compiler, not a copied UI.
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  ({ App } = await server.ssrLoadModule("/src/app.tsx"));
});
after(async () => server?.close());

function render(path, role = "Customer Admin") {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(App, { initialRole: role }),
    ),
  );
}

const expected = {
  "Customer User": [
    "/dashboard",
    "/catalog",
    "/orders",
    "/invoices",
    "/notifications",
    "/profile",
  ],
  "Customer Admin": [
    "/dashboard",
    "/catalog",
    "/orders",
    "/invoices",
    "/notifications",
    "/company",
    "/users",
    "/profile",
  ],
  "Sales Staff": [
    "/dashboard",
    "/customers",
    "/orders",
    "/notifications",
    "/profile",
  ],
  "Internal Admin": [
    "/dashboard",
    "/customer-applications",
    "/customers",
    "/sales-staff",
    "/orders",
    "/erp-integrations",
    "/audit-logs",
    "/configuration",
    "/notifications",
  ],
};

for (const role of roles) {
  test(`${role}: navigation matches the supplied design's ordering and scope`, () => {
    assert.deepEqual(
      navigationFor(role).map((page) => page.path),
      expected[role],
    );
    const html = render("/dashboard", role);
    const nav = html.match(
      /<nav aria-label="Workspace">([\s\S]*?)<\/nav>/,
    )?.[1];
    assert.ok(nav);
    assert.deepEqual(
      [...nav.matchAll(/href="([^"]+)"/g)].map((match) => match[1]),
      expected[role],
    );
    assert.equal((nav.match(/aria-current="page"/g) ?? []).length, 1);
    assert.match(html, /Shell preview/);
    assert.match(html, /Sample personas only/);
  });
}

test("every registered workspace URL follows the same role policy as navigation", () => {
  for (const role of roles) {
    for (const page of workspacePages) {
      const allowed = expected[role].includes(page.path);
      assert.equal(canViewPage(role, page), allowed, `${role}: ${page.path}`);
      const html = render(page.path, role);
      assert.equal(
        html.includes("Page unavailable for this role"),
        !allowed,
        `${role}: ${page.path}`,
      );
      if (!allowed) {
        assert.ok(
          !html.includes(`${page.label} workspace is ready for its feature`),
        );
      }
      assert.equal((html.match(/<main[\s>]/g) ?? []).length, 1);
      assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
    }
  }
});

test("unknown role values never validate as a preview role", () => {
  for (const role of roles) assert.equal(isRole(role), true);
  for (const value of [
    null,
    undefined,
    {},
    "admin",
    "Internal Admin ",
    "",
    "__proto__",
  ]) {
    assert.equal(isRole(value), false);
  }
});

test("route placeholders preserve semantic landmarks, a skip link, and active location", () => {
  const html = render("/company");
  assert.match(html, /href="#main-content"/);
  assert.match(html, /<main id="main-content" tabindex="-1">/);
  assert.match(html, /<h1 tabindex="-1">Company<\/h1>/);
  assert.match(html, /aria-current="page"[^>]*href="\/company"/);
  assert.match(
    html,
    /Business data and actions will be connected in their own issues/,
  );
  assert.ok(!html.includes("Save changes"));
  assert.ok(!html.includes("PO-24801"));
});

test("unknown addresses produce a safe not-found page without reflecting URL input", () => {
  for (const path of [
    "/does-not-exist",
    "/orders/DO_NOT_REFLECT",
    "/DO_NOT_REFLECT?token=DO_NOT_REFLECT",
  ]) {
    const html = render(path);
    assert.match(html, /<h1 tabindex="-1">Page not found<\/h1>/);
    assert.ok(!html.includes("DO_NOT_REFLECT"));
    assert.match(html, /href="\/dashboard"/);
  }
});

test("public account routes use their own layout without pretending to authenticate or collect credentials", () => {
  for (const path of ["/login", "/apply", "/forgot-password"]) {
    const html = render(path);
    assert.match(html, /class="public-layout"/);
    assert.ok(!html.includes('aria-label="Workspace"'));
    assert.match(html, /No credentials or applications are collected/);
    assert.match(html, /Explore workspace preview/);
    assert.ok(!html.includes("<form"));
    assert.ok(!html.includes("<input"));
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  }
});

test("design system renders both themes with reusable controls, labels, and status text", () => {
  const html = render("/design-system");
  assert.match(html, /aria-current="page"[^>]*href="\/design-system"/);
  assert.match(html, /data-theme="light"/);
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /button-primary/);
  assert.match(html, /button-secondary/);
  assert.match(html, /button-danger/);
  assert.match(html, /button-quiet/);
  assert.match(html, /badge-success/);
  assert.match(html, /badge-warning/);
  assert.match(html, /badge-danger/);
  const inputIds = [...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.equal(inputIds.length, 2);
  assert.equal(new Set(inputIds).size, 2);
  for (const id of inputIds) assert.ok(html.includes(`for="${id}"`));
  for (const button of html.matchAll(/<button([^>]*)>/g)) {
    assert.match(button[1], /type="button"/);
    assert.ok(!/\sdisabled(?:=|\s|$)/.test(button[1]));
  }
});

test("header actions follow the role scope and theme toggle has a stable name", () => {
  for (const role of roles) {
    const html = render("/dashboard", role);
    assert.equal(html.includes("order-link"), role.startsWith("Customer"));
    assert.match(html, /aria-label="Dark theme" aria-pressed="false"/);
    assert.match(html, /aria-label="Notifications"/);
    assert.match(html, /Preview role/);
    assert.match(html, /Exit preview/);
    assert.ok(!html.includes("Sign out"));
  }
});
