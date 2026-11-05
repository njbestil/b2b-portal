# Explicit isolated demo accounts (#171)

A separate operator command enables four existing synthetic #25 users. It never
runs at API startup, creates a public role bypass, changes normal production
roles, or alters the default disabled-login seed. Use only a dedicated demo/dev
service and an isolated backing store containing no real customer data.

## Accounts and access

| Selection      | Email                            | Role           | Synthetic ID suffix | Company        |
| -------------- | -------------------------------- | -------------- | ------------------- | -------------- |
| internal-admin | internal-admin@demo.example.test | INTERNAL_ADMIN | 000000000010        | none           |
| sales-staff    | sales-staff@demo.example.test    | SALES_STAFF    | 000000000011        | none           |
| customer-admin | customer-admin@demo.example.test | CUSTOMER_ADMIN | 000000000021        | Demo Company 1 |
| customer-user  | customer-user@demo.example.test  | CUSTOMER_USER  | 000000000031        | Demo Company 1 |

IDs use the existing d3e00000-0000-4000-8000- prefix. Company 1 ends in
000000000001 with ERP reference DEMO-C001. Company 2 remains a separate tenant;
its seeded profiles are not enabled. Assignment ending 000000000400 grants
Demo Sales Staff active primary access to Company 1 only, assigned by Demo
Internal Admin. Conflicting ownership, roles, emails or assignments refuse the
whole operation; unrelated users/data remain unchanged.

Existing RBAC governs every route/screen. Sales can use its assigned-company
list; generic company detail and customer catalog routes remain denied under
the current matrix. This tool does not implement unfinished Sales/order flows.

## Explicit environment gates

The operator and API runtime both require:

- NODE_ENV=development; production and test modes cannot enable demo accounts.
- DEMO_ACCOUNTS_ENABLED=true.
- DEMO_DEPLOYMENT=dedicated-demo.
- DEMO_ACCOUNTS_TARGET=b2b_demo_your_unique_suffix, exactly matching the JSON
  directory basename or PostgreSQL database name.

The suffix permits 1–40 lowercase letters/digits/underscores. The target must
already have the #25 ownership marker and expected synthetic users/company.
Runtime inspects the actual selected store. Flags alone never create accounts.
Partial/unsafe opt-in refuses startup or provisioning. Normal production runs
without these flags and denies the specifically provisioned demo identities.

## Private password setup

Use private deployment secrets or an equivalent hidden local input channel.
Supply selected passwords only to the operator process through:

- DEMO_INTERNAL_ADMIN_PASSWORD
- DEMO_SALES_STAFF_PASSWORD
- DEMO_CUSTOMER_ADMIN_PASSWORD
- DEMO_CUSTOMER_USER_PASSWORD

Choose distinct generated passwords. Existing policy requires 8+ Unicode
characters including uppercase, number and symbol, at most 1024 UTF-8 bytes.
There is no default password. No password values appear in this guide.

Never put values in source, arguments/history, screenshots, tickets, build
output or committed environment files. All selected passwords are validated
and scrypt-hashed before publication. Only hashes persist. Completion/failure
output has fixed event names, never passwords, hashes, connection strings or
user data. Remove password variables from the operator environment afterward.
Runtime does not consume them. Normal AUTH_JWT_* signing configuration remains
private and must be configured separately using the existing authentication guide.

## Dedicated JSON demo/dev service, including an isolated Render demo

Use a private persistent directory named b2b_demo_your_unique_suffix. Stop the
API and every writer. Follow [the existing seed guide](demo-data.md) to explicitly
seed this fresh directory; it initially has disabled logins. No boot seeding.

Set the gates above and privately supply all four password variables. From the
repository root, replace the path/target with your dedicated values and run:

    npm run demo:accounts --workspace=@b2b-portal/api -- --provider json --directory /private/demo/b2b_demo_your_unique_suffix --confirm-target b2b_demo_your_unique_suffix --offline --account all

Set JSON_DATA_DIR to that exact absolute directory and leave DATABASE_URL unset.
Restart the API with the same non-secret opt-in and private signing settings.
The dedicated Render demo/dev service must explicitly use development mode;
a normal NODE_ENV=production service refuses this opt-in. The Web continues to
use normal login and authenticated role flows.

JSON provisioning requires --offline and an exclusive sibling lock. Wrong
markers, unknown files, symlinks/junction ancestry or non-owned records refuse.
A complete snapshot stages before directory swap; failed publication restores
the old directory. Never blindly delete stale locks/recovery backups.

## Already-marked dedicated PostgreSQL target

Use an already migrated/seeded isolated b2b_demo_* database bearing the existing
b2b-portal-demo:v1 public-schema marker. DATABASE_URL must privately select
exactly that target with the required connection/TLS settings. Stop all writers:

    npm run demo:accounts --workspace=@b2b-portal/api -- --provider postgresql --confirm-target b2b_demo_your_unique_suffix --offline --account all

No JSON directory argument is accepted. This command does not migrate, seed or
import remote data. The existing seed remains local-only and disabled-login.
Any remote synthetic preparation/restore requires its separate operator
authorization; the persistent JSON procedure above is the complete path when
no marked PostgreSQL demo exists. Never mark real/shared data as demo.

Target/marker validation, seed advisory/table locks, selected credential writes
and owned assignment creation run in one transaction. Failure rolls back.
No schema migration, unrelated account deletion or assignment reassignment.
A connection/commit uncertainty reports failure; inspect and rerun safely.

## Rotation, reruns and disabling

Stop API/writers. Privately supply only one account's replacement password
variable and rerun with --account internal-admin, sales-staff, customer-admin
or customer-user. Changed hashes invalidate existing access/refresh sessions
through the normal credential fingerprints. Other credentials/data stay intact.
The same password retains its hash; reruns do not duplicate the assignment.

mustChangePassword is false for these operator-managed demo credentials; private
operator rotation is the setup flow. Normal application/password policies stay
unchanged. A normal seed/reset still restores disabled logins and needs explicit
setup again.

To disable demo authentication, remove all three opt-in/target variables and
restart. The runtime denies the provisioned email/ID pairs at login and session
issue/verification, including previously issued demo tokens; ordinary unrelated
accounts retain existing behavior.

Flags, marker and reserved IDs are ownership/refusal guards, not authorization
to use shared environments. No live Render change or secret provisioning is
performed by the implementation.

## Verification

Tests generate temporary private passwords and owned stores. They cover CLI
refusal/redaction, real four-role API login, tenant and Sales boundaries,
production/default runtime opt-out, reruns, rotation and failure rollback.
The SQL case opts in with a disposable local
B2B_TEST_MIGRATIONS_CLI_DATABASE_URL; never point it at a shared/live service.
