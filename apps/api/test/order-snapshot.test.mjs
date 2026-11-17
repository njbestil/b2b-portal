import test from "node:test";
import assert from "node:assert/strict";
import { createOrderSnapshot } from "../dist/services/order-snapshot.js";
const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const input = () => ({
  orderId: id(1),
  companyId: id(2),
  submittedAt: "2026-11-17T12:00:00.000Z",
  submittedBy: {
    id: id(3),
    companyId: id(2),
    displayName: "Buyer",
    role: "CUSTOMER_USER",
    passwordHash: "PRIVATE",
  },
  delivery: {
    id: id(4),
    companyId: id(2),
    label: "Main",
    line1: "First street",
    contactName: null,
    contactPhone: null,
  },
  items: [
    {
      itemId: id(5),
      productId: id(6),
      sku: "SKU",
      name: "Apples",
      sellingUom: "KG",
      minimumOrderQuantity: "0.125",
      quantity: "0.125",
      unitPrice: "10.125",
      currency: "AED",
    },
    {
      itemId: id(7),
      productId: id(8),
      sku: "SKU2",
      name: "Rice",
      sellingUom: "Bag",
      minimumOrderQuantity: "1",
      quantity: "1",
      unitPrice: "0.234375",
      currency: "AED",
    },
  ],
});
test("snapshot freezes detached exact historical values and projects only approved fields", () => {
  const data = input(),
    snapshot = createOrderSnapshot(data);
  assert.equal(snapshot.items[0].lineTotal, "1.265625");
  assert.equal(snapshot.total, "1.5");
  assert.equal(snapshot.items[0].unitPrice, "10.125");
  assert.equal(snapshot.items[0].minimumOrderQuantity, "0.125");
  data.items[0].name = "Changed";
  data.delivery.line1 = "Changed";
  data.submittedBy.displayName = "Changed";
  assert.equal(snapshot.items[0].name, "Apples");
  assert.equal(snapshot.delivery.line1, "First street");
  assert.equal(snapshot.submittedBy.displayName, "Buyer");
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE"), false);
  assert.equal(Object.isFrozen(snapshot.items[0]), true);
  assert.equal(Object.isFrozen(snapshot.delivery), true);
});
test("snapshot refuses cross-tenant data, invalid quantity, currencies and duplicates", () => {
  for (const mutate of [
    (d) => (d.submittedBy.companyId = id(99)),
    (d) => (d.delivery.companyId = id(99)),
    (d) => (d.items[0].quantity = "0.1"),
    (d) => (d.items[0].unitPrice = "1e3"),
    (d) => (d.items[0].minimumOrderQuantity = "0"),
    (d) => (d.items[1].currency = "USD"),
    (d) => (d.items[1].productId = d.items[0].productId),
    (d) => (d.items[1].itemId = d.items[0].itemId),
    (d) => (d.items = []),
    (d) => (d.submittedAt = "2026-01-01"),
    (d) => (d.submittedBy.role = "INTERNAL_ADMIN"),
    (d) => (d.delivery.line1 = "\ninvalid"),
  ]) {
    const data = input();
    mutate(data);
    assert.throws(() => createOrderSnapshot(data));
  }
});
