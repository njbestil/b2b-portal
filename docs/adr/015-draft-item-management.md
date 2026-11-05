# ADR-015: Customer-owned draft item management

- Status: Proposed
- Related Issue: njbestil/b2b-portal#52

## Context

The draft header API provides creator-only writes and an opaque version, but its canonical header does not contain lines. Customers need to add, update and remove eligible products while preserving concurrent header edits, private history and exact quantities. The frozen requirements require positive quantities meeting the SKU MOQ in its selling UOM, but the catalog exposes no selling increment.

## Options considered

Separate item versions would allow conflicting header and item changes unless callers coordinated both. Reusing the existing version and serialization point provides one conflict boundary. Cascading line deletion on draft removal would change the existing preservation contract. Separate JSON files for lines and headers would require multi-file recovery to maintain the version invariant.

## Decision

Provide separate item routes returning the canonical header and line list. Each mutation validates creator authority and lifecycle under the existing serialization boundary, verifies the loaded header version, updates lines and advances header `updatedAt` atomically. Duplicate products conflict and updates replace absolute quantities. Consumers explicitly remove lines before deleting a draft. Preserve existing private line evidence and other children.

Store SQL lines in the existing `order_items` table in the same transaction as the version advance. Store JSON lines within the order row so a single bounded atomic replacement contains both changes. Existing legacy rows remain readable and unknown private line fields fail closed. The same shared coordinator serializes JSON header, item and note operations.

Use positive exact decimal strings with up to 12 integer and six fractional digits, rejecting unsupported precision rather than rounding. Compare against current active eligible product MOQ exactly. MOQ is a minimum, not a multiple; no unprovided UOM increment is inferred. The user delegated this choice for #52. A future increment policy requires explicit catalog and consumer contract changes.

## Consequences and verification

The public item route and error contract is in [order-draft-items-api.md](../order-draft-items-api.md). Versions change on every successful item mutation, including no-op replacements; after a conflict or uncertain result the client reloads. JSON retains the existing single-process and offline-maintenance limitation. Real SQL and JSON tests cover CRUD, quantity validation, ownership, lifecycle, races, publication and rollback. Submission validation, snapshots, idempotency, pricing and UI remain separate work.
