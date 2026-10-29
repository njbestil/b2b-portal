# B2B Portal

An npm monorepo for the B2B Portal web app, API, Mock ERP, and shared packages.

## Build

Use Node.js 24 LTS and npm 11. From the repository root:

```sh
npm ci
npm run build
```

The root build runs every workspace build and returns failure if any build fails. The web build
type-checks the React entry point and bundles it with Vite. The services compile
TypeScript into runnable JavaScript. Shared packages emit JavaScript and type
declarations. Generated outputs are written to each workspace's `dist/` directory
and are ignored by Git.

## Workspaces

| Directory             | Package                  | Purpose                                            |
| --------------------- | ------------------------ | -------------------------------------------------- |
| `apps/web`            | `@b2b-portal/web`        | React/TypeScript shell, routing, and design system |
| `apps/api`            | `@b2b-portal/api`        | Minimal Express/TypeScript API entry point         |
| `apps/mock-erp`       | `@b2b-portal/mock-erp`   | Minimal Express/TypeScript Mock ERP entry point    |
| `packages/contracts`  | `@b2b-portal/contracts`  | Shared API response types                          |
| `packages/validation` | `@b2b-portal/validation` | Reserved shared validation module                  |
| `packages/config`     | `@b2b-portal/config`     | Shared server environment validation               |

The validation package is a placeholder. The config package
exposes server environment validation through `@b2b-portal/config/server`;
keep that Node-only entry point out of browser code.

To build an individual workspace, use its package name:

```sh
npm run build --workspace=@b2b-portal/api
```

After building, copy `.env.example` to `.env` at the repository root. Then run
the services in separate terminals:

```sh
npm start --workspace=@b2b-portal/api
npm start --workspace=@b2b-portal/mock-erp
```

Their root responses are available at `http://127.0.0.1:3000/` and
`http://127.0.0.1:3001/`. Run the web shell locally with:

```sh
npm run dev --workspace=@b2b-portal/web
```

Or preview the built web app with:

```sh
npm run preview --workspace=@b2b-portal/web
```

See [the web README](apps/web/README.md) for shell routes, role previews,
design-reference scope, and static-host routing requirements. The shell has no
live authentication or business data; its role selector is not authorization.

## Environment configuration

Both service start commands use Node 24's built-in `.env` loader to read the
root `.env` file. Shell/deployment variables take precedence. The file is
optional when the required variables are already supplied by the environment.

| Variable        | Required by   | Accepted values                        | Example       |
| --------------- | ------------- | -------------------------------------- | ------------- |
| `NODE_ENV`      | Both services | `development`, `test`, or `production` | `development` |
| `API_HOST`      | API           | IP address or `localhost`              | `127.0.0.1`   |
| `API_PORT`      | API           | Integer from 1 to 65535                | `3000`        |
| `MOCK_ERP_HOST` | Mock ERP      | IP address or `localhost`              | `127.0.0.1`   |
| `MOCK_ERP_PORT` | Mock ERP      | Integer from 1 to 65535                | `3001`        |

Each service validates its own required settings before opening a listener.
Missing, blank, or invalid settings cause exit code 1 with variable names and
validation rules, never the supplied values. There are no implicit defaults.
The example preserves the original loopback listeners; use an explicit bind
address such as `0.0.0.0` when the deployment requires it.

The web placeholder currently consumes no custom environment variables.
Database, authentication, and ERP connection variables will be introduced with
their consuming features. Keep real `.env` files untracked; only `.env.example`
is committed.

## API response conventions

The portal API returns JSON success responses with a `success` discriminator,
the route's `data`, and a server-generated `requestId`:

```json
{
  "success": true,
  "data": { "service": "b2b-portal-api" },
  "requestId": "e15a9830-a8f1-466c-9542-8560faec73c4"
}
```

Errors use the same discriminator and request ID with a public code/message:

```json
{
  "success": false,
  "error": { "code": "NOT_FOUND", "message": "Route not found." },
  "requestId": "e15a9830-a8f1-466c-9542-8560faec73c4"
}
```

HTTP status codes remain meaningful (for example 200, 400, 404, or 500). Every
request gets a new UUID in the `X-Request-Id` response header, matching the JSON
body. Incoming request-ID headers are ignored. HEAD responses have no body;
their request ID remains available in the header. Streaming responses that
have already started cannot be replaced with a JSON envelope.

Shared `ApiSuccess<T>`, `ApiFailure`, and `ApiResponse<T>` types are exported
from `@b2b-portal/contracts`. Routes use `sendSuccess` from `apps/api/src/http.ts`.
They can throw `HttpError(statusCode, code, publicMessage)` for intentionally
public HTTP errors; never pass an internal error message into that constructor.
Unexpected server failures return a generic 500 without stacks or internal fields.
JSON parsing errors and unmatched routes use the standard error envelope too.

`createApp` installs request IDs and request logging before the JSON parser, then routes, a JSON
404 handler, and the final error handler. Express 5 forwards rejected route
promises to that handler. The separate Mock ERP retains its external response
format.

