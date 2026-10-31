# Explicit catalog synchronization/cache (B2B-034)

The backend `CatalogSource` port returns an ERP-neutral snapshot; a bounded Mock
adapter translates `/mock-erp/v1/master-data` without importing Mock service code.
Products, prices and eligibility remain ERP-authoritative. The sync validates a
complete nonempty product snapshot before acquiring a mutation target: bounded
arrays/strings, unique references/SKUs/pairs, valid referenced customers/products,
exact decimal strings, currencies and start-inclusive/end-exclusive price windows.
One price row per product/customer (or default) is supported by the current schema;
ambiguous multiple windows are rejected rather than guessed. The adapter enforces
the existing ERP deadline/cancellation, JSON/UTF-8, no redirects and a 1 MiB limit.

Existing ERP-linked portal companies are mapped, never created, renamed, activated
or overwritten. Unknown/unlinked ERP customers are not granted portal access.
Inactive ERP customers lose cached eligibility without altering portal account
status. ERP product references preserve portal UUIDs on repeat sync; legacy JSON
records may match an unambiguous SKU. New products receive backend UUIDs. Missing
products are retained inactive with no price so historical references remain;
SKU conflicts fail safely. Current read projections intentionally exclude the
internal ERP reference. Browsing cache does not replace live submit-time price,
stock, credit or account validation. Inventory/credit/pack presentation and full
commercial projections remain their own issues.

## Commands and mutation safety

Configure `ERP_BASE_URL` and optional bounded `ERP_TIMEOUT_MS` privately as for the
existing gateway. No listener, credentials or frontend are needed by the command.
There is no public sync route, boot-time synchronization or scheduler.

With the API stopped, seed a dedicated confirmed demo target first. For JSON:

```powershell
npm run sync:catalog --workspace=@b2b-portal/api -- --provider json --directory D:/Developer/Projects/b2b-portal/apps/api/data/b2b_demo_local --confirm-target b2b_demo_local --offline
```

JSON refresh requires `--offline`, the existing seed ownership marker, exact
dedicated-target confirmation and only known regular files. It shares the seed
lock, copies the entire directory into a sibling staging directory, replaces the
three catalog collections there, then swaps directories with a recovery backup.
Company, user, order and known private note/audit files are preserved byte-for-byte.
It does not claim live cross-file transactions: stop the API/other writers first.
Publication failure attempts restoration; an interrupted/failed restore or cleanup
may leave a backup for manual recovery. Unknown files/links/stale locks refuse
mutation; no recursive unknown-data deletion or startup repair.

For PostgreSQL, set `DATABASE_URL` to the already migrated/seeded dedicated local
`b2b_demo_<suffix>` database, then run:

```powershell
npm run sync:catalog --workspace=@b2b-portal/api -- --provider postgresql --confirm-target b2b_demo_local
```

The explicit demo CLI accepts only confirmed loopback demo databases. It never
selects or falls back to another provider, migrates or seeds. The SQL repository
holds an advisory/catalog-table lock while mapping existing IDs and updating
products/access/prices in one transaction. Readers see old or committed data;
failed validation/SQL rolls back, never a partial cache. Portal-owned company,
user and order records are not changed. Existing SQL product columns outside the
current sync projection remain untouched; they are not claimed fresh inventory.

Success logs only counts. Failure is nonzero with a fixed redacted diagnostic,
not an upstream payload, SQL error, URL, path or commercial data. The API's read
ports can consume the refreshed files/database normally after JSON restart.

## Verification

Run `npm run check`. Catalog sync tests exercise actual Mock HTTP and command
execution, stable IDs/rerun, customer eligibility/prices, stale product retirement,
unchanged portal/private files, invalid/cancelled/oversized upstream data, unknown
target refusal and no publication on failure. The existing local CREATEDB test
opt-in verifies real SQL transactions, rollback and read-port parity with JSON.
