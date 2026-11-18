import type { Pool } from "pg";
import type {
  InvoiceRecord,
  InvoiceRepository,
} from "../repositories/invoices.js";
import {
  InvoiceError,
  checkedInvoice,
  checkedLink,
  sameInvoiceLink,
  invoiceId,
} from "../services/invoices.js";
const linkSql = `SELECT o.id AS "orderId",o.company_id AS "companyId",o.erp_order_reference AS "erpOrderReference",c.erp_customer_reference AS "customerReference" FROM orders o JOIN companies c ON c.id=o.company_id WHERE o.id=$1 AND o.erp_order_reference IS NOT NULL AND c.erp_customer_reference IS NOT NULL AND o.order_status NOT IN ('DRAFT','PENDING_CUSTOMER_CONFIRMATION')`;
const fields = `id,company_id AS "companyId",order_id AS "orderId",erp_invoice_reference AS "erpInvoiceReference",invoice_number AS "invoiceNumber",status,amount::text AS amount,currency,document_reference AS "documentReference",issued_at AS "issuedAt",synced_at AS "syncedAt"`;
const record = (
  r: Omit<InvoiceRecord, "issuedAt" | "syncedAt"> & {
    issuedAt: Date;
    syncedAt: Date;
  },
) =>
  checkedInvoice({
    ...r,
    issuedAt: r.issuedAt.toISOString(),
    syncedAt: r.syncedAt.toISOString(),
  });
export function createPostgresInvoices(pool: Pool): InvoiceRepository {
  return {
    async link(id) {
      const row = (await pool.query(linkSql, [invoiceId(id)])).rows[0];
      return row ? checkedLink(row) : null;
    },
    async save(expected, input) {
      const row = checkedInvoice(input),
        client = await pool.connect();
      let broken = false;
      const error = () => {
        broken = true;
      };
      client.on("error", error);
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='5s'");
        const current = (
          await client.query(linkSql + " FOR UPDATE OF o,c", [
            invoiceId(expected.orderId),
          ])
        ).rows[0];
        if (
          !sameInvoiceLink(current ?? null, expected) ||
          row.companyId !== expected.companyId ||
          row.orderId !== expected.orderId ||
          row.documentReference !== `mock-invoice:${expected.erpOrderReference}`
        )
          throw new InvoiceError();
        const result = await client.query(
          `INSERT INTO invoices(id,company_id,order_id,erp_invoice_reference,invoice_number,status,amount,currency,document_reference,issued_at,synced_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(erp_invoice_reference) DO UPDATE SET invoice_number=EXCLUDED.invoice_number,status=EXCLUDED.status,amount=EXCLUDED.amount,currency=EXCLUDED.currency,document_reference=EXCLUDED.document_reference,issued_at=EXCLUDED.issued_at,synced_at=EXCLUDED.synced_at WHERE invoices.company_id=EXCLUDED.company_id AND invoices.order_id=EXCLUDED.order_id RETURNING id`,
          [
            row.id,
            row.companyId,
            row.orderId,
            row.erpInvoiceReference,
            row.invoiceNumber,
            row.status,
            row.amount,
            row.currency,
            row.documentReference,
            row.issuedAt,
            row.syncedAt,
          ],
        );
        if (result.rows.length !== 1 || broken) throw new InvoiceError();
        await client.query("COMMIT");
      } catch {
        await client.query("ROLLBACK").catch(() => {});
        throw new InvoiceError();
      } finally {
        client.off("error", error);
        client.release(broken);
      }
    },
    async list(companyId, page) {
      const result = await pool.query(
        `SELECT ${fields} FROM invoices WHERE company_id=$1 ORDER BY issued_at DESC NULLS LAST,id ASC OFFSET $2 LIMIT $3`,
        [invoiceId(companyId), page.offset, page.limit],
      );
      const count = await pool.query(
        "SELECT count(*)::int AS total FROM invoices WHERE company_id=$1",
        [companyId],
      );
      return { items: result.rows.map(record), total: count.rows[0].total };
    },
    async find(companyId, id) {
      const row = (
        await pool.query(
          `SELECT ${fields} FROM invoices WHERE company_id=$1 AND id=$2`,
          [invoiceId(companyId), invoiceId(id)],
        )
      ).rows[0];
      return row ? record(row) : null;
    },
  };
}
