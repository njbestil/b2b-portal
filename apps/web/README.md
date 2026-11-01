# Gulf Provision web shell

B2B-006 / [issue #18](https://github.com/njbestil/b2b-portal/issues/18) establishes
the application shell. Issue #37 adds the public customer application form and
receipt screen. Other business screens remain scoped to their owning issues.

## Run and check

From the monorepo root:

```sh
npm run dev --workspace=@b2b-portal/web
npm run build --workspace=@b2b-portal/web
npm run preview --workspace=@b2b-portal/web
npm test --workspace=@b2b-portal/web
npm run check
```

Use the Local URL printed by Vite. The web tests use the native Node test runner
and Vite's existing TSX compiler to render the actual application in a memory
router. They cover the full role/route matrix, navigation ordering, public
layouts, not-found pages, semantic markup, and component examples. They are not
browser interaction tests; focus, history, themes, and mobile dialogs also need
browser verification.

## Routing and role previews

The app uses [React Router's declarative routing](https://reactrouter.com/start/declarative/routing)
with a `BrowserRouter`. `/` redirects to `/dashboard`. Links have real URLs,
active-page semantics, and browser back/forward behavior. Direct visits to known
pages work; unknown addresses show an explicit not-found page.

The four menu sets follow the supplied design, in its original ordering:

| Preview role   | Workspace destinations                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Customer User  | Dashboard, Products, Orders, Invoices, Notifications, Profile                                                                |
| Customer Admin | Customer User destinations plus Company and Users, before Profile                                                            |
| Sales Staff    | Dashboard, Customers, Orders, Notifications, Profile                                                                         |
| Internal Admin | Dashboard, Customer Applications, Customers, Sales Staff, Orders, ERP Integrations, Audit Logs, Configuration, Notifications |

Routes are `/dashboard`, `/catalog`, `/orders`, `/invoices`, `/notifications`,
`/company`, `/users`, `/profile`, `/customer-applications`, `/customers`,
`/sales-staff`, `/erp-integrations`, `/audit-logs`, and `/configuration`.
`/design-system` is a shared utility destination for all roles. The account-access
layout has login, first-login, recovery and reset forms. `/apply` submits the
actual ten-field anonymous intake contract to `POST /api/v1/customer-applications`.
Only a validated HTTP 202 receipt opens `/apply/received`; it grants no account
access. The receipt is an attempt reference, with no public status lookup.
“Exit preview” opens the account layout; it is not a logout operation.

Application fields remain in the form DOM only. Passwords clear after transmitted
attempts; errors retain editable non-credential details. Uncertain network/503
outcomes require re-entry of the original password and a deliberate retry, never
an automatic replay. No application data is written to browser storage or URLs.
Receipt history state contains only its opaque reference. A direct receipt URL
without valid state returns to the form.

Vite dev/preview proxies `/api` to `http://127.0.0.1:3000` by default; set the
server-only `PORTAL_API_PROXY_TARGET` to use another local Portal API. Production
hosting must route `/api` to the real Portal API separately from the SPA fallback.
There are no production fixtures or offline success paths. #36/PR #132 supplies
the producer; its merge and real integration remain acceptance dependencies.

## Staged authentication (#35)

The authentication feature consumes the #28 handoff: exact email/password login,
normal-access `/auth/me` confirmation, and serialized single-flight refresh.
Only a complete validated token envelope is a session; credential-only profiles,
SPA HTML and malformed success bodies fail safely. Restricted users go to
`/first-login` and cannot render workspace routes or perform business reads.
Connected workspace chrome uses the returned identity and removes the preview
role selector. Anonymous shell previews remain explicitly labelled; they cannot
supply credentials for data requests. API authorization remains authoritative.

Tokens stay in memory for this loaded tab, with no Remember me persistence or
session lifetime extension. Reload requires a new sign-in. Proofs are sent only
as Bearer headers or the exact refresh JSON body, never URLs, logs or storage.
Refresh is serialized; a lost/failed rotation clears memory and requires fresh
login, with no replay of stale proof. Late responses cannot resurrect cleared
sessions. This is browser behavior, not implementation of backend revocation.

**Draft integration boundary:** first-login/recovery/reset forms own validation,
busy/errors, protected-demo recovery copy, manual proof entry and fresh-login
continuation. Their feature-level `PasswordFlows` port deliberately fails
unavailable in production until #30/#31 provide their exact HTTP contracts. No
route/body/success shape is guessed. Tests may supply clearly labelled ports;
the browser bundle has no fixture success or query/environment switch enabling
one. No email delivery, reset token issuance or password write is claimed.
The form's replacement-password guidance follows Figma; final server-bound
validation must be reconciled with the producer handoff. #29 logout remains a
backend/integration dependency; Account access is a link, not a logout claim.

#35 is transparently stacked on #37's public layout/proxy. Merge #36/#37 and
the applicable auth producers before integrated acceptance of #35. Browser
keyboard, responsive, focus and live API checks remain incomplete due to the
local verification environment; Node transport/race and actual-route SSR tests
are reproducible without running dev servers.

Menus and direct-route preview restrictions use the same role policy. A hidden
destination cannot be rendered simply by typing its URL. This is only UI
scaffolding, **not security enforcement**: future API authentication and backend
role/company/assignment authorization must independently protect real data.
The role selector deliberately remains visible and labeled “Preview role.”
Sample names/companies are design personas, not authenticated users.

Role and theme preferences are stored in session storage solely for preview
continuity on refresh. Invalid roles fall back to Customer Admin; blocked browser
storage does not stop rendering. Switching roles returns to the dashboard.

For a future static-host deployment, rewrite non-asset frontend URLs to
`index.html` so refreshing/deep-linking `/orders`, for example, loads the SPA.
Keep API paths separate from that rewrite. Vite's local dev/preview servers
provide the fallback for local verification. No hosting is configured or
deployed by this issue.

## Design reference and boundaries

Source: the supplied `B2B Food Ordering Portal.zip`, particularly its full
`src/App.tsx` and the relevant `src/index.css` tokens/layout/component rules.
The repository's local `AGENTS.md` identifies the archive location.

The shell adapts its GP monogram, forest/sand palette, icon paths, sidebar/header,
role personas/menu ordering, spacing, rounded surfaces, system/Inter font stack,
and light/dark themes. Tokens live in `src/tokens.css`; reusable Button, Badge,
Field, and Icon components live under `src/shared/`. No remote font is required.
`/design-system` demonstrates both modes, button variants, labeled inputs,
native checkbox/radio controls, badges, and foundation tokens.

Accessibility adaptations include navigation links rather than view-switching
buttons, a skip link, unique page titles and focus on route changes, visible
focus indicators, relative sizing, and a native modal dialog for the mobile
drawer (Escape, focus containment/restoration). Navigation remains available
on short screens via scrolling. Theme control stays accessible on mobile.
Dark primary buttons use dark foreground text and controls use stronger borders
to preserve contrast rather than reproducing the prototype's low-contrast pairs.

The archive also demonstrates complete auth, catalog, company/user management,
ordering, notifications, and ERP/admin screens. Those business screens, photos,
fake metrics, mutations, and decorative auth imagery are intentionally not
imported into this foundation issue. Their routes instead explain that the
feature is not connected. This keeps the visual foundation without implying
that later acceptance criteria have been implemented.
