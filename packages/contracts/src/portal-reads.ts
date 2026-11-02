/** Explicit public allowlists; private repository fields never pass through. */
export interface PortalCompany {
  readonly id: string;
  readonly legalName: string;
  readonly tradeName: string;
  readonly status: string;
  readonly erpCustomerReference: string | null;
}
export interface PortalCustomerUser {
  readonly id: string;
  readonly companyId: string;
  readonly displayName: string;
  readonly role: "CUSTOMER_ADMIN" | "CUSTOMER_USER";
  readonly status: string;
}
export interface PortalProduct {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly sellingUom: string;
  readonly minimumOrderQuantity: string;
  readonly price: { readonly amount: string; readonly currency: string } | null;
}
export interface PortalOrder {
  readonly id: string;
  readonly companyId: string;
  readonly orderNumber: string | null;
  readonly createdAt: string;
  readonly status: string;
  readonly integrationStatus: string;
}
export interface PortalPage<T> {
  readonly items: readonly T[];
  readonly total: number;
}
