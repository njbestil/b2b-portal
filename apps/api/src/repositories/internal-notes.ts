import type {
  CompanyScope,
  EntityId,
  Page,
  PageRequest,
  Timestamp,
} from "./common.js";

/** Trusted backend identity; never bind this directly from HTTP request data. */
export interface NoteActor {
  readonly id: EntityId;
  readonly role:
    "INTERNAL_ADMIN" | "SALES_STAFF" | "CUSTOMER_ADMIN" | "CUSTOMER_USER";
  readonly status: string;
}
export interface InternalOrderNote {
  readonly id: EntityId;
  readonly companyId: EntityId;
  readonly orderId: EntityId;
  readonly authorUserId: EntityId;
  readonly note: string;
  readonly createdAt: Timestamp;
}
/** Internal-only capability, deliberately separate from customer order ports. */
export interface InternalNotesRepository {
  add(
    actor: NoteActor,
    scope: CompanyScope,
    row: InternalOrderNote,
  ): Promise<InternalOrderNote>;
  list(
    actor: NoteActor,
    scope: CompanyScope,
    orderId: EntityId,
    page: PageRequest,
  ): Promise<Page<InternalOrderNote>>;
}
