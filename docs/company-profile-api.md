# Company profile API (#39)

Normal Bearer sessions are required. Every response uses the standard `{success:true,data:{company},requestId}` or `{success:false,error:{code,message},requestId}` envelope and no-store policy. Backend persistence rechecks current account/company/role, credential-bound session, access expiry and current Sales assignment where applicable.

- GET `/api/v1/company-profile`: Customer Admin/User own company, 200 canonical profile.
- PATCH `/api/v1/company-profile`: Customer Admin own company only; 200 canonical saved profile. Exact flattened `{version,tradeName,primaryContact,businessEmail,phone,billingAddress}` matches the existing companyHttpAdapter.
- GET `/api/v1/companies/:companyId/profile`: Internal Admin or current primary assigned Sales read only; 200 same projection. Customer callers cannot use this route. No internal PATCH.

Canonical profile: `{id,version,legalName,status,tradeLicenseReference,portal:{tradeName,primaryContact,businessEmail,phone,billingAddress},commercial:{erpCustomerReference,paymentTerms,creditStatus}}`. Legal/licence/status and all commercial values are read-only. Missing readonly source values stay null; no credit limit or ERP lookup is invented.

PATCH requires all five portal fields and the loaded version; no extra fields or query selectors. Trading name is trimmed nonempty text <=200. Primary contact <=160, business email <=254, phone <=40 and billing address <=500 are nullable. Blank optional strings normalize to null. Email normalizes to lowercase and must be valid when nonnull. Controls/unpaired surrogates are invalid. The opaque `company-` plus SHA-256 version covers the entire canonical representation, including readonly source values. A stale save conflicts and requires reload; a no-op save may retain its version. It is representation concurrency control, not a command ledger.

POST is not supported. PATCH requires JSON <=8kb, no compression, and is bounded to 30 attempts/actor/minute and four requests in flight per process.

Errors: 400 INVALID_COMPANY_PROFILE_REQUEST or malformed-body INVALID_JSON; 401 INVALID_SESSION; 403 PASSWORD_CHANGE_REQUIRED/FORBIDDEN; 404 COMPANY_PROFILE_NOT_FOUND; 409 COMPANY_PROFILE_CONFLICT; 413 PAYLOAD_TOO_LARGE; 415 UNSUPPORTED_MEDIA_TYPE; 429 RATE_LIMITED; 503 COMPANY_PROFILE_UNAVAILABLE or admission AUTH_UNAVAILABLE. Unknown save outcomes require reload rather than assuming rollback. Do not depend on message strings.

SQL maps primaryContact/contact_name, businessEmail/contact_email, phone/contact_phone and billingAddress/billing_address.line1. Changing a nonnull billing line preserves other existing billing JSON keys; explicit clearing removes the billing address. Only those contact/billing fields and trade_name are updated, under a company/account/session transaction. No migration is needed.

JSON company rows support a checked `portalProfile` override for the four nullable fields; trading name remains the existing top-level field. Original application data supplies legacy contacts until an override is saved. Null overrides stay cleared and never fall back to original values. Application/approval snapshots, credentials, legal/licence/status and readonly ERP metadata remain untouched. Optional readonly tradeLicenseReference/paymentTerms/creditStatus source fields are validated and preserved. Company replacement uses the shared security coordinator and atomic store; incomplete intake/review publication refuses normal profile work. JSON remains single-process with offline maintenance only.

Developer B owns the Web binding in its independent PR. Integrated browser acceptance waits for both layer merges; this API branch contains no Web changes.
