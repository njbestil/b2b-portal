# B2B Portal

Initial npm workspace scaffold for [B2B-001 (#13)](https://github.com/njbestil/b2b-portal/issues/13).

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

| Directory | Package | Purpose |
| --- | --- | --- |
| `apps/web` | `@b2b-portal/web` | Minimal React/TypeScript browser entry point |
| `apps/api` | `@b2b-portal/api` | Minimal Express/TypeScript API entry point |
| `apps/mock-erp` | `@b2b-portal/mock-erp` | Minimal Express/TypeScript Mock ERP entry point |
| `packages/contracts` | `@b2b-portal/contracts` | Reserved shared contract module |
| `packages/validation` | `@b2b-portal/validation` | Reserved shared validation module |
| `packages/config` | `@b2b-portal/config` | Reserved shared configuration module |

The shared modules intentionally export no application behavior yet. Each has a
real compiler build so package initialization is verifiable.

To build an individual workspace, use its package name:

```sh
npm run build --workspace=@b2b-portal/api
```

After building, run the services in separate terminals:

```sh
npm start --workspace=@b2b-portal/api
npm start --workspace=@b2b-portal/mock-erp
```

Their placeholder root responses are available at `http://127.0.0.1:3000/` and
`http://127.0.0.1:3001/`. Preview the built web app with:

```sh
npm run preview --workspace=@b2b-portal/web
```

This scaffold includes only the configuration needed to build B2B-001. Shared
TypeScript configuration, linting, formatting, and broader tooling belong to
B2B-002. API conventions, health checks, ERP scenarios, application workflows,
and the designed frontend shell belong to later issues.
