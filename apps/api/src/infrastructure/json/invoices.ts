import { randomUUID } from "node:crypto";
import { lstat, readFile, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  InvoiceRecord,
  InvoiceRepository,
} from "../../repositories/invoices.js";
import {
  InvoiceError,
  checkedInvoice,
  checkedLink,
  sameInvoiceLink,
  invoiceId,
} from "../../services/invoices.js";
import type { JsonSecurityCoordinator } from "./security.js";
export function createJsonInvoices(
  security: JsonSecurityCoordinator,
  io: Pick<typeof import("node:fs/promises"), "open" | "rename" | "unlink"> = {
    open,
    rename,
    unlink,
  },
): InvoiceRepository {
  const path = join(security.directory, "invoices.json");
  async function read(): Promise<InvoiceRecord[]> {
    try {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 10 * 1024 * 1024
      )
        throw new InvoiceError();
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
      throw new InvoiceError();
    }
    const bytes = await readFile(path);
    if (bytes.byteLength > 10 * 1024 * 1024) throw new InvoiceError();
    const rows = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!Array.isArray(rows) || rows.length > 10000) throw new InvoiceError();
    const checked = rows.map(checkedInvoice);
    if (
      new Set(checked.map((r) => r.id)).size !== checked.length ||
      new Set(checked.map((r) => r.erpInvoiceReference)).size !==
        checked.length ||
      rows.some(
        (r, i) =>
          Object.keys(r).sort().join(",") !==
          Object.keys(checked[i]).sort().join(","),
      )
    )
      throw new InvoiceError();
    return checked;
  }
  async function link(orderId: string) {
    const order = (await security.store.read("orders")).find(
      (r) => r.id === invoiceId(orderId),
    );
    if (
      !order ||
      !order.erpOrderReference ||
      ["DRAFT", "PENDING_CUSTOMER_CONFIRMATION"].includes(order.status)
    )
      return null;
    const company = (await security.store.read("companies")).find(
      (r) => r.id === order.companyId,
    );
    if (!company?.erpCustomerReference) return null;
    return checkedLink({
      orderId: order.id,
      companyId: order.companyId,
      erpOrderReference: order.erpOrderReference,
      customerReference: company.erpCustomerReference,
    });
  }
  return {
    link: (orderId) => security.run(() => link(orderId)),
    save: (expected, input) =>
      security.run(async () => {
        const invoice = checkedInvoice(input);
        if (
          !sameInvoiceLink(await link(expected.orderId), expected) ||
          invoice.companyId !== expected.companyId ||
          invoice.orderId !== expected.orderId ||
          invoice.documentReference !==
            `mock-invoice:${expected.erpOrderReference}`
        )
          throw new InvoiceError();
        const rows = await read(),
          index = rows.findIndex(
            (r) => r.erpInvoiceReference === invoice.erpInvoiceReference,
          ),
          prior = rows[index];
        if (
          prior &&
          (prior.companyId !== invoice.companyId ||
            prior.orderId !== invoice.orderId)
        )
          throw new InvoiceError();
        if (!prior && rows.some((row) => row.id === invoice.id))
          throw new InvoiceError();
        const next = { ...invoice, id: prior?.id ?? invoice.id };
        if (index < 0) rows.push(next);
        else rows[index] = next;
        const text = JSON.stringify(rows, null, 2) + "\n";
        if (rows.length > 10000 || Buffer.byteLength(text) > 10 * 1024 * 1024)
          throw new InvoiceError();
        const temporary = join(
          security.directory,
          `.invoices.${randomUUID()}.tmp`,
        );
        try {
          const handle = await io.open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(text);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await io.rename(temporary, path);
        } catch {
          throw new InvoiceError();
        } finally {
          await io.unlink(temporary).catch(() => {});
        }
      }),
    list: (companyId, page) =>
      security.run(async () => {
        const rows = (await read())
          .filter((r) => r.companyId === invoiceId(companyId))
          .sort(
            (a, b) =>
              b.issuedAt.localeCompare(a.issuedAt) || a.id.localeCompare(b.id),
          );
        return {
          items: rows.slice(page.offset, page.offset + page.limit),
          total: rows.length,
        };
      }),
    find: (companyId, id) =>
      security.run(
        async () =>
          (await read()).find(
            (r) =>
              r.companyId === invoiceId(companyId) && r.id === invoiceId(id),
          ) ?? null,
      ),
  };
}
