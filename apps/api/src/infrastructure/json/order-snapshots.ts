import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrderSnapshot } from "../../repositories/order-snapshots.js";
import { checkedOrderSnapshot } from "../../services/order-snapshot.js";
import {
  compareDecimals,
  submissionDecimal,
} from "../../services/submission-decimal.js";
import { canonicalDraft } from "../order-draft-state.js";
import type { JsonOrder } from "./models.js";
import type { JsonSecurityCoordinator } from "./security.js";

/** Internal component, not an HTTP submission service. The trusted callback
 * must perform live validation, authorization and eventual idempotency within
 * this coordinator; checkAuthority rechecks expiry after all awaited work.
 * It must never recursively acquire the coordinator. JSON remains single-process. */
export async function commitJsonOrderSnapshot(
  security: JsonSecurityCoordinator,
  orderId: string,
  expectedVersion: string,
  prepare: (order: Readonly<JsonOrder>) => Promise<{
    readonly transitionedOrder: JsonOrder;
    readonly snapshot: OrderSnapshot;
  }>,
  checkAuthority: () => void,
): Promise<OrderSnapshot> {
  return security.run(async () => {
    checkAuthority();
    try {
      await lstat(join(security.directory, "application_intent.json"));
      throw new Error("Pending application publication.");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    const path = join(security.directory, "orders.json"),
      stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024)
      throw new Error("Snapshot store unavailable.");
    const raw: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)),
    );
    const allowed = [
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
      "commercialBaseline",
      "submittedSnapshot",
      "erpOrderReference",
    ];
    if (
      !Array.isArray(raw) ||
      raw.some(
        (r) =>
          !r ||
          typeof r !== "object" ||
          Array.isArray(r) ||
          Object.keys(r).some((k) => !allowed.includes(k)),
      )
    )
      throw new Error("Snapshot store unavailable.");
    const rows = await security.store.read("orders"),
      row = rows.find((r) => r.id === orderId);
    if (
      !row ||
      row.status !== "DRAFT" ||
      row.integrationStatus !== "NOT_SENT" ||
      row.submittedSnapshot !== undefined ||
      row.erpOrderReference !== undefined
    )
      throw new Error("Snapshot order state conflict.");
    const draft = canonicalDraft({
      ...row,
      deliveryAddressId: row.deliveryAddressId ?? null,
      updatedAt: row.updatedAt ?? row.createdAt,
    });
    if (draft.version !== expectedVersion)
      throw new Error("Snapshot draft version conflict.");
    const prepared = await prepare(structuredClone(row));
    const snapshot = checkedOrderSnapshot(prepared.snapshot);
    const transitioned = prepared.transitionedOrder;
    if (
      !transitioned ||
      typeof transitioned !== "object" ||
      Object.keys(transitioned).some((k) => !allowed.includes(k)) ||
      transitioned.id !== row.id ||
      transitioned.companyId !== row.companyId ||
      transitioned.createdByUserId !== row.createdByUserId ||
      transitioned.createdAt !== row.createdAt ||
      transitioned.deliveryAddressId !== row.deliveryAddressId ||
      transitioned.status !== "SUBMITTED" ||
      transitioned.submittedSnapshot !== undefined ||
      JSON.stringify(transitioned.items ?? []) !==
        JSON.stringify(row.items ?? []) ||
      JSON.stringify(transitioned.commercialBaseline ?? null) !==
        JSON.stringify(row.commercialBaseline ?? null)
    )
      throw new Error("Invalid prepared submission transition.");
    if (
      snapshot.orderId !== row.id ||
      snapshot.companyId !== row.companyId ||
      snapshot.submittedBy.id !== row.createdByUserId ||
      snapshot.delivery.id !== draft.deliveryAddressId ||
      snapshot.items.length !== (row.items?.length ?? 0)
    )
      throw new Error("Snapshot order mismatch.");
    for (const item of snapshot.items) {
      const prior = row.items?.find((i) => i.id === item.itemId);
      if (
        !prior ||
        prior.productId !== item.productId ||
        compareDecimals(
          submissionDecimal(prior.quantity),
          submissionDecimal(item.quantity),
        ) !== 0
      )
        throw new Error("Snapshot line mismatch.");
    }
    const next = rows.map((r) =>
      r.id === row.id ? { ...transitioned, submittedSnapshot: snapshot } : r,
    );
    if (
      Buffer.byteLength(JSON.stringify(next, null, 2) + "\n") >
      10 * 1024 * 1024
    )
      throw new Error("Snapshot store unavailable.");
    checkAuthority();
    await security.store.replace("orders", next);
    return snapshot;
  });
}
