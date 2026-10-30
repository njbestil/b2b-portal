import type { CompanyScope, PageRequest } from "../repositories/common.js";
import type {
  InternalOrderNote,
  InternalNotesRepository,
  NoteActor,
} from "../repositories/internal-notes.js";
import { checkedPage, checkedScope } from "./query-input.js";

export class InternalNoteError extends Error {
  constructor(
    readonly code:
      "forbidden" | "invalid_note" | "not_found" | "storage_failed",
  ) {
    super(`Internal note operation failed: ${code}`);
    this.name = "InternalNoteError";
  }
}
export function noteId(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
  )
    throw new InternalNoteError("invalid_note");
  return value.toLowerCase();
}
export function internalActor(actor: NoteActor): NoteActor {
  if (
    !actor ||
    actor.status !== "ACTIVE" ||
    !["INTERNAL_ADMIN", "SALES_STAFF"].includes(actor.role)
  )
    throw new InternalNoteError("forbidden");
  return { id: noteId(actor.id), role: actor.role, status: actor.status };
}
export function checkedNote(row: InternalOrderNote): InternalOrderNote {
  if (
    !row ||
    typeof row.note !== "string" ||
    !row.note.trim() ||
    [...row.note.trim()].length > 4000 ||
    row.note.includes("\0") ||
    typeof row.createdAt !== "string" ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    new Date(row.createdAt).toISOString() !== row.createdAt
  )
    throw new InternalNoteError("invalid_note");
  return {
    id: noteId(row.id),
    companyId: noteId(row.companyId),
    orderId: noteId(row.orderId),
    authorUserId: noteId(row.authorUserId),
    note: row.note.trim(),
    createdAt: row.createdAt,
  };
}
export function checkedNoteScope(actor: NoteActor, scope: CompanyScope) {
  const identity = internalActor(actor);
  return { identity, companyId: noteId(checkedScope(scope).companyId) };
}
/** The caller must supply real backend object/assignment authorization. No
 * default allow policy, customer DTO extension, auth middleware or HTTP route. */
export function createInternalNotes(
  repository: InternalNotesRepository,
  authorize: (actor: NoteActor, scope: CompanyScope) => Promise<boolean>,
  newId: () => string,
  now: () => Date = () => new Date(),
) {
  async function allowed(actor: NoteActor, scope: CompanyScope) {
    const { identity, companyId } = checkedNoteScope(actor, scope);
    if ((await authorize(identity, { companyId })) !== true)
      throw new InternalNoteError("forbidden");
    return { identity, scope: { companyId } };
  }
  return {
    async add(
      actor: NoteActor,
      scope: CompanyScope,
      orderId: string,
      note: string,
    ) {
      const access = await allowed(actor, scope);
      const row = checkedNote({
        id: newId(),
        companyId: access.scope.companyId,
        orderId,
        authorUserId: access.identity.id,
        note,
        createdAt: now().toISOString(),
      });
      return repository.add(access.identity, access.scope, row);
    },
    async list(
      actor: NoteActor,
      scope: CompanyScope,
      orderId: string,
      page?: PageRequest,
    ) {
      const access = await allowed(actor, scope);
      return repository.list(
        access.identity,
        access.scope,
        noteId(orderId),
        checkedPage(page),
      );
    },
  };
}
