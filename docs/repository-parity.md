# Repository parity verification (B2B-083 / #95)

Baseline: `origin/main` at `fae89375d1222e786d585cfbe76af13f98094877`,
captured after fetching on 2026-10-31 (Asia/Dubai). This covers implemented
company/user/catalog/order reads, internal notes, credential lookup/login,
append-only audit and explicit catalog refresh. It does not require unmerged
notifications or sessions, future CRUD, HTTP tenant authorization or catalog UI.

## Criterion-to-test evidence

Acceptance: PostgreSQL and JSON repository implementations pass equivalent
behavior tests. Paths below are relative to `apps/api/test/`.

| Behavior                                               | Existing test evidence and focused extension                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Company/user/catalog/order scoping and missing records | `storage-selection.test.mjs`: **real PostgreSQL: all current read ports match JSON...** runs all seven operations for two companies and an unknown company; crosses user/order IDs, excludes internal users and inactive/ineligible products. `json-storage.test.mjs` asserts concrete tenant results and filtered totals.                                                                                   |
| Ordering, counts and pagination                        | Same shared fixture compares ID ordering, tied order timestamps, offset pages and beyond-end totals. This issue adds limit 100 alongside limit 1. JSON stable-pagination tests assert expected order; `repositories.test.mjs` covers invalid/boundary inputs before I/O.                                                                                                                                     |
| Exact decimals, nulls and price validity               | Shared fixture uses fractional MOQ `0.125`, default amount `10.000000000000000001`, distinct customer prices, null default prices/order numbers/ERP references and start-inclusive/end-exclusive windows. JSON price tests assert expected resolutions; `demo-seed.test.mjs` compares seeded/reopened SQL and JSON.                                                                                          |
| Detached private projections                           | This issue extends the shared real-database test to mutate/refetch all seven operations independently for each adapter: IDs, company IDs, nested price amounts, page arrays and totals. Existing JSON privacy tests inject credential/note/error sentinels; SQL projections are compared to JSON and exclude private order snapshots. Login tests verify customer reads exclude credentials.                 |
| Internal-note append/list and trusted context          | `internal-notes.test.mjs`: **real PostgreSQL and JSON note append, paging and customer projections remain equivalent** compares ten appends, pages/totals, customer order projections and customer-role rejection. Companion tests cover backend authorization, missing/cross-company orders, inactive authors, detached/reopened JSON and SQL failures.                                                     |
| Authentication                                         | `login.test.mjs`: **real PostgreSQL and JSON credentials yield the same principal/failures and private audit, with no user writes** exercises real hashed credentials, roles, missing/wrong credentials, suspended company, deactivated internal user and audit failure. Companion tests cover malformed/disabled hashes, private projections and storage failure redaction. No reusable session is claimed. |
| Append-only audit                                      | `audit.test.mjs`: **real PostgreSQL/JSON audit persistence has identical actor/action/target/time/metadata and FK failure behavior** checks persisted records, nullable anonymous context, detached metadata and missing references. Companion tests cover invalid/private metadata and redacted storage failures.                                                                                           |
| Catalog refresh                                        | `catalog-sync.test.mjs`: **real PostgreSQL sync is transactional, stable, scoped and equivalent to JSON with rollback on SQL failure** compares two-company catalog projections after real Mock HTTP sync, stable IDs/rerun, rollback and preserved portal records. Companion JSON tests cover removed/inactive products/customers, unknown links, validation/cancellation and publication failure.          |
| Documented errors                                      | `repositories.test.mjs` propagates port failures; `json-storage.test.mjs` checks missing/corrupt files, invalid input and failed publication; SQL adapter tests check parameterization/redaction. Errors remain provider-specific controlled failures; parity does not mean identical driver errors.                                                                                                         |
| Startup selection and no runtime fallback              | `storage-selection.test.mjs` tests absent/refused/stalled PostgreSQL, immutable JSON selection, real SQL schema loss/recovery and the actual API process with empty/migrated databases. Runtime SQL errors stay SQL; no silent JSON fallback.                                                                                                                                                                |

## Reproduction

Use Node 24 / npm 11 and `npm ci`. Supply these opt-ins only for a dedicated,
disposable loopback PostgreSQL cluster owned by the test runner. The CLI opt-in
explicitly permits creating/dropping randomly named test databases; schema tests
create/drop randomly named schemas. Never point them at shared application data.
JSON fixtures use fresh temporary directories and clean them through test hooks.

```powershell
$env:B2B_TEST_DATABASE_URL = '<disposable PostgreSQL URL>'
$env:B2B_TEST_MIGRATIONS_DATABASE_URL = $env:B2B_TEST_DATABASE_URL
$env:B2B_TEST_MIGRATIONS_CLI_DATABASE_URL = $env:B2B_TEST_DATABASE_URL
node --test --test-concurrency=1 apps/api/test/repositories.test.mjs apps/api/test/storage-selection.test.mjs apps/api/test/json-storage.test.mjs apps/api/test/internal-notes.test.mjs apps/api/test/login.test.mjs apps/api/test/audit.test.mjs apps/api/test/catalog-sync.test.mjs
npm run check
```

Build before the standalone focused command (`npm run build`); root `check`
builds as part of `npm test`. Tests without the opt-ins explicitly skip SQL;
those skips do not establish database parity.

## Recorded local results — 2026-10-31

- Runtime: Node `24.18.0`, npm `11.16.0`, PostgreSQL `17.6` portable binaries
  (`@embedded-postgres/windows-x64@17.6.0-beta.15`), fresh temporary cluster,
  loopback-only port `55495`, synthetic fixtures. No application/shared database
  was used. Docker Desktop was unavailable, so the portable runtime was used
  outside the repository without changing dependencies.
- `npm ci` and `npm run build`: passed. Build emits the existing React Router
  `use client` bundler warning; build exits successfully.
- Initial focused execution inside the restricted sandbox failed on temporary
  JSON publication/localhost access. Repeating with normal local access passed
  **63/71, eight explicit SQL skips** before the cluster was available. These
  attempts do not establish parity.
- The focused command above with all three PostgreSQL opt-ins: **71/71 passed,
  zero failures, zero skips** (41.36 seconds). This includes the added detached
  projection/max-page assertions and all eight real SQL checks in those suites.
- `npm run check` with all three opt-ins: **passed** format, lint, typecheck,
  workspace build and **207/207 tests, zero failures, zero skips** (test phase
  67.48 seconds). This also runs real migration/schema/seed/reset/pool checks.
- `git diff --check`: passed. Only test coverage and this evidence document
  change; production code, dependencies and schema are unchanged.

These are implementer verification/self-check results. Independent QA and PR
approval remain pending; no merge, deployment or Done claim is made.
