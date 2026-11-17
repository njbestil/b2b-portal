/** Customer-scoped invoice metadata. Private ERP/document references never cross this boundary. */
export interface PortalInvoice {
  readonly id: string;
  readonly orderId: string;
  readonly invoiceNumber: string;
  readonly status: "available";
  readonly amount: string;
  readonly currency: string;
  readonly issuedAt: string;
  readonly syncedAt: string;
  readonly documentAvailable: boolean;
}
export interface PortalInvoicePage {
  readonly items: readonly PortalInvoice[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}
