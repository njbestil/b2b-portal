# ADR-016: Submission validation against a request-time provider

- Status: Proposed
- Related Issue: njbestil/b2b-portal#54

## Context

Drafts contain item identities and quantities; cached catalog values are not a submit-time price or stock guarantee. The owner chose a global minimum/currency, blocking unknown stock and a live authoritative provider. The project's existing Mock ERP is a synthetic fixed source for development and testing, not a production ERP.

## Options considered

Reading synchronized cache values would silently relax the live-data requirement. Treating a prior validation response as durable would permit stale values and account changes. Implementing submission or reserving stock here would overlap later work.

## Decision

Read server-derived customer/product references from the owned draft, request the existing live Mock catalog, resolve current effective customer/default prices and stock, then recheck ownership, session, draft version and reference context. Evaluate exact decimal quantities and totals against a mandatory configured global minimum; block unknown stock and missing or mismatched prices. Return a bounded preflight result with portal item IDs only. Missing configuration or provider failure is unavailable. Enable the synthetic adapter only in development/test.

## Consequences and verification

The request-time result is not a reservation and may become stale; future submission must revalidate and coordinate with the actual authority at its own boundary. No production provider, ERP submission, state mutation, price-change presentation, snapshot or idempotency is introduced. Real SQL/JSON and Mock HTTP checks exercise ownership, current values, errors and races. See [the API contract](../submission-validation-api.md).
