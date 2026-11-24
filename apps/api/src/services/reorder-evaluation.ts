import type { CatalogSnapshot } from "../repositories/catalog-sync.js";
import type { OrderSnapshot } from "../repositories/order-snapshots.js";
import { checkedOrderSnapshot } from "./order-snapshot.js";
import { checkedCatalog } from "./catalog-sync.js";
import { validateSubmission } from "./submission-validation.js";
import { compareDecimals, submissionDecimal } from "./submission-decimal.js";
import { draftId } from "./order-drafts.js";
import { checkedDraftItems } from "./draft-quantities.js";

/** Evaluate a detached, current provider snapshot. The caller owns authorization and persistence. */
export function evaluateReorder(
  historic: OrderSnapshot,
  companyId: string,
  sourceOrderId: string,
  creatorId: string,
  customerReference: string,
  references: readonly {
    id: string;
    reference: string | null;
    eligible: boolean;
  }[],
  catalogInput: CatalogSnapshot,
  now: number,
) {
  const order = checkedOrderSnapshot(historic);
  if (
    order.orderId !== sourceOrderId ||
    order.companyId !== companyId ||
    order.submittedBy.id !== creatorId
  )
    throw new TypeError("Snapshot identity mismatch.");
  const catalog = checkedCatalog(catalogInput);
  const prices: {
    itemId: string;
    previous: string;
    current: string | null;
    currency: string | null;
    changed: boolean;
  }[] = [];
  const valid = (p: { validFrom: string | null; validTo: string | null }) =>
    (p.validFrom === null || Date.parse(p.validFrom) <= now) &&
    (p.validTo === null || now < Date.parse(p.validTo));
  const lines = order.items.map((item) => {
    const ref = references.find((r) => r.id === item.productId);
    if (!ref) throw new TypeError("Missing product reference.");
    const product = catalog.products.find(
      (p) => p.reference === ref.reference && p.active,
    );
    const allowed =
      ref.eligible &&
      catalog.access.some(
        (a) =>
          a.customerReference === customerReference &&
          a.productReference === ref.reference &&
          a.eligible,
      );
    const candidates = catalog.prices.filter(
      (p) => p.productReference === ref.reference && valid(p.price),
    );
    const price =
      candidates.find((p) => p.customerReference === customerReference)
        ?.price ??
      candidates.find((p) => p.customerReference === null)?.price ??
      null;
    const current = product && allowed ? price : null;
    prices.push({
      itemId: item.itemId,
      previous: item.unitPrice,
      current: current?.amount ?? null,
      currency: current?.currency ?? null,
      changed:
        current !== null &&
        (current.currency !== item.currency ||
          compareDecimals(
            submissionDecimal(current.amount),
            submissionDecimal(item.unitPrice),
          ) !== 0),
    });
    return {
      id: item.itemId,
      quantity: item.quantity,
      product:
        product && allowed
          ? {
              sellingUom: product.sellingUom,
              minimumOrderQuantity: product.minimumOrderQuantity,
              availableQuantity: product.metadata?.availableQuantity ?? null,
              price: current && {
                amount: current.amount,
                currency: current.currency,
              },
            }
          : null,
    };
  });
  const issues = validateSubmission({
    accountEligible: catalog.customers.some(
      (c) => c.reference === customerReference && c.active,
    ),
    addressEligible: true,
    minimum: { amount: "0", currency: order.currency },
    lines,
  });
  return { order, issues, prices };
}

export function materializeReorder(
  evaluated: ReturnType<typeof evaluateReorder>,
  newId: () => string,
) {
  const mapping = new Map(
    evaluated.order.items.map((item) => [item.itemId, draftId(newId())]),
  );
  const items = checkedDraftItems(
    evaluated.order.items.map((item) => ({
      id: mapping.get(item.itemId)!,
      productId: item.productId,
      quantity: item.quantity,
    })),
  );
  return {
    items,
    issues: evaluated.issues.map((issue) =>
      issue.itemId ? { ...issue, itemId: mapping.get(issue.itemId)! } : issue,
    ),
    prices: evaluated.prices.map((price) => ({
      ...price,
      itemId: mapping.get(price.itemId)!,
    })),
  };
}
