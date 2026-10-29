# JSON storage engine

B2B-011 implements the existing backend-only read ports: company profile lookup,
customer user lookup/list, eligible catalog lookup/list and order summary lookup/list.
Application query services accept these adapters without changing their contracts.
This is not the complete MVP entity model, business CRUD or authentication storage.

## Composition and files

Create one `JsonFileStore` per trusted local directory/process, then pass it to
`createJsonRepositories`. A backend composition example, run from repository root
after building the workspaces:

```js
import { resolve } from "node:path";
import { JsonFileStore } from "./apps/api/dist/infrastructure/json/store.js";
import { createJsonRepositories } from "./apps/api/dist/infrastructure/json/repositories.js";

const store = new JsonFileStore(resolve("apps/api/data/runtime"));
const repositories = createJsonRepositories(store);
// Supply these ports to the existing application query services.
// The configured directory must already contain the required data files.
```

The directory is backend configuration, never an HTTP parameter. Collection names
are allowlisted, not file paths. Reads do not create files or default missing data
to empty arrays. No directory, environment variable, provider selection, HTTP route
or health probe is automatically configured in API startup by this issue.

Each file is a JSON array. `models.ts` and `schema.ts` under
`apps/api/src/infrastructure/json/` define the initial cache/projection format:

| File                           | Record shape                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `companies.json`               | Existing `CompanyProfile` projection                                                                                                  |
| `users.json`                   | ID, nullable company ID, display name, four-role enum, account status; customer roles require company ID, internal roles require null |
| `products.json`                | Catalog product fields except resolved price, plus `active` and nullable `defaultPrice`                                               |
| `customer_product_access.json` | Company ID, product ID, `eligible` boolean                                                                                            |
| `customer_product_prices.json` | Company ID, product ID, one customer `price` candidate                                                                                |
| `orders.json`                  | Existing `OrderSummary` projection; business and integration statuses remain independent                                              |

Price candidates contain exact decimal-string `amount`, uppercase three-letter
`currency`, and required nullable UTC `validFrom` / `validTo` timestamps. These are
initial cache shapes, not a new authoritative ERP/business schema or price history.
Synchronization/import features must extend them when more operations are needed.
No credentials, sessions, full order items/snapshots, internal notes or ERP error
details are part of these projections.

## Validation and read behavior

UUIDs normalize to lowercase across records and lookup scopes. Timestamps must be
valid UTC ISO-8601 strings (seconds, optional 1–3 fractional digits) and normalize to
millisecond precision. Decimal values remain strings: MOQ must be positive; prices
may be zero but not negative. Numbers, exponents and leading-zero integer forms
are rejected. Duplicate entity IDs and duplicate company/product pairs are rejected
after UUID normalization. Cross-file foreign-key validation is not implemented.

Parsers return fresh known-field projections. Unknown fields are ignored and never
returned; replacement persists only the documented fields, not arbitrary extra
business fields. Extend the schema before persisting later features—do not use this
primitive as a lossless full-entity update mechanism. Input arrays/objects are
snapshotted before writes await I/O, and reads return detached data without a cache.

Adapters copy/validate scope and pagination before I/O. Tenant filtering happens
before lookup/count/pagination. User lists exclude internal roles and sort by ID;
orders sort by normalized creation time descending then ID; catalog sorts by ID.
Empty/missing/out-of-scope records follow the existing null/empty-page contracts.
Storage/schema failures reject instead of pretending a record is missing.

Catalog reads require an explicit eligible access row and an active product.
They use a currently valid company price, else a currently valid default price,
else null. Windows include the start and exclude the end; invalid/inverted windows
reject. Other companies' prices cannot participate. This supports browsing reads
only: ERP remains authoritative, and submission-time revalidation is separate.

## Writes and limits

`store.replace(collection, records)` is an explicit whole-collection import/storage
primitive, not a business write method exposed by any repository port. An explicit
empty array creates/replaces an empty collection; ordinary reads never do so.
Validate data first; serialize reads and writes to the same collection on the same instance;
write/sync/close a uniquely named exclusive temporary file in the target directory;
then rename it over the target. Failed publication attempts clean up the temporary
file and return a redacted `JsonStorageError`. Invalid data never replaces old data.
Missing/unreadable/non-regular/symlink files fail, as do corrupt JSON/UTF-8 records.
Errors expose a safe code, not raw paths, payloads or filesystem causes.

Reads see committed whole files and queue after previously requested replacements
on the same instance. Reads and publication do not hold the target open concurrently,
avoiding Windows sharing violations during rename. Await `replace` to observe its
success/failure before dependent work. Replacements are last-request-wins,
not merges or read-modify-write transactions. No interprocess locks, multiple-writer
instance coordination, cross-file snapshots/transactions, crash recovery or
power-loss/directory-sync durability is promised. A process crash may leave a temp
file; startup does not silently delete it. The trusted directory must not be modified
by hostile processes; regular-file checks are not a filesystem race sandbox.
Reads load complete files in memory. Use PostgreSQL for durable/scalable deployments;
hosted ephemeral JSON remains disposable demo state.

## Verification and scope

Run `npm run check` or `npm test --workspace=@b2b-portal/api`. The JSON suite uses
real isolated temporary directories for persistence/reopen, all seven port methods,
injected application consumers, company isolation, pricing boundaries, validation,
exact decimals, detached values, concurrent publication and filesystem failures.
A compile-only fixture verifies compatibility with current repository interfaces.
No PostgreSQL parity result is claimed: SQL repository adapters do not yet exist.

Startup provider selection (B2B-012), demo seed/reset (B2B-013), ERP catalog sync
(B2B-034), authentication and later business write ports remain separate issues.
The tests use fixtures; no demo dataset or populated application data is shipped.

Filesystem API reference: [Node.js file operations](https://nodejs.org/docs/latest-v24.x/api/fs.html).
