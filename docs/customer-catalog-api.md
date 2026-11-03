# Customer catalog API (#47)

Customer Admin and Customer User use normal Bearer authentication:

- `GET /api/v1/catalog/products?offset=0&limit=20`
- `GET /api/v1/catalog/products/:productId`

The API derives the company exclusively from the current authenticated actor.
Company/customer/role selectors and unsupported query keys are rejected with 400. Detail accepts no query. Internal Admin and Sales use
the separate company-scoped API and cannot use these customer endpoints.
The existing Sales assignment integration remains a separate #34 dependency.

Successful responses use the existing `{success:true,data,requestId}` envelope
and `Cache-Control: no-store`. List data is
`{items,total,offset,limit}`; detail data is `{product}`.
Offset is an integer from 0 through 100,000, default 0; limit is 1–100, default 20. Both use canonical unsigned decimal digits, without signs, leading zeroes,
fractions or exponent notation. Ordering is product ID ascending, including
when names/SKUs tie. Beyond-end pages return no items and retain the filtered
total. Eligibility and all filters apply before counts and pagination.

## List filters (#48)

| Query key       | Matching rule                                          |
| --------------- | ------------------------------------------------------ |
| name, sku       | Literal substring in the corresponding field           |
| search          | Literal substring in name OR SKU                       |
| category, brand | Exact field equality                                   |
| availability    | `all` (default), `available`, `unavailable`, `unknown` |

All supplied filters combine with AND; `search` retains its internal OR.
Text is limited to 128 UTF-16 code units before trimming; blank/omitted text
means no restriction. C0/C1 control characters and unpaired surrogates are
invalid. Repeated/unknown parameters, array/object values and empty/unsupported
availability values are invalid and return the existing 400
`INVALID_COMPANY_QUERY` envelope. Availability enum values are case-sensitive.
Detail and the older company-scoped catalog routes keep their existing query
contract; these extensions apply to the customer list only.

ASCII A–Z case folds to a–z in both SQL and JSON. Non-ASCII characters match
exactly, without accent folding, Unicode normalization or locale-specific
case conversion. For example, `café` matches `Café`, while `CAFÉ` does not.
SQL binds values and uses literal substring comparison, so `%`, `_`,
backslashes and quotes have no wildcard or SQL syntax meaning.

Availability follows the synchronized Mock catalog producer: known positive
stock is available, known zero is unavailable, null/missing stock is unknown.
Positive fractional stock remains available even below MOQ. No floating-point
conversion, low-stock threshold, MOQ interpretation or submit-time stock
guarantee is introduced. Missing category/brand values cannot match a nonblank
filter.

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

The filter successor `codex/48-catalog-filters` starts at #47's local reviewed
implementation commit `6b0b339` and adds only #48. Review/merge order is clean
#33 integration → #47 → #48. Retarget each successor after its parent is
integrated. The producer PRs are #158 (clean #33 integration) and #159 (#47);
the #48 filter PR targets the #47 branch. Publication does not imply approval
or a completed merge.

## Verification

`apps/api/test/customer-catalog.test.mjs` exercises actual Mock HTTP through
both cache writers, both repositories and authenticated API HTTP for both
customer roles in both companies. It checks different eligibility/prices,
unknown/zero stock, exact MOQ, public allowlists, missing/inaccessible detail,
pagination boundaries, selector rejection, role denial, suspension, forged
actors, override expiry/future/default/null behavior and inactive products.
Adapter failures are checked before any cache publication.

The #48 cases add individual/combined filters, literal wildcard/quote and case
rules, Unicode distinctions, identical-name ordering, tenant-filtered totals,
maximum/beyond-end pages, null/zero/fractional stock, exact large prices, both
customer roles and malformed query rejection before company/catalog I/O.
