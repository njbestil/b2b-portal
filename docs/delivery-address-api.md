# Delivery address API (#40)

All operations require a normal Bearer session and use the standard success/error envelope with requestId and Cache-Control: no-store. The backend rechecks current account, credential-bound session, role/company, access expiry and applicable Sales assignment at persistence.

- GET `/api/v1/delivery-addresses`: customer own-company collection `{companyId,version,items}`. Customer User sees active addresses only; Customer Admin sees retained history too.
- POST `/api/v1/delivery-addresses`: Customer Admin only, same own company. Returns 200 `{addresses: canonical collection,addressId}`. No tenant/actor/role body selectors.
- GET `/api/v1/companies/:companyId/delivery-addresses`: Internal Admin read-only historical visibility; Sales read-only active addresses for the current active primary assigned company. Customer callers are denied. No internal mutation route.

Every POST includes the loaded opaque version and exactly one action:

- `{version,action:"create",fields,makeDefault}`
- `{version,action:"update",addressId,fields}`
- `{version,action:"activate",addressId}`
- `{version,action:"set-default",addressId}`
- `{version,action:"deactivate",addressId,replacementId}`

Fields are label (trimmed nonempty,100), address exact `{line1}` (trimmed nonempty,500), contactName (nullable,160) and contactPhone (nullable,40). Empty nullable strings normalize to null. Controls and unpaired surrogate characters are invalid. Missing legacy contacts project as null; they are not invented. Company collections are limited to 200 including inactive history; no truncation or deletion.

Version is a SHA-256 representation precondition prefixed `addresses-`, computed from company ID and the full normalized ID-ordered collection, including inactive addresses. It changes with represented state, not request count; a no-op update may retain its version. Treat it as opaque. Reads filtered for Customer User/Sales carry the same full-collection version but cannot mutate. Stale mutations conflict, requiring reload. This is representation concurrency control, not an exactly-once command ledger.

A new address is active and becomes default only when requested. Activation never silently assigns a default. Set-default requires an active address and clears the previous default atomically. Default deactivation explicitly replaces it with another existing active same-company address or clears it with null. Nondefault deactivation accepts only null replacement. History and order references remain intact. Customer User selection is local UI state; order writers must revalidate same-company active address at draft/submit boundaries.

Errors: 400 INVALID_ADDRESS_REQUEST; standard authentication/403 FORBIDDEN; 404 ADDRESS_NOT_FOUND for missing/foreign addresses; 409 ADDRESS_CONFLICT for version/state/cap conflicts; standard 413/415/429; 503 ADDRESS_UNAVAILABLE for corrupt/unconfirmed persistence. POST is bounded to 8kb JSON, 30 requests/actor/minute and four concurrent requests/process. No query selectors are accepted.

PostgreSQL locks company, actor user/session and addresses, clears defaults before setting the successor, and commits all changes transactionally. Existing address JSON stores optional contact values; no migration. JSON atomically replaces the address collection under the shared security coordinator, refuses incomplete intake, validates global uniqueness/tenant/default integrity, and keeps intake/recovery compatible with optional contact fields. A failure after publication can be unconfirmed: reload, never assume rollback. JSON requires one writer process and offline maintenance.

Developer B owns Web binding in a separate PR. This API branch contains no Web changes. Integrated browser acceptance waits for both layer merges.
