# ADR-005: Protected local demo password recovery

- **Status:** Accepted
- **Related Issue:** njbestil/b2b-portal#31
- **Approval scope:** Recovery mechanism approved by the owner; implementation
  remains subject to PR review.

## Context

The MVP requires expiring one-use reset proof and defers email infrastructure.
Locked-out users cannot receive their recovery proof through their inaccessible
in-app notifications.

## Options considered

Public proof responses/log delivery expose usable credentials. Adding an email
provider exceeds the approved MVP scope. A verified local operator can use the
existing operating-system trust boundary for a protected demo handoff.

## Decision

Use the owner-approved protected local operator handoff after recipient identity
verification. [Decision evidence](https://github.com/njbestil/b2b-portal/issues/31#issuecomment-6546630187).
Public receipts are non-enumerating, with no proof. Store hashed expiring evidence,
consume once and require fresh login. Reuse #30's credential publisher and #28's
binding protocol for session invalidation; no independent credential writer.
The concrete contract and operator controls are in
[password-reset.md](../password-reset.md).

## Consequences and risks

Recovery requires a trusted human operator and protected local channel. The
identity-verification flag is an operator acknowledgement. JSON issuance requires
offline ownership because its coordinator is process-local. Failure after a
credential commit may return unavailable while old proof stays unusable.

## Migration / verification

Add only nullable reset binding in migration 0005, without inferring legacy
bindings. Verify real selected-provider one-use, concurrency, interruption,
credential/session consequences, safe delivery and required failures. No
production migration or secret provisioning is authorized by this ADR.
