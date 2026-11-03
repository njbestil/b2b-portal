# Application review API (#38)

Normal Internal Admin Bearer access is required. Reads and decisions revalidate current account, credential-bound session and access expiry in the persistence operation.

- GET `/api/v1/admin/applications?offset=0&limit=20`: complete Pending applications, company ID order, `{items,total}`. Offset 0–100000; limit 1–100.
- GET `/api/v1/admin/applications/:companyId`: `{application}` including retained decision snapshot after approval/rejection.
- POST `/api/v1/admin/applications/:companyId/decision`: exact `{version,decision:"approve"}` or `{version,decision:"reject",reason}`. Reason trims to nonempty text, maximum 1000 characters, no control characters. No client statuses, actor IDs or ERP references.

All responses use the existing standard envelope and no-store policy. Invalid requests are 400, missing/incomplete applications 404, conflicting decisions 409, unavailable/unconfirmed operations 503; standard authentication/authorization errors apply. POST requires JSON, is limited to 8kb, 30 decisions per actor/minute and four concurrent requests per process.

A Pending version hashes the canonical submitted bundle. The exact original command may be replayed without another transition; a different decision/reason/version conflicts. Approval makes the company and initial administrator ACTIVE; rejection makes both REJECTED. Credentials and first-login-change flags remain unchanged. ERP linkage is outside this contract.

Migration 0006 adds private retained decision records. Apply through the existing migration runner. PostgreSQL commits paired statuses and the record atomically. JSON writes a private intent, decision record, company and user projections, then removes the intent. Shared security operations fail closed while the intent exists; startup or a review operation recovers it under the shared coordinator. Recovery never rewrites credentials. JSON remains single-process, trusted-directory storage with offline reset only.

Audit and recipient-scoped in-app notification effects are recorded separately as pending/unknown/completed. A compare-and-set claim publishes unknown before invoking each existing port; completed requires confirmed append. An uncertain append is never automatically replayed. This prevents blind duplicate effects, but requires operator reconciliation of unknown records; it does not promise exactly-once delivery. The UI reports the committed outcome and each effect state. A transport failure requires reload, not optimistic activation.
