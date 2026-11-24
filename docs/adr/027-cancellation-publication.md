# ADR-027: Cancellation request and external decision boundary

- Status: Proposed — independent review pending
- Related Issue: [#76](https://github.com/njbestil/b2b-portal/issues/76)

## Context

A cancellation may race an order's first submission or a later fulfillment update. Mock ERP cancellation receipts are process-local and disappear on restart. The portal must retain the request and avoid treating an unknown ERP outcome as a rejection or a safe retry.

## Options considered

Call ERP before persistence, hold database locks across the network, or commit and claim a request before one external call. The first risks losing identity and the second cannot make the external call transactional. The retained claim supports safe failure handling without a distributed exactly-once claim.

## Decision

Authorize against current account, session, tenant and Sales assignment. Lock the submission transaction before the order. Commit idempotency, request and audit with any directly permitted local cancellation. For linked orders, persist and claim a cancellation integration transaction, send once, then recheck linkage and business status before applying a correlated outcome. Unknown and interrupted outcomes require reconciliation; they are never automatically resent. Delivered orders are ineligible by the owner's decision.

## Consequences and risks

An ERP decision can arrive after the portal order changes; it is then retained as unresolved rather than overwriting newer business state. Mock state loss prevents durable external deduplication. A real provider and a safe reconciliation workflow are needed for production linked cancellation. JSON parity needs a coordinated durable order, request and audit publication boundary.

## Migration / verification

Apply migration 0010 explicitly. Verify current and revoked authority, tenant and assignment isolation, direct/submission races, idempotent replay, required audit, correlated approval and rejection, unknown results, Mock restart and concurrent fulfillment changes.
