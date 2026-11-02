# ADR-006: Backend role enforcement

- **Status:** Proposed
- **Related Issue:** njbestil/b2b-portal#32

## Context

Frozen requirements 2.2–2.3 define four roles and separate role permissions,
company ownership and active Sales assignments. Merged #28 provides the current
validated session principal. A login profile or frontend preview role is not
request authentication.

## Options considered

Trusting client role/company claims violates the frozen requirements. Repeating
role tests in every route makes default denial harder to maintain. An explicit
permission matrix with shared admission and service checks keeps the boundary
visible without adding a new authentication system.

## Decision

Propose the implementation in [authorization.md](../authorization.md): derive an
immutable request actor only from #28 validation; deny unknown permission/role
and first-login business access. Keep role policy pure, HTTP admission separate,
and require a private runtime capability in protected services. Company/object
ownership (#33) and active Sales assignment (#34) remain separate checks.
This implements the authorized frozen role boundaries; independent implementation
acceptance remains pending.

## Consequences and risks

Every new business endpoint must declare a permission and apply ownership before
repository access. An allowed role is not a company scope. Actors are ephemeral
server capabilities and must not be stored for future requests. Existing public
intake/authentication flows retain their purpose-specific boundaries.

## Migration / verification

No migration, secret, dependency or new role. Verify the complete current matrix,
real-provider session admission, role updates/revocation, forged actor denial,
privacy and existing session contracts. Do not infer independent QA from
implementer checks.
