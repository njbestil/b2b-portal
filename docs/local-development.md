# Local developer setup (#103)

Run Web, API and Mock ERP natively with Node.js 24 LTS and npm 11. Docker
Compose v2 or later is optional and supplies only PostgreSQL 17; it does not containerize
the application services. Commands below use PowerShell from the repository root.
Use a dedicated checkout and disposable local data, never a shared/production store.

## Install and build

```powershell
node --version
npm --version
npm ci
npm run build
```

Do not overwrite an existing `.env`. For a fresh checkout:

```powershell
if (Test-Path .env) { throw 'Inspect the existing .env before continuing.' }
Copy-Item .env.example .env
```

Keep `.env` untracked. It is read by the API/Mock npm start commands; shell
variables take precedence. The Web proxy variable must be set in the Web terminal.
No backend credentials or signing keys belong in `VITE_*` variables or Web builds.

## Default: dedicated JSON storage

With API and every writer stopped, explicitly create a fresh synthetic store.
This is a separate operator step, never an application startup hook:

```powershell
$env:DATABASE_URL = ''
$target = 'b2b_demo_local_' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$dataParent = (Resolve-Path apps/api/data).Path
$env:JSON_DATA_DIR = Join-Path $dataParent $target
node apps/api/dist/demo.js seed --provider json --directory $env:JSON_DATA_DIR --confirm-target $target
if ($LASTEXITCODE -ne 0) { throw 'Seed refused; inspect the target before continuing.' }
$env:ERP_BASE_URL = 'http://127.0.0.1:3001/mock-erp/v1'
npm start --workspace=@b2b-portal/api
```

Keep that terminal open. Record the chosen `JSON_DATA_DIR` for subsequent starts;
reuse it rather than seeding again. A fresh seed has disabled login profiles.
Seed refuses existing targets and noncanonical ancestry. If a sandbox denies
filesystem writes, run these commands in an owner-controlled native terminal;
do not weaken the seed guards. Do not reset data to repair an environment problem.

In a second terminal at the same repository root:

```powershell
npm start --workspace=@b2b-portal/mock-erp
```

In a third terminal:

```powershell
$env:PORTAL_API_PROXY_TARGET = 'http://127.0.0.1:3000'
npm run dev --workspace=@b2b-portal/web -- --port 5173 --strictPort
```

Open <http://127.0.0.1:5173/login>. For the already-built Web bundle, replace
`dev` with `preview`; keep the same explicit port/proxy arguments. Vite's `/api`
proxy connects only to the Portal API, which alone connects to the Mock ERP.
There is no direct browser-to-ERP route and no CORS change is needed.

Listener defaults in `.env.example` are API `127.0.0.1:3000` and Mock ERP
`127.0.0.1:3001`. Override `API_PORT`/`MOCK_ERP_PORT` in their respective terminals
if occupied; update `ERP_BASE_URL` and `PORTAL_API_PROXY_TARGET` to match.
Use `--strictPort` so Web does not silently select a different port. Keep all
host listeners on loopback. No container bind-address override is needed for
these native application processes.

### Authentication and feature configuration are explicit

Infrastructure readiness does not provision usable accounts. Without complete
private [session settings](sessions.md), authentication endpoints return 503.
To enable the four synthetic accounts, stop the API/writers and follow
[isolated demo-account provisioning](demo-accounts.md), using the exact seeded
target, explicit development/demo opt-in, and distinct privately supplied
passwords. Only hashes persist. Clear password variables after the operator
command; supply signing settings privately to the API alone. There is no default
password, automatic provisioning, or role-selector authorization.

Submission preflight additionally needs an explicitly chosen global
`SUBMISSION_MINIMUM_AMOUNT`/`SUBMISSION_MINIMUM_CURRENCY`; see
[submission validation](submission-validation-api.md). This setup chooses no
business minimum and does not make unfinished order/ERP workflows available.

## Optional PostgreSQL through Docker Compose

Requires a running Docker Desktop Linux engine. Check both client and server:

```powershell
docker version
docker compose version
```

