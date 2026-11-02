export interface AccountStatusResult {
  readonly target: {
    readonly id: string;
    readonly kind: "user" | "company";
    readonly status:
      "PENDING" | "ACTIVE" | "SUSPENDED" | "REJECTED" | "DEACTIVATED";
  };
}
