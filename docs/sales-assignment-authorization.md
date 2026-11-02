# Current Sales assignment authorization

Frozen requirements 2.2–2.5 require one active primary Sales owner per company.
Role permission from #32 is necessary and remains separate from assignment
ownership. This producer supplies a current selected-provider check; it does not
create accounts, assign/reassign staff or infer ownership from historical orders.

## Backend contract

`StorageRuntime.salesAssignments` is a private `SalesAssignmentRepository`.
`createSalesScope(repository)(actor,companyId,permission)` requires #32's runtime
actor capability, the requested role permission and a Sales Staff role. It returns
an immutable private CompanyScope only when current evidence permits it. Do not
bind actors/scopes from HTTP input or cache an assignment grant for a session.
Use the returned scope with the existing company/catalog/order query ports.

Grant requires a current ACTIVE Sales user with normal-access flag and no customer
company binding; an existing ACTIVE company; and exactly one valid active-primary
assignment matching that staff member, with no end timestamp or future creation.
Missing, ended, inactive, non-primary, another owner's or future evidence denies.
Unknown/invalid actor/copy denies before policy I/O. Customer/Admin roles do not
obtain a Sales grant; Internal Admin's separate platform permission is unchanged.
No active primary or non-primary-only future arrangement widens the MVP policy.

Each operation reads current state. After committed reassignment/deactivation the
next operation denies the old owner; already admitted work may finish. Internal
Admin retains its explicitly authorized historical visibility. This Sales
workflow capability does not grant ordering against an inactive company.

## Provider ownership

PostgreSQL reuses customer_sales_assignments and existing constraints/indexes.
One statement reads assignment, current user/role and company state in one
snapshot after pool acquisition; it refuses duplicate active-primary/pair evidence
rather than selecting a winner. No migration is added.

JSON uses the same injected security coordinator as account/session writers and a
private regular file customer_sales_assignments.json (not a public collection).
Absent file means no grants. UTF-8/shape/UUID/time/boolean/reference validation and
SQL-equivalent active-primary/pair uniqueness are mandatory; malformed/orphaned/
duplicate data is unavailable. Read size is limited to 2 MiB/10000 rows.
The private record fields mirror the table: id, companyId, salesStaffUserId,
assignedByUserId, isPrimary, active, createdAt, endedAt.

#84 owns future assignment writers. They must share the coordinator, validate
references/constraints and publish one complete file; SQL writes must preserve
transactional uniqueness. No write/provisioning shortcut is installed here.
Offline catalog refresh preserves this known regular file; an explicitly
confirmed demo reset clears it and still refuses unknown files/links. Selected
providers never switch after a policy failure. Callers can require capability
readiness through requireSalesAssignments; a missing JSON file remains a valid
empty/denying state, not a grant.

## Internal notes and consumers

createScopedInternalNotes adapts the existing mandatory private note callback to
a real backend actor and current assignment check. Customer roles cannot use it;
author identity/role/status are server-derived. The note adapter retains its own
order/company/current-author checks. Internal Admin remains separately permitted
for historical company notes. No customer DTO or HTTP note endpoint is added.

#68/#69 own assigned-customer listing/detail and must check assignment before
list counts/pagination or object reads. #70/#71 and future business actions must
use current policy, never an order creator ID as authority. No listing API is
invented by this authorization producer.

At initial #34 preflight, #155 had merged into the already-merged feature branch,
not main; the tenant files were absent from main 862efce. That integration issue
was recorded on #47. This producer is independent on the actual merged #32 and
does not copy missing tenant code or bypass #47's main-dependency gate. Consumers
must wire it when the tenant routes are genuinely integrated.

## Verification

Actual PostgreSQL/JSON tests use two Sales users/two companies, current read scopes,
foreign IDs/historical authorship, reassignment/lifecycle, ended/non-primary/future
and corrupt evidence, internal-note composition, current queued JSON reads,
required readiness, offline preservation/reset and no fallback. No live assignment,
credential, production migration, deployment or merge is performed. Independent
implementation review remains required.
