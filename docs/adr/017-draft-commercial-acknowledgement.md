# ADR-017: Explicit draft commercial acknowledgement

- Status: Proposed
- Related Issue: njbestil/b2b-portal#55

## Context

The draft model stores product and quantity but not the commercial values the customer saw. The validation preflight reads live values and cannot determine whether prices changed without a baseline. The submission transition and immutable historical snapshots belong to later issues.

## Options considered

Automatically saving a live price on item addition would not prove that the customer reviewed that price. Trusting client-supplied prices would permit forged baselines. Using submission snapshot fields for an editable draft would blur the historic-record boundary.

## Decision

Present current server-observed line prices with a token bound to the draft/version. Explicit acknowledgement re-fetches and checks those exact terms, then atomically stores a mutable draft-only baseline and increments the draft version. On later validation, line identity/quantity must still match and prices are compared exactly. A changed price requires another review. Unknown/insufficient stock blocks, but a stock change that still covers the quantity does not. Legacy drafts require acknowledgement.

Store the baseline on the order in both PostgreSQL and JSON, preserving existing private line evidence. Client requests contain only the version and token. Submission work must revalidate at its own boundary; this acknowledgement does not reserve stock or replace #56 snapshots.

## Consequences and verification

Migration 0007 is additive. Old clients must adopt the review/acknowledgement flow before validation can succeed. Real SQL/JSON and Mock HTTP tests cover stale versions, source changes, acknowledgement races and safe failures; no production ERP authority is introduced. Details are in [the API contract](../draft-commercial-terms.md).