## API logging and health

The portal API writes one JSON object per line: info/warn records to stdout,
error records to stderr. Records include an ISO timestamp, level, event, and
service. Startup success and configuration/listener failures are logged;
invalid configuration diagnostics contain only variable names and rules.

Each completed HTTP request logs its server-generated request ID, method,
status code, and elapsed milliseconds. 4xx responses are warnings; 5xx responses
are errors. A disconnected response logs a warning with `outcome: "aborted"`
and no misleading status code. It is logged only once. URLs (including path
parameters and queries), headers, bodies, raw error messages, and stacks are
not logged. There are no transactions yet; transaction correlation belongs
with the future transaction workflows, not a client-supplied header.

`GET /health` (also `HEAD`) reports API, storage, and ERP state. It is a
readiness diagnostic, not just a process-liveness check:

- HTTP 200: `success: true`, with the health report in `data`; all components are up.
- HTTP 503: `success: false`, error code `SERVICE_NOT_READY`, with the report in
  `error.details`. The API is up, but at least one dependency is not ready.

For example, the current default response is:

```json
{
  "success": false,
  "error": {
    "code": "SERVICE_NOT_READY",
    "message": "Required dependencies are not ready.",
    "details": {
      "status": "degraded",
      "api": { "status": "up" },
      "storage": { "status": "unconfigured" },
      "erp": { "status": "unconfigured" }
    }
  },
  "requestId": "e15a9830-a8f1-466c-9542-8560faec73c4"
}
```

Storage/ERP statuses are `up`, `down`, `timeout`, or `unconfigured`. The current
entry point has no storage adapter or ERP gateway, so both are intentionally
`unconfigured` and readiness is 503 even if the separate Mock ERP is running.
This issue does not add those integrations or silently switch storage providers.
Do not configure `/health` as a restart/liveness trigger while they are absent.

Future adapters can supply read-only `healthChecks.storage` and
`healthChecks.erp` probes to `createApp`. A probe receives an `AbortSignal` and
resolves `true` only when usable. Checks run concurrently on every health
request, with a 1000 ms deadline per dependency (overridable through
`healthTimeoutMs` in the app factory). Missing probes are unconfigured;
false/invalid results and thrown/rejected errors are down. A deadline reports
timeout and aborts the probe; adapters must honor the signal to stop their
underlying I/O. No provider details or exception text are returned or logged.
Health reports are not cached (`Cache-Control: no-store`) and produce a
`health.checked` JSON log with the same request ID. Shared `HealthReport` and
`HealthResponse` types are exported from `@b2b-portal/contracts`.

## Shared tooling

Run these commands from the repository root:

| Command                | Purpose                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `npm run build`        | Build all six workspaces                                                    |
| `npm run typecheck`    | Type-check all six workspaces; services first build their config dependency |
| `npm run lint`         | Check JavaScript and TypeScript with ESLint; warnings fail the check        |
| `npm run lint:fix`     | Apply available ESLint fixes                                                |
| `npm run format:check` | Check formatting with Prettier                                              |
| `npm run format`       | Apply Prettier formatting                                                   |
| `npm test`             | Build all workspaces and run environment, API, and web shell tests          |
| `npm run check`        | Run formatting, linting, type checks, builds, and tests in sequence         |

Every workspace also exposes `build`, `typecheck`, `lint`, `lint:fix`, `format`,
and `format:check`. Target any of them with `--workspace`, for example:

```sh
npm run typecheck --workspace=@b2b-portal/web
npm run lint --workspace=@b2b-portal/api
npm run format:check --workspace=@b2b-portal/contracts
npm test --workspace=@b2b-portal/api
```

All workspace TypeScript configurations extend `tsconfig.base.json`. It owns
the strict compiler defaults, ES2022 target, and NodeNext module settings.
Workspaces retain their own input/output paths. The web app overrides the
module settings for Vite and includes DOM libraries; services opt into Node
types, as does the server config package. Contracts and validation have no
ambient platform types. Service build/typecheck commands build their shared
dependencies first, so they also work from a clean checkout.

ESLint uses the recommended JavaScript and TypeScript rules, Node/browser
globals in their respective apps, and React Hooks rules in the web app.
Prettier owns formatting, using its defaults with LF line endings. ESLint's
formatting rules are disabled through `eslint-config-prettier`. Generated
`dist/`, `node_modules/`, and `coverage/` directories are ignored by both tools;
Prettier also ignores the npm-generated lockfile. Workspace formatting commands
explicitly use the root ignore file, including when run from a workspace directory.

TypeScript is pinned to 6.0.3 to stay within the supported range of
`typescript-eslint` 8.72.1 (`>=4.8.4 <6.1.0`). Keep those dependencies compatible
when upgrading; use `npm ci` to install the committed lockfile.

ERP scenarios and application workflows belong to later issues.

The API's initial company/user/catalog/order repository contracts and injected
application query services are documented in [the API README](apps/api/README.md).
They are backend-only read ports, not concrete storage adapters or new HTTP routes.
