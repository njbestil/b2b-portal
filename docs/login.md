# Credential verification (B2B-015)

This page describes the underlying accepted credential-verification capability.
B2B-016 now [composes it with Bearer sessions](sessions.md) in the operational API.
Configure the session keys explicitly: operational login is unavailable without
them. The safe credential-only result below illustrates the private verifier's
projection; configured HTTP login also returns the session fields in the runbook.

`POST /api/v1/auth/login` accepts exactly `{ "email": "…", "password": "…" }`
as application/json, at most 4 KiB uncompressed. Passwords retain whitespace and
are limited to 1024 UTF-8 bytes; emails are trimmed/lowercased. Use TLS for any
non-local use. Success follows the standard API envelope:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "00000000-0000-0000-0000-000000000001",
      "companyId": null,
      "displayName": "Synthetic administrator",
      "role": "INTERNAL_ADMIN",
      "mustChangePassword": true
    }
  },
  "requestId": "00000000-0000-0000-0000-000000000002"
}
```

The underlying verifier grants no business-resource access. B2B-016 adds the
separate persisted Bearer session producer; first-login password change,
reset, RBAC and login UI remain separate issues. Treat mustChangePassword as a
requirement for that forthcoming flow, not permission to skip it.

Only ACTIVE users qualify. Customer roles also need an ACTIVE linked company;
internal roles have no company. Unknown users, wrong passwords, inactive accounts
and disabled/unsupported hashes all return 401 INVALID_CREDENTIALS. Bad shape is
400, unsupported encoding/media type 415, oversized input 413, excess attempts
429 (Retry-After), and unavailable storage/audit/hash capacity 503. Responses use
Cache-Control: no-store. Request logs omit paths, bodies and credentials.

Both credential reads and security audit writes use the one startup-selected
provider; runtime failures never fall back. JSON credentials are optional private
fields on users.json: email, passwordHash and mustChangePassword. Rows with email
require all three and unique normalized email. Existing seed/demo users are
unprovisioned or contain disabled hashes; they do not acquire usable passwords.
Credential provisioning is an explicit backend responsibility for future account
work. Never store plaintext passwords, paste real credentials into issues/commands,
or expose the private authentication repository through a customer read endpoint.

The backend hashPassword primitive produces versioned salted scrypt hashes. Login
is read-only with respect to users, passwords and account status. See
[ADR-003](adr/003-password-credential-verification.md) for parameters, resource
bounds, deployment limitations and review status. Security audit records contain
verified actor IDs on success, anonymous failure context and request/outcome codes;
no password/hash/email or raw request payload.
