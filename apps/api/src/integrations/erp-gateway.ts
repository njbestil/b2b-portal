/** ERP-neutral application port. No Mock ERP payloads or HTTP objects escape. */
export interface ErpGateway {
  /** Read-only availability, not catalog freshness or order acceptance. */
  checkAvailability(signal: AbortSignal): Promise<boolean>;
}
