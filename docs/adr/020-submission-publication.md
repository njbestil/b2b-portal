# ADR-020: Transaction-bound submission and one-attempt dispatch

- Status: Proposed — implementation review pending
- Related Issue: [#62](https://github.com/njbestil/b2b-portal/issues/62)

## Context

The portal must retain its submitted snapshot and outbound request before contacting ERP. Mock ERP loses its receipt ledger on restart, so a timeout does not establish whether the order was accepted.

## Options considered

Send inside the order transaction; commit then retry automatically; or commit an immutable request and permit a single claimed attempt. A database transaction cannot atomically commit an external call, and retrying an unknown Mock outcome may create a duplicate after restart.

## Decision

Commit the order, snapshot, reservation, audit and PENDING integration transaction together. Claim that transaction before one external call and retain the classified result. A PROCESSING or unknown result is not automatically retried. Require authorization on replay, keep provider payloads private, and fail closed on JSON and production configurations without suitable guarantees.

## Consequences and risks

A crash after claim can require manual reconciliation even if no request reached the provider. Current Mock catalog reads are not transactional with the portal database. The provider cannot guarantee durable deduplication or production correctness. Later retry/reconciliation work must preserve the retained identity and exact commercial values.

## Migration / verification

Migration 0009 adds an order-submission uniqueness index; preexisting duplicates block migration. Validate authorization, fresh data and price acknowledgement, rollback, concurrent replay, real Mock receipts, unknown outcomes, restart and adapter fail-closed behavior before release.
