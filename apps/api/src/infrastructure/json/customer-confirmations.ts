import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  CustomerConfirmations,
  CustomerConfirmationActor,
  ConfirmationReview,
  ConfirmationDecision,
} from "../../repositories/customer-confirmations.js";
import type { JsonSecurityCoordinator } from "./security.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { createJsonSessionFile, type FileIo } from "./session-file.js";
import { parseCollection } from "./schema.js";
import { DraftError } from "../../services/order-drafts.js";
import { SessionError } from "../../services/session-state.js";
import {
  checkedConfirmation,
  customerDecisionAllowed,
  decisionReplay,
} from "../../services/customer-confirmations.js";
import { draftActor, nextDraftTime } from "../order-draft-state.js";
export function createJsonCustomerConfirmations(
  security: JsonSecurityCoordinator,
  now = Date.now,
  io: FileIo = fs,
): CustomerConfirmations {
  const path = join(security.directory, "orders.json");
  async function run(
    a: CustomerConfirmationActor,
    id: string,
    decision?: { id: string; value: ConfirmationDecision },
  ): Promise<ConfirmationReview> {
    return security.run(async () => {
      try {
        const account = await readJsonSecurityAccount(security, a.userId),
          session =
            (await createJsonSessionFile(security.directory).read()).find(
              (r) => r.id === a.sessionId,
            ) ?? null;
        const check = () => draftActor(a, account, session, now());
        check();
        const stat = await io.lstat(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > 10 * 1024 * 1024
        )
          throw new DraftError("unavailable");
        const raw = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              await io.readFile(path),
            ),
          ),
          rows = parseCollection("orders", raw);
        if (!isDeepStrictEqual(raw, rows)) throw new DraftError("unavailable");
        const row = rows.find(
          (r) => r.id === id && r.companyId === a.companyId,
        );
        if (!row?.confirmation) throw new DraftError("not_found");
        let record = checkedConfirmation(row.confirmation);
        customerDecisionAllowed(a, record);
        const maker = (await security.store.read("users")).find(
          (u) => u.id === row.createdByUserId,
        );
        if (
          !maker ||
          maker.role !== "SALES_STAFF" ||
          maker.companyId !== null ||
          maker.id === a.userId
        )
          throw new DraftError("forbidden");
        if (
          row.integrationStatus !== "NOT_SENT" ||
          row.erpOrderReference !== undefined ||
          row.submittedSnapshot !== undefined ||
          row.status !==
            (record.status === "REJECTED"
              ? "REJECTED"
              : "PENDING_CUSTOMER_CONFIRMATION")
        )
          throw new DraftError("conflict");
        const products = await security.store.read("products"),
          items = (row.items ?? []).map((line) => {
            const p = products.find((p) => p.id === line.productId);
            if (!p) throw new DraftError("unavailable");
            return {
              ...line,
              name: p.name,
              sku: p.sku,
              sellingUom: p.sellingUom,
            };
          });
        if (!items.length || items.length > 100)
          throw new DraftError("conflict");
        const addressPath = join(security.directory, "delivery_addresses.json"),
          addressStat = await io.lstat(addressPath);
        if (
          !addressStat.isFile() ||
          addressStat.isSymbolicLink() ||
          addressStat.size > 2 * 1024 * 1024
        )
          throw new DraftError("unavailable");
        const addresses: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await io.readFile(addressPath),
          ),
        );
        if (!Array.isArray(addresses)) throw new DraftError("unavailable");
        const address = addresses.find(
          (r) => r.id === row.deliveryAddressId && r.companyId === a.companyId,
        );
        let status = row.status;
        if (decision) {
          if (record.id !== decision.id) throw new DraftError("conflict");
          if (!decisionReplay(record, a, decision.value)) {
            const at = nextDraftTime(
              row.updatedAt && row.updatedAt > record.createdAt
                ? row.updatedAt
                : record.createdAt,
              now(),
            );
            record = checkedConfirmation({
              ...record,
              status: decision.value.status,
              decidedAt: at,
              decidedByUserId: a.userId,
              reason: decision.value.reason,
            });
            status =
              record.status === "REJECTED"
                ? "REJECTED"
                : "PENDING_CUSTOMER_CONFIRMATION";
            const next = rows.map((r) =>
              r.id === id
                ? { ...r, status, updatedAt: at, confirmation: record }
                : r,
            );
            if (!isDeepStrictEqual(next, parseCollection("orders", next)))
              throw new DraftError("unavailable");
            const text = JSON.stringify(next, null, 2) + "\n";
            if (Buffer.byteLength(text) > 10 * 1024 * 1024)
              throw new DraftError("unavailable");
            const temporary = join(
              security.directory,
              ".orders.decision." + randomUUID() + ".tmp",
            );
            try {
              const h = await io.open(temporary, "wx", 0o600);
              try {
                await h.writeFile(text, "utf8");
                await h.sync();
              } finally {
                await h.close();
              }
              check();
              await io.rename(temporary, path);
            } finally {
              await io.unlink(temporary).catch(() => {});
            }
          }
        }
        check();
        return {
          confirmation: record,
          order: {
            id,
            status,
            createdBy: maker.displayName,
            items,
            delivery: address
              ? { label: address.label, line1: address.address.line1 }
              : null,
          },
        };
      } catch (e) {
        if (e instanceof DraftError || e instanceof SessionError) throw e;
        throw new DraftError("unavailable");
      }
    });
  }
  return {
    find: (a, id) => run(a, id),
    decide: (a, id, key, value) => run(a, id, { id: key, value }),
  };
}
