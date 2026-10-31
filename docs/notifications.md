# Notification creation service (B2B-079)

Trusted backend services can call `createNotifications(runtime.notifications,
randomUUID).create({ userId, type, title, message, targetType?, targetId? })`.
The startup-selected storage runtime supplies a separate append port backed by the
existing PostgreSQL `notifications` table or private `notifications.json`. No
migration, dependency, public endpoint, email, business trigger or read/unread
interface is added. Audit events remain a separate capability.

The service generates a UUID and UTC creation timestamp. Both adapters validate
and detach records before I/O, require an existing recipient user, and initially
persist `readAt: null`. UUIDs normalize to lowercase. Type/target type are bounded
lowercase code identifiers (1–64 characters). Title/message must contain nonblank
text, at most 200/2000 UTF-16 code units, without database-invalid control
characters or unpaired Unicode surrogates. Optional target type and UUID must be provided together; omitted
references persist as null. Targets are informational references, not foreign keys
or proof of authorization. Unknown input fields and caller-supplied generated
fields are rejected. Only trusted backend code may choose recipients and content:
use curated messages, never credentials, raw exceptions, or request payloads.
Bounded text validation cannot determine whether a message contains sensitive data.

User scope is the exact recipient ID. The port neither queries notifications nor
authorizes customers, companies or target objects. Callers must establish those
permissions separately; the UI role selector supplies no trusted identity.

SQL uses parameterized inserts and the existing user foreign key. JSON checks the
private user collection, serializes appends on one adapter instance, and publishes
a complete array by atomic rename with private temporary files. Use one instance
and process per trusted directory. A missing notification file means no previous
notifications; corrupt/duplicate records, missing recipients and failed publication
reject with a redacted `NotificationError`. Invalid input uses `invalid_record`;
storage failures use `storage_failed`. Errors propagate with no silent drop,
automatic retry or provider switching. There is no transaction with other business
writes, distributed writer support or crash-durability guarantee. JSON is intended
for local/demo storage and remains ephemeral on ephemeral hosting.

Offline, explicitly confirmed disposable demo reset recognizes and clears the
private notification file. Unknown files still refuse reset. SQL reset already
includes the notifications table. Ordinary startup never clears notifications.
Offline catalog refresh preserves notification bytes alongside other private data;
unrelated unknown files still refuse mutation.

`notifications.test.mjs` covers creation, recipient references, bounds, detachment,
concurrent appends/reopen, safe failures, provider composition and reset behavior.
The opt-in `B2B_TEST_MIGRATIONS_DATABASE_URL` test uses a unique disposable schema
and compares actual SQL rows with JSON, including FK/duplicate failures. Run the
focused test after building, then root `npm run check`; report database skips.
