import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ConfirmationActor,
  ConfirmationRequests,
  PendingConfirmation,
} from "../../repositories/confirmation-requests.js";
import type { JsonSecurityCoordinator } from "./security.js";
import type { JsonOrder } from "./models.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { createJsonSessionFile, type FileIo } from "./session-file.js";
import { createJsonSalesAssignmentFile } from "./sales-assignment-file.js";
import { parseCollection } from "./schema.js";
import { DraftError } from "../../services/order-drafts.js";
import { SessionError } from "../../services/session-state.js";
import {
  draftActor,
  canonicalDraft,
  nextDraftTime,
} from "../order-draft-state.js";
import {
  confirmationFingerprint,
  pendingReplay,
} from "../confirmation-request-state.js";
export function createJsonConfirmationRequests(
  security: JsonSecurityCoordinator,
  now = Date.now,
  io: FileIo = fs,
): ConfirmationRequests {
  const path = join(security.directory, "orders.json");
  async function run<T>(
    a: ConfirmationActor,
    id: string,
    work: (rows: JsonOrder[], row: JsonOrder, check: () => void) => Promise<T>,
  ): Promise<T> {
    return security.run(async () => {
      try {
        const account = await readJsonSecurityAccount(security, a.userId),
          session =
            (await createJsonSessionFile(security.directory).read()).find(
              (r) => r.id === a.sessionId,
            ) ?? null,
          { rows: assignments, companies } =
            await createJsonSalesAssignmentFile(security).read();
        const check = () => {
          draftActor(a, account, session, now());
          if (
            companies.find((c) => c.id === a.companyId)?.status !== "ACTIVE" ||
            !assignments.some(
              (r) =>
                r.companyId === a.companyId &&
                r.salesStaffUserId === a.userId &&
                r.active &&
                r.isPrimary &&
                r.endedAt === null &&
                Date.parse(r.createdAt) <= now(),
            )
          )
            throw new DraftError("forbidden");
        };
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
          (r) =>
            r.id === id &&
            r.companyId === a.companyId &&
            r.createdByUserId === a.userId,
        );
        if (!row) throw new DraftError("not_found");
        const result = await work(rows, row, check);
        check();
        return result;
      } catch (e) {
        if (e instanceof DraftError || e instanceof SessionError) throw e;
        throw new DraftError("unavailable");
      }
    });
  }
  return {
    find: (a, id) => run(a, id, async (_rows, row) => row.confirmation ?? null),
    request: (a, id, version, contact, key) =>
      run(a, id, async (rows, row, check) => {
        const fingerprint = confirmationFingerprint(
          a,
          id,
          version,
          contact,
          key,
        );
        if (row.confirmation)
          return pendingReplay(
            row.confirmation,
            row.status,
            row.integrationStatus,
            fingerprint,
          );
        if (
          row.status !== "DRAFT" ||
          row.integrationStatus !== "NOT_SENT" ||
          row.erpOrderReference !== undefined ||
          row.submittedSnapshot !== undefined
        )
          throw new DraftError("conflict");
        const draft = canonicalDraft({
          ...row,
          deliveryAddressId: row.deliveryAddressId ?? null,
          updatedAt: row.updatedAt ?? row.createdAt,
        });
        if (draft.version !== version) throw new DraftError("conflict");
        if (
          !(await security.store.read("users")).some(
            (u) =>
              u.id === contact &&
              u.companyId === a.companyId &&
              ["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(u.role) &&
              u.status === "ACTIVE",
          )
        )
          throw new DraftError("not_found");
        const addressesRaw = await io.readFile(
          join(security.directory, "delivery_addresses.json"),
        );
        const addresses: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(addressesRaw),
        );
        if (
          !Array.isArray(addresses) ||
          !addresses.some(
            (r) =>
              r.id === draft.deliveryAddressId &&
              r.companyId === a.companyId &&
              r.active === true,
          ) ||
          !row.items?.length
        )
          throw new DraftError("conflict");
        const at = nextDraftTime(draft.updatedAt, now()),
          confirmation: PendingConfirmation = {
            id: randomUUID(),
            companyId: a.companyId,
            orderId: id,
            customerUserId: contact,
            status: "PENDING",
            createdAt: at,
            fingerprint,
          };
        const next = rows.map((r) =>
          r.id === id
            ? {
                ...r,
                status: "PENDING_CUSTOMER_CONFIRMATION" as const,
                updatedAt: at,
                confirmation,
              }
            : r,
        );
        if (!isDeepStrictEqual(next, parseCollection("orders", next)))
          throw new DraftError("unavailable");
        const text = JSON.stringify(next, null, 2) + "\n";
        if (Buffer.byteLength(text) > 10 * 1024 * 1024)
          throw new DraftError("unavailable");
        const temporary = join(
          security.directory,
          ".orders.confirmation." + randomUUID() + ".tmp",
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
        return confirmation;
      }),
  };
}
