# ADR-003: Password credential verification

- Status: Accepted — owner approval recorded 2026-10-31
- Related issue: [B2B-015 / #27](https://github.com/njbestil/b2b-portal/issues/27)
- Dependency: audit service [#125](https://github.com/njbestil/b2b-portal/pull/125)
- Approval: [owner acceptance and PM closeout](https://github.com/njbestil/b2b-portal/issues/27#issuecomment-6543813994)

The approved requirements call for active-user email/password authentication with
securely hashed credentials, a single logical user model, JSON/PostgreSQL parity
and private security audit events. This issue implements credential verification
only. Bearer access/refresh sessions, password change/reset, RBAC and UI remain
their separate issues. A returned profile is not authorization or a reusable
session. No authenticated business-resource routes are introduced.

The implementation uses Node's asynchronous scrypt, fixed N=131072, r=8, p=1,
16 random salt bytes and a 32-byte derived key. The versioned encoding is
`scrypt-v1$<32 lowercase salt hex>$<64 lowercase key hex>`. The work factor is
not read from untrusted stored strings. Comparisons use `timingSafeEqual` over
equal-length buffers. Missing, unsupported and malformed hashes perform the same
derivation using a dummy salt/key and always fail. There is no plaintext or demo
password fallback. Existing seed hashes stay disabled. New hashes use independent
salts; the backend hash primitive is available for later controlled provisioning,
not a public account-creation route or password policy bypass.

These parameters follow the [OWASP scrypt recommendation](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
The [Node crypto API](https://nodejs.org/docs/latest-v24.x/api/crypto.html) supplies
the implementation without a native package or new secret/configuration. Argon2id
would require another reviewed runtime/dependency choice; generic fast hashes and
plaintext comparison are unsuitable. Scrypt consumes roughly 128 MiB per operation:
the process admits at most two operations, without an unbounded queue. Saturation
returns a generic service-unavailable response. Password input is bounded to 1024
UTF-8 bytes without trimming or truncation.

The private authentication repository reads the selected provider's user record.
SQL uses existing email/hash/must-change columns and a parameterized query. JSON
adds optional email/passwordHash/mustChangePassword fields to the existing users
collection, not a parallel account table. Absence of email leaves legacy projections
unprovisioned; orphan unknown credential fields remain excluded. Provisioned rows
require all fields and unique normalized emails. Customer read ports explicitly
project only public fields, including when credentials are present. No migration,
automatic provisioning, rehashing or credential alteration occurs during login.

Email is trimmed and case-normalized consistently with SQL's lower(email) unique
index. A customer must have an ACTIVE user and ACTIVE company; internal users must
have an ACTIVE user and no company. Wrong passwords, unknown accounts, inactive
users/companies and disabled hashes share one 401 response. Repository and required
audit failures fail closed with 503, without provider reselection. Success returns
only the safe user identity/role/company/mustChangePassword projection. The flag
does not bypass the separately required first-login password-change/session flow.

The JSON-only POST /api/v1/auth/login endpoint has a 4 KiB uncompressed body limit,
no-store responses and a bounded process-local limit of ten attempts per direct
peer IP per minute (1000 buckets). Express trust proxy remains disabled. These
limits protect one API process; a multi-instance deployment needs a separately
reviewed shared limiter/trusted-proxy policy. Deploy behind TLS. No token/cookie,
client role/company assertion, IP/email/password/hash logging or permissive CORS
is added. Audit success uses the verified actor; denied attempts use anonymous
context and an allowlisted reason/request ID, never supplied identifiers.

Tests must exercise actual hashes, malformed/disabled credentials, inactive
accounts/companies, private projections, required-audit failure, HTTP limits and
real PostgreSQL/JSON parity. The owner accepted the credential-verification review
and this design on 2026-10-31, as recorded in the approval reference above. That
acceptance excludes the separate B2B-016 session design and does not authorize
merging this documentation update or production deployment.
