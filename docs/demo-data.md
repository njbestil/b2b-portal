# Reproducible local demo seed/reset (B2B-013)

Run these commands only with the API stopped and an explicitly disposable target.
Nothing seeds, resets or migrates during API startup. The command never falls back
between providers. Unknown/missing arguments or failures return nonzero with a
fixed redacted diagnostic, not a URL/path, SQL exception or record contents.

The deterministic snapshot covers the six implemented read collections: two
companies; all four role profiles; eligible/ineligible catalog rows; customer
prices and fractional MOQ; draft, submitted/failed and confirmed/success order
summaries. IDs, timestamps and exact decimal strings remain stable across reset
and match between PostgreSQL and JSON read ports. These are synthetic reference
projections, **not a completed login, sales assignment or order workflow**.
SQL users have reserved example.test emails and a disabled-login sentinel, never
usable passwords. JSON profiles contain no credentials. B2B-015 owns real hashed
credential provisioning/login; no demo authentication is claimed here.

## JSON

Choose an existing trusted parent and a **new** child directory named
`b2b_demo_<lowercase letters/digits/underscores>` (suffix 1–40 characters).
For example, from the repository root in PowerShell:

```powershell
npm run demo --workspace=@b2b-portal/api -- seed --provider json --directory D:/Developer/Projects/b2b-portal/apps/api/data/b2b_demo_local --confirm-target b2b_demo_local
```

Set `JSON_DATA_DIR` to that absolute directory when starting the API. It now has
the six validated files and can report storage up; overall readiness also needs
the configured ERP. Do not commit generated demo/runtime directories.

To discard edits and restore the deterministic snapshot:

```powershell
npm run demo --workspace=@b2b-portal/api -- reset --provider json --directory D:/Developer/Projects/b2b-portal/apps/api/data/b2b_demo_local --confirm-target b2b_demo_local
```

Seed refuses any existing target. Reset requires the ownership marker `.b2b-demo`,
the exact confirmation and only known regular files. Unknown files, links or
noncanonical parent ancestry refuse mutation. The known B2B-014
`order_internal_notes.json` and `audit_logs.json` files are also owned disposable
demo state: confirmed reset explicitly clears them when present. The command takes an exclusive
sibling lock, stages a full new snapshot, moves the old directory to a uniquely
named backup, then publishes by rename. A failed publication attempts restoration.
Only known owned files are removed, never recursive unknown data deletion. A
failed restore/cleanup may leave a backup for manual recovery; inspect before
rerunning, and never blindly delete a stale lock. Offline, single-process demo
use only; this is not a cross-process live database transaction.

## PostgreSQL

Use a dedicated **local** database named `b2b_demo_<suffix>` with the same naming
rule, not an ordinary/shared database, and a role allowed to migrate/seed it.
Create that empty database explicitly with your local PostgreSQL administration
tool. Set `DATABASE_URL` to that target privately; do not paste credentials into
issues or command history. Only loopback hosts/server addresses are accepted.

Apply the existing versioned migrations explicitly, then seed:

```powershell
npm run migrate --workspace=@b2b-portal/api
npm run demo --workspace=@b2b-portal/api -- seed --provider postgresql --confirm-target b2b_demo_local
npm run demo --workspace=@b2b-portal/api -- reset --provider postgresql --confirm-target b2b_demo_local
```

The last command is destructive **only inside the confirmed, marked dedicated
demo database**: it replaces the 17 core business tables and the known B2B-014
`order_internal_notes` extension when present, preserving migration
history. Seed requires all known business tables empty. Reset requires the schema
ownership comment written by a successful seed. Unknown public tables refuse
operation; no CASCADE, schema/database drops, migration edits or production targets.
An advisory lock and exclusive table locks serialize seed/reset; replacement and
ownership metadata commit atomically or roll back. The marker is a safety guard,
not a security/authentication boundary; never point it at valuable data. Later
schema/collection additions must explicitly extend this tool rather than delete
unknown data. Hosted boot seeding/deployment remains a separate issue.

## Verification

`npm run check` includes deterministic fixtures, actual JSON CLI seed/reset,
reopen/byte parity, concurrent seed exclusion and unsafe-target refusals.
`B2B_TEST_MIGRATIONS_CLI_DATABASE_URL` enables isolated CREATEDB tests: actual
migration and seed/reset CLIs, all seven PostgreSQL/JSON read-port comparisons,
unmarked/unknown-target rejection and rollback after a constraint failure. Use
only a disposable local cluster. Tests remove their generated databases/files.
