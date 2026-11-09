import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DraftActor,
  OrderDraftRepository,
} from "../../repositories/order-drafts.js";
import type { JsonOrder } from "./models.js";
import type { JsonSecurityCoordinator } from "./security.js";
import { DraftError, draftId } from "../../services/order-drafts.js";
import { SessionError } from "../../services/session-state.js";
import {
  checkedDraftItems,
  draftQuantity,
  requireMinimum,
} from "../../services/draft-quantities.js";
import { checkedNote } from "../../services/internal-notes.js";
import {
  checkedAddress,
  addressCollection,
} from "../delivery-address-state.js";
import {
  draftActor,
  canonicalDraft,
  nextDraftTime,
} from "../order-draft-state.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { createJsonSessionFile } from "./session-file.js";
export function createJsonOrderDrafts(
  security: JsonSecurityCoordinator,
  now = Date.now,
  options: {
    newId?: () => string;
    writeOrders?: (rows: readonly JsonOrder[]) => Promise<void>;
  } = {},
): OrderDraftRepository {
  const sessions = createJsonSessionFile(security.directory),
    newId = options.newId ?? randomUUID,
    write =
      options.writeOrders ??
      ((rows: readonly JsonOrder[]) => security.store.replace("orders", rows));
  async function publish(rows: readonly JsonOrder[], check: () => void) {
    if (
      Buffer.byteLength(JSON.stringify(rows, null, 2) + "\n") >
      10 * 1024 * 1024
    )
      throw new DraftError("unavailable");
    check();
    await write(rows);
  }
  async function file(name: string): Promise<unknown | null> {
    const path = join(security.directory, name);
    try {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 10 * 1024 * 1024
      )
        throw new DraftError("unavailable");
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
      throw e;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)),
    );
  }
  async function run<T>(
    actor: DraftActor,
    work: (rows: JsonOrder[], check: () => void) => Promise<T>,
  ): Promise<T> {
    return security.run(async () => {
      try {
        if ((await file("application_intent.json")) !== null)
          throw new DraftError("unavailable");
        const account = await readJsonSecurityAccount(security, actor.userId),
          session =
            (await sessions.read()).find((r) => r.id === actor.sessionId) ??
            null;
        const check = () => draftActor(actor, account, session, now());
        check();
        // This writer must not discard unsupported future private order fields.
        const raw = await file("orders.json");
        if (
          !Array.isArray(raw) ||
          raw.some(
            (r) =>
              !r ||
              typeof r !== "object" ||
              Array.isArray(r) ||
              Object.keys(r).some(
                (k) =>
                  ![
                    "id",
                    "companyId",
                    "orderNumber",
                    "createdByUserId",
                    "createdAt",
                    "status",
                    "integrationStatus",
                    "deliveryAddressId",
                    "updatedAt",
                    "items",
                  ].includes(k),
              ),
          )
        )
          throw new DraftError("unavailable");
        const rows = await security.store.read("orders");
        check();
        return await work(rows, check);
      } catch (e) {
        if (e instanceof DraftError || e instanceof SessionError) throw e;
        throw new DraftError("unavailable");
      }
    });
  }
  const view = (row: JsonOrder) =>
    canonicalDraft({
      ...row,
      deliveryAddressId: row.deliveryAddressId ?? null,
      updatedAt: row.updatedAt ?? row.createdAt,
    });
  const owned = (rows: JsonOrder[], actor: DraftActor, id: string) =>
    rows.find(
      (r) =>
        r.id === id &&
        r.companyId === actor.companyId &&
        r.createdByUserId === actor.userId,
    ) ?? null;
  const editable = (row: JsonOrder) =>
    row.status === "DRAFT" && row.integrationStatus === "NOT_SENT";
  async function address(actor: DraftActor, id: string | null) {
    if (id === null) return;
    const raw = await file("delivery_addresses.json");
    if (raw === null) throw new DraftError("not_found");
    if (!Array.isArray(raw)) throw new DraftError("unavailable");
    let rows;
    try {
      rows = raw.map((r) => ({
        ...checkedAddress(r),
        companyId: draftId(r.companyId),
      }));
    } catch {
      throw new DraftError("unavailable");
    }
    const companies = await security.store.read("companies");
    if (
      new Set(rows.map((r) => r.id)).size !== rows.length ||
      rows.some((r) => !companies.some((c) => c.id === r.companyId))
    )
      throw new DraftError("unavailable");
    for (const companyId of new Set(rows.map((r) => r.companyId)))
      addressCollection(
        companyId,
        rows.filter((r) => r.companyId === companyId),
      );
    if (
      !rows.some(
        (r) => r.id === id && r.companyId === actor.companyId && r.active,
      )
    )
      throw new DraftError("not_found");
  }
  return {
    validationContext: (actor, id, version) =>
      run(actor, async (rows, check) => {
        const row = owned(rows, actor, id);
        if (!row) throw new DraftError("not_found");
        if (!editable(row)) throw new DraftError("conflict");
        const draft = view(row);
        if (draft.version !== version) throw new DraftError("conflict");
        const companies = await security.store.read("companies"),
          products = await security.store.read("products");
        const customerReference =
          companies.find((c) => c.id === actor.companyId)
            ?.erpCustomerReference ?? null;
        let addressEligible = false;
        if (draft.deliveryAddressId !== null) {
          try {
            await address(actor, draft.deliveryAddressId);
            addressEligible = true;
          } catch (e) {
            if (!(e instanceof DraftError && e.code === "not_found")) throw e;
          }
        }
        const lines = checkedDraftItems(row.items ?? []).map((line) => ({
          ...line,
          productReference:
            products.find((p) => p.id === line.productId)
              ?.erpProductReference ?? null,
        }));
        check();
        return { draft, customerReference, addressEligible, lines };
      }),
    items: (actor, id) =>
      run(actor, async (rows, check) => {
        const row = owned(rows, actor, id);
        if (!row || !editable(row)) throw new DraftError("not_found");
        const result = {
          draft: view(row),
          items: checkedDraftItems(row.items ?? []),
        };
        check();
        return result;
      }),
    changeItem: (actor, id, version, change) =>
      run(actor, async (rows, check) => {
        const row = owned(rows, actor, id);
        if (!row) throw new DraftError("not_found");
        if (!editable(row) || view(row).version !== version)
          throw new DraftError("conflict");
        let items = checkedDraftItems(row.items ?? []);
        const item =
          change.kind === "add"
            ? null
            : items.find((r) => r.id === change.itemId);
        if (change.kind !== "add" && !item) throw new DraftError("not_found");
        if (
          change.kind === "add" &&
          (items.length >= 100 ||
            items.some((r) => r.productId === change.productId))
        )
          throw new DraftError("conflict");
        if (change.kind !== "remove") {
          const productId =
            change.kind === "add" ? change.productId : item!.productId;
          const products = await security.store.read("products"),
            access = await security.store.read("customer_product_access");
          const product = products.find((r) => r.id === productId && r.active);
          if (
            !product ||
            !access.some(
              (r) =>
                r.productId === productId &&
                r.companyId === actor.companyId &&
                r.eligible,
            )
          )
            throw new DraftError("not_found");
          const quantity = draftQuantity(change.quantity);
          requireMinimum(quantity, product.minimumOrderQuantity);
          if (change.kind === "add") {
            let itemId;
            try {
              itemId = draftId(newId());
            } catch {
              throw new DraftError("unavailable");
            }
            if (rows.some((r) => r.items?.some((i) => i.id === itemId)))
              throw new DraftError("conflict");
            items.push({ id: itemId, productId, quantity });
          } else
            items = items.map((r) =>
              r.id === change.itemId ? { ...r, quantity } : r,
            );
        } else items = items.filter((r) => r.id !== change.itemId);
        const next: JsonOrder = {
          ...row,
          items: checkedDraftItems(items),
          deliveryAddressId: row.deliveryAddressId ?? null,
          updatedAt: nextDraftTime(row.updatedAt ?? row.createdAt, now()),
        };
        const result = { draft: view(next), items: next.items! };
        await publish(
          rows.map((r) => (r.id === id ? next : r)),
          check,
        );
        return result;
      }),
    create: (actor, addressId) =>
      run(actor, async (rows, check) => {
        await address(actor, addressId);
        let id: string;
        try {
          id = draftId(newId());
        } catch {
          throw new DraftError("unavailable");
        }
        if (rows.some((r) => r.id === id)) throw new DraftError("conflict");
        const time = new Date(now()).toISOString();
        const row: JsonOrder = {
          id,
          companyId: actor.companyId,
          createdByUserId: actor.userId,
          orderNumber: null,
          createdAt: time,
          updatedAt: time,
          deliveryAddressId: addressId,
          status: "DRAFT",
          integrationStatus: "NOT_SENT",
        };
        const result = view(row);
        await publish([...rows, row], check);
        return result;
      }),
    find: (actor, id) =>
      run(actor, async (rows) => {
        const row = owned(rows, actor, id);
        return row && editable(row) ? view(row) : null;
      }),
    update: (actor, id, version, addressId) =>
      run(actor, async (rows, check) => {
        const row = owned(rows, actor, id);
        if (!row) throw new DraftError("not_found");
        if (!editable(row) || view(row).version !== version)
          throw new DraftError("conflict");
        await address(actor, addressId);
        const next = {
            ...row,
            deliveryAddressId: addressId,
            updatedAt: nextDraftTime(row.updatedAt ?? row.createdAt, now()),
          },
          result = view(next);
        await publish(
          rows.map((r) => (r.id === id ? next : r)),
          check,
        );
        return result;
      }),
    remove: (actor, id, version) =>
      run(actor, async (rows, check) => {
        const row = owned(rows, actor, id);
        if (!row) throw new DraftError("not_found");
        if (!editable(row) || view(row).version !== version)
          throw new DraftError("conflict");
        if (row.items?.length) throw new DraftError("conflict");
        const raw = await file("order_internal_notes.json");
        if (raw !== null) {
          if (!Array.isArray(raw)) throw new DraftError("unavailable");
          const notes = raw.map(checkedNote);
          if (new Set(notes.map((n) => n.id)).size !== notes.length)
            throw new DraftError("unavailable");
          if (notes.some((n) => n.orderId === id))
            throw new DraftError("conflict");
        }
        await publish(
          rows.filter((r) => r.id !== id),
          check,
        );
      }),
  };
}
