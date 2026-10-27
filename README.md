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

| Directory             | Package                  | Purpose                                         |
| --------------------- | ------------------------ | ----------------------------------------------- |
| `apps/web`            | `@b2b-portal/web`        | Minimal React/TypeScript browser entry point    |
| `apps/api`            | `@b2b-portal/api`        | Minimal Express/TypeScript API entry point      |
| `apps/mock-erp`       | `@b2b-portal/mock-erp`   | Minimal Express/TypeScript Mock ERP entry point |
| `packages/contracts`  | `@b2b-portal/contracts`  | Reserved shared contract module                 |
| `packages/validation` | `@b2b-portal/validation` | Reserved shared validation module               |
| `packages/config`     | `@b2b-portal/config`     | Reserved shared configuration module            |

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

## Shared tooling

Run these commands from the repository root:

| Command                | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `npm run build`        | Build all six workspaces                                             |
| `npm run typecheck`    | Type-check all six workspaces without emitting files                 |
| `npm run lint`         | Check JavaScript and TypeScript with ESLint; warnings fail the check |
| `npm run lint:fix`     | Apply available ESLint fixes                                         |
| `npm run format:check` | Check formatting with Prettier                                       |
| `npm run format`       | Apply Prettier formatting                                            |
| `npm run check`        | Run formatting, linting, type checks, and builds in sequence         |

Every workspace also exposes `build`, `typecheck`, `lint`, `lint:fix`, `format`,
and `format:check`. Target any of them with `--workspace`, for example:

```sh
npm run typecheck --workspace=@b2b-portal/web
npm run lint --workspace=@b2b-portal/api
npm run format:check --workspace=@b2b-portal/contracts
```

All workspace TypeScript configurations extend `tsconfig.base.json`. It owns
the strict compiler defaults, ES2022 target, and NodeNext module settings.
Workspaces retain their own input/output paths. The web app overrides the
module settings for Vite and includes DOM libraries; services opt into Node
types, while shared packages have no ambient platform types.

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

API conventions, health checks, ERP scenarios, application workflows, and the
designed frontend shell belong to later issues.
