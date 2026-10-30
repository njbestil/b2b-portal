import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  InternalOrderNote,
  InternalNotesRepository,
  NoteActor,
} from "../../repositories/internal-notes.js";
import {
  checkedNote,
  checkedNoteScope,
  InternalNoteError,
  noteId,
} from "../../services/internal-notes.js";
import { checkedPage } from "../../services/query-input.js";
import { JsonFileStore } from "./store.js";

/** One instance/process per trusted directory, offline from seed/reset. This
 * separate private file is never added to customer/master-data collections. */
export function createJsonInternalNotes(
  directory: string,
): InternalNotesRepository {
  const root = resolve(directory),
    path = join(root, "order_internal_notes.json"),
    store = new JsonFileStore(root);
  let queue = Promise.resolve();
  async function ordered<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    try {
      return await result;
    } catch (error) {
      if (error instanceof InternalNoteError) throw error;
      throw new InternalNoteError("storage_failed");
    }
  }
  async function references(
    actor: NoteActor,
    companyId: string,
    orderId: string,
  ) {
    const users = await store.read("users");
    if (
      !users.some(
        (user) =>
          user.id === actor.id &&
          user.role === actor.role &&
          user.status === "ACTIVE" &&
          ["INTERNAL_ADMIN", "SALES_STAFF"].includes(user.role),
      )
    )
      throw new InternalNoteError("forbidden");
    if (
      !(await store.read("orders")).some(
        (order) => order.id === orderId && order.companyId === companyId,
      )
    )
      throw new InternalNoteError("not_found");
  }
  async function read(): Promise<InternalOrderNote[]> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
    const rows: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)),
    );
    if (!Array.isArray(rows)) throw new Error();
    const parsed = Array.from(rows, (row: InternalOrderNote) =>
      checkedNote(row),
    );
    if (new Set(parsed.map((row) => row.id)).size !== parsed.length)
      throw new Error();
    return parsed;
  }
  async function publish(rows: InternalOrderNote[]) {
    const temporary = join(root, `.order_internal_notes.${randomUUID()}.tmp`);
    try {
      await mkdir(root, { recursive: true });
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(rows, null, 2) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  return {
    async add(actor, scope, input) {
      const { identity, companyId } = checkedNoteScope(actor, scope),
        row = checkedNote(input);
      if (row.companyId !== companyId || row.authorUserId !== identity.id)
        throw new InternalNoteError("forbidden");
      return ordered(async () => {
        await references(identity, companyId, row.orderId);
        const rows = await read();
        if (rows.some((item) => item.id === row.id))
          throw new InternalNoteError("invalid_note");
        rows.push(row);
        await publish(rows);
        return { ...row };
      });
    },
    async list(actor, scope, orderId, page) {
      const { identity, companyId } = checkedNoteScope(actor, scope),
        id = noteId(orderId),
        request = checkedPage(page);
      return ordered(async () => {
        await references(identity, companyId, id);
        const rows = (await read())
          .filter((row) => row.companyId === companyId && row.orderId === id)
          .sort(
            (a, b) =>
              a.createdAt.localeCompare(b.createdAt) ||
              a.id.localeCompare(b.id),
          );
        return {
          total: rows.length,
          items: rows.slice(request.offset, request.offset + request.limit),
        };
      });
    },
  };
}
