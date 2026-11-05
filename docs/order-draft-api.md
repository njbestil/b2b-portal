# Customer-owned draft API (#51)

Normal active Customer Admin/User Bearer sessions only. Every operation validates current account/company/role, credential-bound session and access expiry at persistence. Creator ownership is required even for a Customer Admin editing another customer user's draft. Internal Admin/Sales cannot use this customer-only workflow.

| Method / route                    | Body shape                    | Success data                 |
| --------------------------------- | ----------------------------- | ---------------------------- |
| POST `/api/v1/order-drafts`       | `{}` or `{deliveryAddressId}` | 201 `{draft}`                |
| GET `/api/v1/order-drafts/:id`    | none                          | 200 `{draft}`                |
| PATCH `/api/v1/order-drafts/:id`  | `{version,deliveryAddressId}` | 200 `{draft}`                |
| DELETE `/api/v1/order-drafts/:id` | `{version}`                   | 200 `{deleted:true,draftId}` |

The address value is a UUID string or null; version is the loaded opaque string.
Envelopes are `{success:true,data,requestId}` or `{success:false,error:{code,message},requestId}` with no-store. Mutation requests require JSON, no compression, <=8kb, no query selectors, at most 30 attempts/actor/minute and four in flight per process. There is no draft collection/history endpoint in this slice. The specific GET supports canonical reload by known draft ID. Future #53 Web work must support authenticated DELETE with the explicit version body; this PR changes no Web code.

Draft: `{id,companyId,createdByUserId,orderNumber,createdAt,updatedAt,status, integrationStatus,deliveryAddressId,version}`. New IDs/owner/timestamps are server-owned; new orderNumber is null, status DRAFT, integrationStatus NOT_SENT. The optional address is never implicitly replaced by a default. The supplied address must exist, be same-company and currently active on create/update. Read does not silently replace an address later deactivated; the owner can explicitly clear/change it. Submit-time business validation remains #54.

Only deliveryAddressId is mutable through the header routes. No items, prices/totals, role/tenant/actor/status/timestamp fields, snapshots, idempotency keys, notes or ERP actions are accepted there. Caller-generated IDs and extra properties are invalid. Item writes use the separate [draft item API](order-draft-items-api.md); UI #53 and validation/snapshots/idempotency #54–#57 remain separate.

Version is opaque `draft-` plus SHA-256 of the canonical draft representation. Every successful update advances the server updatedAt by at least one millisecond, even if the address is unchanged, so stale writes conflict. Create is not replay-idempotent. Do not automatically retry writes after uncertain transport/audit failures.

| Status          | Error code / meaning                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 400             | INVALID_ORDER_DRAFT_REQUEST; malformed body INVALID_JSON                                                                                      |
| 401             | INVALID_SESSION                                                                                                                               |
| 403             | PASSWORD_CHANGE_REQUIRED or FORBIDDEN                                                                                                         |
| 404             | ORDER_DRAFT_NOT_FOUND: missing/foreign/nonowned draft or unavailable supplied address; same safe code for foreign/missing/inactive references |
| 409             | ORDER_DRAFT_CONFLICT: stale version, own incompatible lifecycle/integration state or existing child references                                |
| 413 / 415 / 429 | PAYLOAD_TOO_LARGE / UNSUPPORTED_MEDIA_TYPE / RATE_LIMITED                                                                                     |
| 503             | ORDER_DRAFT_UNAVAILABLE or admission AUTH_UNAVAILABLE; result may already be committed, reload before another action                          |

Own non-DRAFT/sent records cannot be mutated; draft reads return 404 for them. SQL additionally protects legacy DRAFT rows carrying submission snapshots/timestamps, ERP identity or reserved idempotency evidence. Delete never cascades into line items, notes, confirmations, integration history or invoices: existing references conflict and remain intact. Remove draft lines explicitly before deleting the draft; item changes advance the same version atomically.

SQL uses existing orders/delivery-address schema and a transaction, locking company -> actor user/session -> owned order -> supplied address. Version and dynamic authority are checked under ownership; access expiry is rechecked after statement waits. No migration.

JSON extends order rows with optional deliveryAddressId/updatedAt. Legacy summary-only rows remain readable, with no selected address and updatedAt represented by their known createdAt; new writes retain both fields. Existing summary ports explicitly keep their old projection. Atomic orders.json publication runs under the shared security coordinator. Unsupported private order fields refuse publication rather than get discarded; corrupt/oversized files and incomplete intake/review publication refuse normal draft work. The 10MB publication bound is checked before replacement. Reference reads finish before a final live-authority/expiry check immediately before publication. JSON remains single-process, trusted-directory storage with offline maintenance.

Production JSON internal-note publication shares that coordinator, so a concurrent note append and draft delete cannot leave an orphan. Existing notes block deletion, matching SQL foreign-key behavior. Notes authorization/HTTP behavior is unchanged.

The existing audit port records order.created/order.draft_updated/order.draft_deleted with the backend actor and IDs. Audit publication follows the business transaction: a later failure reports unconfirmed state without rollback or automatic replay. This is not an exactly-once ledger; deletion preserves audit history. New draft IDs from an uncertain create may be recovered through existing authorized order-summary reads and owner-specific GET, not by blindly replaying POST.
