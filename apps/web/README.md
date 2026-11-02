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

## Authentication (#35)

Login, first-login password change, recovery receipt, manual proof redemption and
logout use the merged Portal API contracts. Normal sign-in confirms `/auth/me`;
restricted users can change their password or sign out and cannot enter the
workspace. Password changes and resets require a fresh sign-in. The replacement
password policy matches the server, including Unicode character categories and
UTF-8 size limits; passwords are never trimmed or truncated.

Recovery is the protected demo operator workflow: the generic receipt neither
issues a proof nor notifies the operator. The user contacts the operator for
identity verification and enters the protected handoff directly in the form.
There is no email delivery or proof in URLs, browser storage or logs.

Session proofs stay in memory for the loaded tab. Reload and anonymous workspace
navigation require sign-in. The production application has no preview sign-in;
explicit persona injection is a test/story seam only. Connected chrome uses the
API identity and offers real logout. Local state is cleared on logout even if
server revocation cannot be confirmed, with an honest continuation notice.

Refresh is single-flight and stale responses cannot resurrect a cleared session.
Password mutation uncertainty requires fresh sign-in rather than replaying the
write. Transport calls retain the native browser fetch receiver. Tests include
that browser-specific regression and actual API HTTP journeys using isolated
synthetic JSON fixtures; run `npm run test:integration --workspace=@b2b-portal/web`.

Browser checks cover login, first-login change, fresh sign-in, logout, generic
recovery receipt, invalid proof feedback/clearing, keyboard focus and 320px reflow.
Valid reset redemption and post-commit uncertainty are covered by real API HTTP
integration tests. These checks do not establish PostgreSQL parity, production
release readiness or independent QA approval. Other feature adapters described
below retain their separate producer and integration boundaries.

## Staged Internal Admin application review (#38)

`/customer-applications` and `/customer-applications/:companyId` now provide a
bounded queue, submitted business/admin details and approve/reject actions for a
normal Internal Admin session. Preview personas cannot load or decide anything.
The feature projects only the nine #36 application fields, company ID, submission
time, normalized review status/version, rejection reason and reported event
processing states. Credentials and private user/address IDs are discarded.

`ReviewAdapter` is an injectable normalized UI port. Its default is unavailable;
`reviewHttpAdapter` takes explicitly confirmed routes and an authenticated
transport, never a public fetch fallback. Final review DTO/routes/version/reason
bounds are proposed to A in #38; #32 authorization and the actual #38 API remain
integration gates. No application activation, audit append or notification is
implemented by this Web PR. Pending/unknown event processing does not claim
notification delivery or exactly-once publication.

Decision payloads include only the loaded company/version and decision, with a
bounded nonempty reason for rejection. Buttons remain keyboard operable; the
handler/model blocks duplicate writes. Canonical server results drive recorded
states. No optimistic activation or automatic mutation retry is used. Conflict
or uncertain outcomes retain the displayed record and require a reload before
another decision. Async results are cancelled/ignored after navigation.

Small shared remote-state/error/envelope helpers support this batch's profile and
address screens. `SessionClient.request` permits bounded normal-access GET/POST/
PATCH resource operations using its private Bearer proof, omitting cookies and
never replaying a failed mutation. The existing GET-only convenience remains.
No new production package, API route or data migration is added.

This PR is a child of #140 (retargeted to main after #137 merged). Separate #39
and #40 children will consume the shared helpers. Full API/tenant/event and browser
keyboard/responsive integration are still pending; fixtures only verify the UI
port and local state, not backend authorization or persistence parity.

## Staged company profile (#39)

`/company` provides own-company viewing for normal Customer Users/Admins.
Only Customer Admin can edit an active company's portal trading name, primary
contact, business email, phone and billing address. Nullable contact fields can
be cleared explicitly; client bounds/email errors are associated with inputs and
the focused error summary. Legal name/trade licence are read-only; licence changes
require Internal Admin review. ERP reference/payment terms/credit status remain
read-only, and no absent credit-limit amount is invented or accepted as a write.

`/customers/:scopedCompanyId/company` is a view-only context for authenticated
Internal Admin/Sales. Actual #32/#33/#34 permission, tenant and Sales-assignment
checks remain mandatory server-side. Customers cannot select another company
through this route; their adapter receives only `{kind:own}`, not an override.
The Customer User menu now exposes the read screen; it grants no management.

`CompanyAdapter` and its explicit-route HTTP mapper are injectable normalized UI
ports. Production defaults to unavailable. Loaded scope/version and exactly five
portal fields define a save; status/actor/legal/licence/ERP fields are rejected.
Only a validated canonical same-company response marks saved. Conflict/uncertain
failures require reload, with no optimistic changes or automatic write replay.
Company changes remount resource state, and missing contacts/commercial values
remain not supplied. No API mutation or SQL/JSON parity is claimed by fixtures.

