import type { AccountStatus } from "./common.js";
export type StatusTargetKind = "user" | "company";
export interface StatusActor {
  readonly userId: string;
  readonly sessionId: string;
}
export interface StatusTarget {
  readonly id: string;
  readonly kind: StatusTargetKind;
  readonly status: AccountStatus;
  readonly companyId: string | null;
}
export interface AccountStatusRepository {
  current(
    actor: StatusActor,
    kind: StatusTargetKind,
    id: string,
  ): Promise<StatusTarget>;
  change(
    actor: StatusActor,
    kind: StatusTargetKind,
    id: string,
    expected: "ACTIVE" | "SUSPENDED",
    next: "ACTIVE" | "SUSPENDED",
  ): Promise<StatusTarget>;
}
