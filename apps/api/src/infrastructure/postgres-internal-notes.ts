import type { Pool } from "pg";
import type {
  InternalNotesRepository,
  InternalOrderNote,
} from "../repositories/internal-notes.js";
import {
  checkedNote,
  checkedNoteScope,
  InternalNoteError,
  noteId,
} from "../services/internal-notes.js";
import { checkedPage } from "../services/query-input.js";

type RawNote = Omit<InternalOrderNote, "createdAt"> & { createdAt: Date };
const project = `id,company_id AS "companyId",order_id AS "orderId",author_user_id AS "authorUserId",note,created_at AS "createdAt"`;
/** Parameterized, no provider fallback. Authorization must precede this port. */
export function createPostgresInternalNotes(
  pool: Pick<Pool, "query">,
): InternalNotesRepository {
  const map = (row: RawNote): InternalOrderNote =>
    checkedNote({ ...row, createdAt: row.createdAt.toISOString() });
  async function safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof InternalNoteError) throw error;
      throw new InternalNoteError("storage_failed");
    }
  }
  return {
    async add(actor, scope, input) {
      const { identity, companyId } = checkedNoteScope(actor, scope),
        row = checkedNote(input);
      if (row.companyId !== companyId || row.authorUserId !== identity.id)
        throw new InternalNoteError("forbidden");
      return safe(async () => {
        // Single statement revalidates actual actor and scoped order at write time.
        const result = await pool.query<RawNote>(
          `INSERT INTO order_internal_notes(id,company_id,order_id,author_user_id,note,created_at)
          SELECT $1,$2,o.id,u.id,$5,$6 FROM orders o JOIN users u ON u.id=$4
          WHERE o.id=$3 AND o.company_id=$2 AND u.role=$7 AND u.status='ACTIVE' AND u.role IN ('INTERNAL_ADMIN','SALES_STAFF')
          RETURNING ${project}`,
          [
            row.id,
            companyId,
            row.orderId,
            identity.id,
            row.note,
            row.createdAt,
            identity.role,
          ],
        );
        if (result.rows.length !== 1) throw new InternalNoteError("not_found");
        return map(result.rows[0]!);
      });
    },
    async list(actor, scope, orderId, page) {
      const { identity, companyId } = checkedNoteScope(actor, scope),
        id = noteId(orderId),
        request = checkedPage(page);
      return safe(async () => {
        const result = await pool.query<
          RawNote & {
            total: string;
            actorAllowed: boolean;
            orderAllowed: boolean;
          }
        >(
          `WITH actor AS MATERIALIZED (SELECT 1 FROM users WHERE id=$5 AND role=$6 AND status='ACTIVE' AND role IN ('INTERNAL_ADMIN','SALES_STAFF')),
          scoped_order AS MATERIALIZED (SELECT 1 FROM orders WHERE company_id=$1 AND id=$2),
          matching AS MATERIALIZED (SELECT ${project} FROM order_internal_notes WHERE company_id=$1 AND order_id=$2 AND EXISTS(SELECT 1 FROM actor) AND EXISTS(SELECT 1 FROM scoped_order))
          SELECT EXISTS(SELECT 1 FROM actor) AS "actorAllowed",EXISTS(SELECT 1 FROM scoped_order) AS "orderAllowed",n.total,p.* FROM (SELECT count(*)::text AS total FROM matching)n
          LEFT JOIN LATERAL (SELECT * FROM matching ORDER BY "createdAt",id LIMIT $3 OFFSET $4)p ON true`,
          [
            companyId,
            id,
            request.limit,
            request.offset,
            identity.id,
            identity.role,
          ],
        );
        if (!result.rows[0]?.actorAllowed)
          throw new InternalNoteError("forbidden");
        if (!result.rows[0].orderAllowed)
          throw new InternalNoteError("not_found");
        const total = Number(result.rows[0]?.total);
        if (!Number.isSafeInteger(total) || total < 0)
          throw new InternalNoteError("storage_failed");
        return {
          total,
          items: result.rows
            .filter((row) => row.id !== null)
            .map(
              ({
                total: _total,
                actorAllowed: _actor,
                orderAllowed: _order,
                ...row
              }) => map(row),
            ),
        };
      });
    },
  };
}
