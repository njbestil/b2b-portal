/** Synthetic ERP wire data, not portal persistence entities or frontend contracts. */
export interface MockErpMasterData {
  customers: {
    customerId: string;
    name: string;
    active: boolean;
    paymentTerms: string;
  }[];
  products: {
    productId: string;
    sku: string;
    name: string;
    sellingUom: "Piece" | "Pack" | "Carton" | "Case" | "Bag" | "KG";
    minimumOrderQuantity: string;
    packSize: string | null;
    active: boolean;
  }[];
  pricing: {
    productId: string;
    /** null identifies the default B2B price; a customer price overrides it. */
    customerId: string | null;
    unitPrice: string;
    currency: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }[];
  eligibility: {
    customerId: string;
    productId: string;
    eligible: boolean;
  }[];
  inventory: { productId: string; availableQuantity: string }[];
  credit: {
    customerId: string;
    status: "clear" | "hold";
    currency: string;
    creditLimit: string;
    outstandingBalance: string;
  }[];
}

/** A fresh seed on every call: no clock, randomness, disk, or shared mutable state. */
export function createMasterData(): MockErpMasterData {
  return {
    customers: [
      {
        customerId: "DEMO-C001",
        name: "Demo Harbour Kitchen",
        active: true,
        paymentTerms: "NET30",
      },
      {
        customerId: "DEMO-C002",
        name: "Demo Orchard Cafe",
        active: true,
        paymentTerms: "NET15",
      },
    ],
    products: [
      {
        productId: "DEMO-P001",
        sku: "DEMO-RICE-BAG",
        name: "Demo Rice",
        sellingUom: "Bag",
        minimumOrderQuantity: "1",
        packSize: "5 KG",
        active: true,
      },
      {
        productId: "DEMO-P002",
        sku: "DEMO-MILK-CARTON",
        name: "Demo Milk",
        sellingUom: "Carton",
        minimumOrderQuantity: "2",
        packSize: "12 x 1 L",
        active: true,
      },
      {
        productId: "DEMO-P003",
        sku: "DEMO-APPLE-KG",
        name: "Demo Apples",
        sellingUom: "KG",
        minimumOrderQuantity: "0.5",
        packSize: null,
        active: true,
      },
      {
        productId: "DEMO-P004",
        sku: "DEMO-RETIRED-PIECE",
        name: "Demo Retired Loaf",
        sellingUom: "Piece",
        minimumOrderQuantity: "1",
        packSize: null,
        active: false,
      },
      {
        productId: "DEMO-P005",
        sku: "DEMO-UNPRICED-PACK",
        name: "Demo Unpriced Biscuits",
        sellingUom: "Pack",
        minimumOrderQuantity: "1",
        packSize: "6 pieces",
        active: true,
      },
    ],
    pricing: [
      {
        productId: "DEMO-P001",
        customerId: null,
        unitPrice: "30.00",
        currency: "AED",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveTo: null,
      },
      {
        productId: "DEMO-P001",
        customerId: "DEMO-C001",
        unitPrice: "27.50",
        currency: "AED",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveTo: null,
      },
      {
        productId: "DEMO-P002",
        customerId: null,
        unitPrice: "48.00",
        currency: "AED",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveTo: null,
      },
      {
        productId: "DEMO-P003",
        customerId: null,
        unitPrice: "8.25",
        currency: "AED",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveTo: null,
      },
      {
        productId: "DEMO-P004",
        customerId: null,
        unitPrice: "5.00",
        currency: "AED",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveTo: null,
      },
    ],
    eligibility: [
      { customerId: "DEMO-C001", productId: "DEMO-P001", eligible: true },
      { customerId: "DEMO-C001", productId: "DEMO-P002", eligible: true },
      { customerId: "DEMO-C001", productId: "DEMO-P003", eligible: true },
      { customerId: "DEMO-C001", productId: "DEMO-P004", eligible: true },
      { customerId: "DEMO-C001", productId: "DEMO-P005", eligible: true },
      { customerId: "DEMO-C002", productId: "DEMO-P001", eligible: true },
      { customerId: "DEMO-C002", productId: "DEMO-P002", eligible: false },
      { customerId: "DEMO-C002", productId: "DEMO-P003", eligible: true },
      { customerId: "DEMO-C002", productId: "DEMO-P004", eligible: true },
      { customerId: "DEMO-C002", productId: "DEMO-P005", eligible: true },
    ],
    inventory: [
      { productId: "DEMO-P001", availableQuantity: "100" },
      { productId: "DEMO-P002", availableQuantity: "0" },
      { productId: "DEMO-P003", availableQuantity: "25.5" },
      { productId: "DEMO-P004", availableQuantity: "10" },
      { productId: "DEMO-P005", availableQuantity: "20" },
    ],
    credit: [
      {
        customerId: "DEMO-C001",
        status: "clear",
        currency: "AED",
        creditLimit: "10000.00",
        outstandingBalance: "1250.00",
      },
      {
        customerId: "DEMO-C002",
        status: "hold",
        currency: "AED",
        creditLimit: "2000.00",
        outstandingBalance: "2250.00",
      },
    ],
  };
}