This is a child of #149 (#38), consuming its shared async/HTTP helpers. The company
section navigation is preserved; address functionality is delivered by the #40
child, not claimed here. The exact routes/DTO/version/null/billing JSON mapping
and server bounds are handoff questions in #39. The combined issue remains open
until API authorization/persistence integration and browser/review gates pass.

## Staged delivery addresses (#40)

`/company/addresses` completes the company section navigation. Normal own-company
Customer Admin can create/edit/activate/set-default/deactivate. Customer User can
only select supplied active addresses, with no management controls or inactive
counts/history. Internal Admin may inspect authorized history, but receives no
customer-write/ordering impersonation; assigned Sales may view/select active
choices in `/customers/:scopedCompanyId/addresses` after real #34 authorization.

Address editing follows the Figma cards and uses inline labelled forms. The
normalized portal fields are label, `address.line1`, nullable contact name/phone,
and server-controlled active/default/ID. Existing #36 rows provide label/line1/
active/default; contact metadata is not fabricated. Its exact persistence/DTO
extension is an explicit API-owner handoff, not implemented in this Web PR.

`AddressAdapter`/explicit-route HTTP mapper and runtime-validating `AddressClient`
consume a bounded complete scoped snapshot/version. Default production behavior
is unavailable; synthetic data exists only in tests. Commands carry only the
loaded version, action, scoped address target and permitted fields. The API
must derive customer company scope, authorize all object/default references and
perform atomic persistence/audit. No SQL/JSON/API implementation is included.

There is no destructive delete. Deactivating a default requires an explicit
clear or an existing active replacement; no arbitrary replacement is selected.
Canonical results must retain history, contain at most one active default, match
the intended action and avoid unrequested default changes. Failed/uncertain writes
require reload, with no optimistic result or auto replay. Concurrent UI writes
are guarded; stale/cancelled results cannot publish into a new account screen.

Selection stays in component memory and confirms only a choice on this screen,
not an order update/server save. Default selection uses the server's active
default; no default means no arbitrary first-row choice. An inactive/foreign/
missing address cannot be selected. Zero active addresses has no selection submit
and explains that ordering requires an active address. Actual ordering must
revalidate the choice and company/status on the backend.

This child targets #152's company navigation/scope code. Review order is #140 ->
#149 (#38) -> #152 (#39) -> #40 PR; #143 is an independent sibling and its app/style
integration is not claimed by this branch. All combined issues remain open until
their API portions and actual authorization/persistence/browser integration pass.
Browser keyboard/responsive/focus and full root listener tests remain unverified
under the established environment limitation; Node client/model/actual-view SSR
tests are local self-checks, not independent QA or provider-parity evidence.

## Company catalogue (#49)

`/catalog` and `/catalog/:productId` use the customer catalog API through the
normal authenticated SessionClient. The API derives the company from identity;
there is no company selector. Missing/restricted identities and preview personas
cannot issue catalog reads. Production has no fixture or offline success switch.

List and detail use `/api/v1/catalog/products` and `/:productId`. Standard JSON
success envelopes, exact decimal strings and nullable commercial metadata are
validated before display. Unknown price/stock remains unknown. Missing product
images use a decorative placeholder; no remote photo request is made.

Search matches name OR SKU. Category and brand use entered exact values instead
of invented option lists. Availability offers all, available, unavailable and
unknown: positive stock, zero stock and missing stock respectively. The API owns
matching and applies eligibility/filters before count and paging. Text bounds
are 128 UTF-16 units before trimming; controls and malformed URL queries fail
safely. ASCII case folding, literal wildcard characters and deterministic product
ID ordering follow the producer. Offset is 0..100000 and limit is 1..100.

Filters persist through detail/back navigation and changing them resets paging.
Obsolete requests are cancelled and late responses ignored. Native form labels,
status text, focused errors, empty/retry states and focusable unavailable paging
controls are included. Browsing does not reserve stock or enable ordering.

`test/integration/catalog-api.test.mjs` exercises the actual customer API with a
fresh synthetic Mock -> JSON cache fixture: list/detail, tenant prices, foreign
resource denial, combined filters, availability, literal search and pagination.
Run `npm run test:integration --workspace=@b2b-portal/web` from the repository root.
Browser verification covered login, real list/detail/back, combined filters,
empty results, actual missing-product errors, focused headings/errors and 320px
reflow. Screenshots were inspected locally. PostgreSQL and independent review
remain separate evidence gates.

The local review stack consumes #47 at 6b0b339 and #48 at 3b8f983, plus the
merged main/auth batch. Their publication gate must be cleared before this Web
branch is pushed. The existing #143 remains draft until the complete stack can
be published and reviewed; retarget it to the published #48 branch to preserve
an incremental Web diff. Merge tenant integration -> #47 -> #48 -> #143. #140 is
already merged. #50 follows this catalog as a separate issue branch.

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
