# Public customer application intake

`POST /api/v1/customer-applications` accepts a public business application. It
creates only a PENDING company, PENDING initial CUSTOMER_ADMIN and initial default
active delivery address. The owner approved hashing the applicant's password as a
temporary credential with mustChangePassword=true. No session, token, activation
or customer data access is issued. Protected approval/rejection is #38; the public
application/pending UI is #37. First-login password change remains mandatory after
approval. This endpoint does not depend on session/RBAC implementation.

Send an uncompressed JSON object with exactly these fields:

```json
{
  "companyName": "Synthetic Company",
  "tradeLicenseReference": "DEMO-LICENSE",
  "businessEmail": "business@example.test",
  "phone": "5550100",
  "billingAddress": "Synthetic billing address",
  "deliveryAddress": "Synthetic delivery address",
  "administratorName": "Synthetic Administrator",
  "administratorEmail": "administrator@example.test",
  "administratorMobile": "5550101",
  "password": "applicant temporary credential"
}
```

Text is trimmed and bounded: company name 200 UTF-16 code units, licence 100,
phone/mobile 40, addresses 500, administrator name 160; email follows the existing
254-character normalized-email validator. Licence keys are trimmed/uppercased by
the same application function for both providers. Passwords are nonempty, exact
untrimmed UTF-8 up to 1024 bytes and use the accepted bounded scrypt primitive.
Unknown fields, client IDs/roles/status and ERP/commercial fields are rejected.
There is no licence upload or invented UAE-only phone format.

Success is HTTP 202, no-store, with the standard envelope containing
`data: {state: "received", reference: requestId}`. The reference is a fresh opaque
attempt receipt, not a company/user ID or public status-query capability.
Well-formed duplicates by administrator email or licence receive the same shape;
existing credentials/data are not replaced. Cross-matching duplicate keys do not
merge applications. There is no public application directory/read endpoint. Invalid
input is 400, unsupported media/encoding 415, over 16 KiB 413, direct-peer attempt
limit 429, required storage/hash/audit/capacity failure 503. Trust proxy/CORS stay
unchanged. Admission is process-local: ten attempts per peer per minute with 1000
buckets, sixteen in-flight operations plus the existing two-operation hash bound.
No constant-time HTTP claim is made.

## Selected provider and private persistence

The separate backend application port is composed once by the selected storage
runtime. SQL uses one transaction/connection and an intake advisory lock, existing
unique email protection and same-company initial-admin/address references.
Migration 0003 adds private mobile and initial-reference columns; run migrations
explicitly using the existing runbook, never automatically on startup. It does
not activate/provision seed accounts or modify ERP-owned data.

JSON retains submitted metadata privately in the company persistence model,
credentials/mobile in the existing users file and initial delivery records in
private delivery_addresses.json. Existing CompanyProfile/customer-user query
projections remain explicit and do not gain credential/intake fields. Fresh
application storage can initialize company/user files; a partly missing existing
pair refuses mutation. No implicit demo or catalog seed is performed.

One application adapter/coordinator per trusted directory/process serializes a
whole duplicate check and recoverable publication. A bounded private
application_intent.json contains only a validated versioned record with server
IDs, approved normalized fields and hash, never plaintext password. It is
published before company/user/address files. Startup and every subsequent write
or private review read reconcile an outstanding intent idempotently, compare
existing IDs/content exactly and refuse conflict/corruption. No unrelated rows
are deleted or overwritten. A failed recovery returns unavailable. This is
restart recovery with per-file atomic rename, not a cross-file transaction,
power-loss or distributed-writer durability guarantee. Future account writers
must coordinate; reset/catalog refresh are offline only.

The backend-only `applications.pending(companyId)` returns a complete verified
Pending bundle without its hash, for the separately authorized #38 consumer. A
partial/conflicting application cannot be read for approval through this port.
No approval or role check is inferred merely from calling a private method.

An anonymous allowlisted application-received audit event is required before a
successful receipt. Submitted identity is not an authenticated audit actor. If
audit fails after storage commit, HTTP 503 is returned and committed Pending
state remains; retry deduplicates without replacing the original hash. No
atomicity with the separate audit port, automatic backfill or rollback deletion
is claimed. No input bodies, credentials, email or addresses enter HTTP logs or
public errors. Audit integration for later transitions stays with their owners.

Confirmed disposable reset recognizes the known completed delivery file; offline
catalog refresh preserves it and private application metadata. Both refuse an
unresolved intent/unknown files rather than deleting/copying incomplete state.

## Verification

`applications.test.mjs` exercises actual hashing/Pending login denial, safe
projection/receipt/audit behavior, malformed input, duplicate concurrency, actual
filesystem publication/restart recovery/refusal, reset/catalog compatibility and
real SQL/JSON bundle/constraint/rollback behavior in an isolated schema. The real
SQL opt-in is B2B_TEST_MIGRATIONS_DATABASE_URL. Run focused checks and root
`npm run check`; report skips instead of claiming parity from mocks.
