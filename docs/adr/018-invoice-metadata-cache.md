# ADR-018: ERP invoice metadata cache and customer reads

- Status: Proposed
- Related Issue: njbestil/b2b-portal#80

## Context and decision

The Mock ERP invoice producer exists; portal submission/link production remains
#62. Invoice retrieval must not invent that pipeline, expose raw ERP document
references, or calculate financial values. Use an explicit local operator sync
against an already linked order and a separate tenant-scoped cache/API.

Reuse SQL invoices and its composite order/company FK without a schema migration.
JSON adds optional order ERP linkage and an owned invoices file. Idempotent
publication retains portal invoice identity, rejects ownership reassignment and
rechecks source correlation/local links. Null/error responses preserve prior data.
Customers see their company's cache only; document delivery remains #81. Direct
browser ERP calls, public sync writes and auto-created links were rejected.

## Consequences and verification

Explicit synchronization does not establish freshness or completion of #62/#66.
The current source is synthetic and development/test only. Offline file tools
must preserve invoices except explicit confirmed reset. Tests exercise real Mock
HTTP, exact metadata, repeated sync, private source failures, correlation, JSON
publication/compatibility and SQL/JSON company-scoped API parity. See
[the operator/API contract](../invoices-api.md). Owner review remains required.