Create a private password file outside Git and set `LOCAL_PG_PASSWORD_FILE` to
its absolute path. Supply a distinct generated password through your private
secret channel, never a command argument, shell history, tracked file or log.
The default path is ignored `.local/postgres-password`; protect it with your
OS user-only file permissions. No password is supplied by this repository.
Compose uses that file as a runtime secret; do not print rendered configuration
after adding unrelated private environment settings.
See Docker's [Compose secret documentation](https://docs.docker.com/compose/how-tos/use-secrets/)
and [official PostgreSQL image instructions](https://hub.docker.com/_/postgres).
The image's initialization settings apply only to an empty volume; changing a
password file does not rotate an existing database password.

Use a unique Compose project name so its named volume cannot reuse another
checkout's database. In the same terminal, retain these values for later commands:

```powershell
$env:COMPOSE_PROJECT_NAME = 'b2b-local-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$env:LOCAL_PG_PORT = '5433'
$env:LOCAL_PG_PASSWORD_FILE = (Resolve-Path (Read-Host 'Absolute path to your private PostgreSQL password file')).Path
docker compose --profile postgres config --quiet
docker compose --profile postgres up -d --wait --wait-timeout 90 postgres
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not become ready.' }
docker compose --profile postgres ps
```

Only `127.0.0.1:5433` is published; `LOCAL_PG_PORT` overrides it. The volume
`postgres_data` is namespaced by the unique Compose project. The database is
`b2b_demo_local`, with local development role `b2b_local`. `pg_isready` establishes
listener readiness, not password correctness or application schema readiness.

Stop the native API before changing storage. Privately set `DATABASE_URL` to
this loopback PostgreSQL target using the chosen port, database, role and
URL-encoded password. The password file and URL must agree. Do not paste a
credential-bearing URL into a command or public output. Review and explicitly
apply the existing migrations to this fresh database:

```powershell
$privateUrl = Read-Host 'URL of the owned local disposable PostgreSQL database' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($privateUrl)
try { $env:DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $privateUrl.Dispose()
}
node apps/api/dist/migrate.js
if ($LASTEXITCODE -ne 0) { throw 'Migration failed; do not start the API.' }
$env:ERP_BASE_URL = 'http://127.0.0.1:3001/mock-erp/v1'
npm start --workspace=@b2b-portal/api
```

The direct built migration command consumes shell environment only. Alternatively,
the documented npm migration command also reads root `.env`. Never migrate a
shared/production database as part of this local procedure. Startup itself does
not migrate or seed. An empty migrated database can be healthy without containing
demo accounts or catalog data.

The existing SQL demo seed additionally requires PostgreSQL's **server address**
to be loopback. Docker's published-port connection normally reaches a bridge
address, so that seed refuses it even though the client URL is loopback. Preserve
this guard: use the JSON procedure for a populated local demo, or a dedicated
native loopback PostgreSQL installation with the explicit
[SQL seed procedure](demo-data.md). Do not alter markers or weaken checks to seed
the container. This Compose path verifies empty migrated SQL infrastructure.

The provider is selected once at startup: reachable configured PostgreSQL wins;
unreachable PostgreSQL selects JSON. Check the reported provider before accepting
a SQL run. Runtime failures never switch providers. Restart after changing
`DATABASE_URL`; clear it explicitly when returning to JSON.

## Verify, repeat, and stop

Run these read-only checks while all three processes are running:

```powershell
Invoke-RestMethod http://127.0.0.1:3001/mock-erp/v1/health
Invoke-RestMethod http://127.0.0.1:3001/mock-erp/v1/master-data
Invoke-RestMethod 'http://127.0.0.1:3001/mock-erp/v1/catalog?customerId=DEMO-C001&limit=1'
Invoke-RestMethod http://127.0.0.1:3000/health
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5173/login).StatusCode
# Confirms the Web -> API proxy without disclosing credentials:
try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5173/api/v1/auth/me }
catch { [int]$_.Exception.Response.StatusCode }
```

Expected: Mock health/catalog and Web return 200. API `/health` returns 200 with
`storage.provider` equal to your intended `json` or `postgresql` and ERP up.
The proxy's anonymous `/auth/me` returns 503 without session configuration or
401 with sessions configured; a Web HTML 200 here means routing is wrong.
API root 200 alone does not prove dependency readiness. `/health` is a readiness
diagnostic; missing data, schema or ERP produces a safe 503, not a restart policy.

Stop Mock ERP briefly: API `/health` should become 503 while API root remains
reachable. Restart Mock ERP and readiness should recover without API restart.
For selected SQL, stop/restart only the owned Compose PostgreSQL service and
observe down/up without runtime JSON fallback. Do not stop shared services.

Stop native processes with Ctrl+C in their own terminals. API supports graceful
drain on SIGINT/SIGTERM; forced Windows termination cannot prove graceful cleanup.
Restart with the **same** data path, configuration and ports, without seed/reset
or migrations, then repeat health/Web checks. API shutdown tests use a supported
cross-platform signal harness; a forced process kill is not equivalent evidence.

To stop the owned Compose project while retaining data:

```powershell
docker compose --profile postgres stop postgres
# Or remove only this project's containers/network, retaining its named volume:
docker compose --profile postgres down
```

Retain the project name and password file for restart. No `down --volumes`,
automatic reset, pruning, shared-store deletion or deployment is part of setup.
Inspect failed seed locks/backups before retrying; never blindly remove them.

Run `npm run check` for formatting, lint, types, build and repository tests.
Real PostgreSQL tests require the isolated opt-ins documented in
[PostgreSQL](postgresql.md) and [migrations](migrations.md); skipped SQL or Docker
checks are not evidence that those runtimes work. A Docker daemon error means
Compose startup/recovery checks remain unverified even if config validation passes.
