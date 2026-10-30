import type {
  JsonCollection,
  JsonCollections,
} from "../infrastructure/json/models.js";

export const demoId = (n: number) =>
  `d3e00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const demoTimestamp = "2026-10-30T00:00:00.000Z";
/** Synthetic read-port dataset, not credentials or a complete future workflow. */
export function createDemoData(): {
  [K in JsonCollection]: JsonCollections[K][];
} {
  return {
    companies: [1, 2].map((n) => ({
      id: demoId(n),
      legalName: `Demo Company ${n}`,
      tradeName: `Demo Trading ${n}`,
      status: "ACTIVE",
      erpCustomerReference: `DEMO-C00${n}`,
    })),
    users: [
      {
        id: demoId(10),
        companyId: null,
        displayName: "Demo Internal Admin",
        role: "INTERNAL_ADMIN",
        status: "ACTIVE",
      },
      {
        id: demoId(11),
        companyId: null,
        displayName: "Demo Sales Staff",
        role: "SALES_STAFF",
        status: "ACTIVE",
      },
      ...[1, 2].flatMap((n) => [
        {
          id: demoId(20 + n),
          companyId: demoId(n),
          displayName: `Demo Admin ${n}`,
          role: "CUSTOMER_ADMIN" as const,
          status: "ACTIVE" as const,
        },
        {
          id: demoId(30 + n),
          companyId: demoId(n),
          displayName: `Demo Buyer ${n}`,
          role: "CUSTOMER_USER" as const,
          status: "ACTIVE" as const,
        },
      ]),
    ],
    products: [1, 2, 3].map((n) => ({
      id: demoId(100 + n),
      sku: `DEMO-P00${n}`,
      name: `Demo Product ${n}`,
      sellingUom: n === 3 ? "KG" : "CASE",
      minimumOrderQuantity: n === 3 ? "0.125" : "1",
      active: true,
      defaultPrice: {
        amount: n === 3 ? "10.125" : "25.00",
        currency: "AED",
        validFrom: null,
        validTo: null,
      },
    })),
    customer_product_access: [1, 2].flatMap((n) =>
      [1, 2, 3].map((p) => ({
        companyId: demoId(n),
        productId: demoId(100 + p),
        eligible: !(n === 2 && p === 2),
      })),
    ),
    customer_product_prices: [1, 2].map((n) => ({
      companyId: demoId(n),
      productId: demoId(101),
      price: {
        amount: n === 1 ? "20.00" : "22.50",
        currency: "AED",
        validFrom: null,
        validTo: null,
      },
    })),
    orders: [1, 2, 3].map((n) => ({
      id: demoId(200 + n),
      companyId: demoId(n === 3 ? 2 : 1),
      orderNumber: n === 1 ? null : `DEMO-ORDER-${n}`,
      createdByUserId: demoId(n === 3 ? 32 : 31),
      createdAt: demoTimestamp,
      status: n === 1 ? "DRAFT" : n === 2 ? "SUBMITTED" : "CONFIRMED",
      integrationStatus: n === 1 ? "NOT_SENT" : n === 2 ? "FAILED" : "SUCCESS",
    })),
  };
}
