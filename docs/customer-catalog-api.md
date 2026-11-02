# Customer catalog API (#47)

Customer Admin and Customer User use normal Bearer authentication:

- `GET /api/v1/catalog/products?offset=0&limit=20`
- `GET /api/v1/catalog/products/:productId`

The API derives the company exclusively from the current authenticated actor.
Company/customer/role selectors and all query keys except list offset/limit
are rejected with 400. Detail accepts no query. Internal Admin and Sales use
the separate company-scoped API and cannot use these customer endpoints.
The existing Sales assignment integration remains a separate #34 dependency.

Successful responses use the existing `{success:true,data,requestId}` envelope
and `Cache-Control: no-store`. List data is
`{items,total,offset,limit}`; detail data is `{product}`.
Offset is a nonnegative safe integer, limit is 1–100, default 20. Ordering is
product ID ascending. Search and filters belong to #48.

Each product contains only:

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| id, sku, name, sellingUom | Strings                                             |
| minimumOrderQuantity      | Exact positive decimal string                       |
| price                     | `{amount: decimal string,currency: string}` or null |
| category, brand           | String or null                                      |
| availableQuantity         | Exact nonnegative decimal string or null            |

Null stock means unknown; zero means unavailable. Neither changes catalog
eligibility. Null price means there is no currently valid browsing price.
No ERP references, raw pricing windows, eligibility rows or internal fields
are exposed. Missing, inactive and ineligible product detail share the same
404 response. Authentication/suspension errors are 401, role denial 403,
invalid queries 400, unavailable storage 503.

## Cache and Mock producer

API reads use only the portal cache. They never call ERP or accept an ERP
customer ID. Existing authorization and active-company checks precede reads.
Eligibility requires an active product and an eligible row for that company.
Prices resolve at read time: valid customer override, then valid default,
then null. Start is inclusive and end exclusive. Exact decimal values, UOM
and MOQ pass through without floating-point arithmetic.

The existing offline developer sync gains the explicit `--customer-catalog`
flag. For example, append it to the documented confirmed JSON/PostgreSQL
`npm run sync:catalog --workspace=@b2b-portal/api -- ...` invocation.
All existing target-confirmation, loopback and JSON-offline restrictions apply.
Without the flag, the legacy master-data source remains selected.

The new adapter consumes #144's paged `/mock-erp/v1/catalog` for every
server-configured source customer from master data. It retains raw price
records and nullable metadata, validates identities, totals, duplicate products,
cross-customer consistency and decimal types before cache publication. Each
response is capped at 1 MiB; pagination and customers are bounded; the whole
snapshot shares a configured timeout/cancellation deadline. Redirects and
non-JSON responses fail. JSON uses its existing offline directory publication;
PostgreSQL updates all cache rows within its existing transaction and locks.
Existing nullable SQL columns are reused; no migration is added.

This adapter is a synthetic Mock consumer, not production ERP acceptance.
Do not run JSON directory publication alongside a live API writer.

## Review stack

The clean parent is `codex/33-main-integration` (759441b), which replays
reviewed #33/#155 onto main while preserving reset and the Mock producers.
This issue branch is `codex/47-customer-catalog`.
Review the clean integration into main first, then retarget this incremental
successor to main. No merge is authorized or performed by this change.

## Verification

`apps/api/test/customer-catalog.test.mjs` exercises actual Mock HTTP through
both cache writers, both repositories and authenticated API HTTP for both
customer roles in both companies. It checks different eligibility/prices,
unknown/zero stock, exact MOQ, public allowlists, missing/inaccessible detail,
pagination boundaries, selector rejection, role denial, suspension, forged
actors, override expiry/future/default/null behavior and inactive products.
Adapter failures are checked before any cache publication.
