import {
  RemoteError,
  entityId,
  object,
  safeText,
  timestamp,
  unavailable,
  type ApiTransport,
} from "../../shared/remote";
export interface ReviewApplication {
  companyId: string;
  version: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  companyName: string;
  tradeLicenseReference: string;
  businessEmail: string;
  phone: string;
  billingAddress: string;
  deliveryAddress: string;
  administratorName: string;
  administratorEmail: string;
  administratorMobile: string;
  createdAt: string;
  rejectionReason: string | null;
  auditState: "completed" | "pending" | "unknown";
  notificationState: "completed" | "pending" | "unknown";
}
export interface ReviewPage {
  items: ReviewApplication[];
  total: number;
}
export type ReviewCommand =
  | { companyId: string; version: string; decision: "approve" }
  | { companyId: string; version: string; decision: "reject"; reason: string };
/** Normalized UI port; routes/projections are explicitly proposed to the API owner. */
export interface ReviewAdapter {
  list(
    input: { offset: number; limit: number },
    signal: AbortSignal,
  ): Promise<unknown>;
  detail(companyId: string, signal: AbortSignal): Promise<unknown>;
  decide(command: ReviewCommand, signal: AbortSignal): Promise<unknown>;
}
const empty: ReviewAdapter = {
  list: unavailable,
  detail: unavailable,
  decide: unavailable,
};
const fields = {
  companyName: 200,
  tradeLicenseReference: 100,
  businessEmail: 254,
  phone: 40,
  billingAddress: 500,
  deliveryAddress: 500,
  administratorName: 160,
  administratorEmail: 254,
  administratorMobile: 40,
} as const;
export function reviewApplication(value: unknown): ReviewApplication {
  if (
    !object(value) ||
    !entityId(value.companyId) ||
    !safeText(value.version, 200) ||
    !["PENDING", "APPROVED", "REJECTED"].includes(String(value.status)) ||
    !timestamp(value.createdAt)
  )
    throw new RemoteError("unavailable");
  const projection: Record<string, unknown> = {};
  for (const [key, limit] of Object.entries(fields)) {
    if (!safeText(value[key], limit)) throw new RemoteError("unavailable");
    projection[key] = value[key];
  }
  if (value.rejectionReason != null && !safeText(value.rejectionReason, 1000))
    throw new RemoteError("unavailable");
  if (value.status === "REJECTED" && !value.rejectionReason)
    throw new RemoteError("unavailable");
  for (const key of ["auditState", "notificationState"])
    if (
      value[key] != null &&
      !["completed", "pending", "unknown"].includes(String(value[key]))
    )
      throw new RemoteError("unavailable");
  return {
    ...projection,
    companyId: value.companyId,
    version: value.version,
    status: value.status,
    createdAt: value.createdAt,
    rejectionReason: value.rejectionReason ?? null,
    auditState: value.auditState ?? "unknown",
    notificationState: value.notificationState ?? "unknown",
  } as ReviewApplication;
}
export class ReviewClient {
  #adapter: ReviewAdapter;
  constructor(adapter: ReviewAdapter = empty) {
    this.#adapter = adapter;
  }
  async list(offset: number, signal: AbortSignal): Promise<ReviewPage> {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new RemoteError("invalid");
    try {
      const value = await this.#adapter.list({ offset, limit: 20 }, signal);
      if (
        !object(value) ||
        !Array.isArray(value.items) ||
        value.items.length > 20 ||
        !Number.isSafeInteger(value.total) ||
        (value.total as number) < 0
      )
        throw new RemoteError("unavailable");
      const items = value.items.map(reviewApplication);
      if (
        new Set(items.map((a) => a.companyId.toLowerCase())).size !==
          items.length ||
        items.length > (value.total as number) ||
        (items.length > 0 && offset + items.length > (value.total as number))
      )
        throw new RemoteError("unavailable");
      return { items, total: value.total as number };
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError("unavailable");
    }
  }
  async detail(id: string, signal: AbortSignal) {
    if (!entityId(id)) throw new RemoteError("not-found");
    try {
      const app = reviewApplication(await this.#adapter.detail(id, signal));
      if (app.companyId.toLowerCase() !== id.toLowerCase())
        throw new RemoteError("unavailable");
      return app;
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError("unavailable");
    }
  }
  async decide(
    current: ReviewApplication,
    decision: "approve" | "reject",
    reason: string,
    signal: AbortSignal,
  ) {
    current = reviewApplication(current);
    if (current.status !== "PENDING") throw new RemoteError("conflict");
    if (decision !== "approve" && decision !== "reject")
      throw new RemoteError("invalid");
    if (decision === "reject" && !safeText(reason.trim(), 1000))
      throw new RemoteError("invalid");
    const command: ReviewCommand =
      decision === "approve"
        ? { companyId: current.companyId, version: current.version, decision }
        : {
            companyId: current.companyId,
            version: current.version,
            decision,
            reason: reason.trim(),
          };
    try {
      const app = reviewApplication(
        await this.#adapter.decide(command, signal),
      );
      if (
        app.companyId.toLowerCase() !== current.companyId.toLowerCase() ||
        app.status !== (decision === "approve" ? "APPROVED" : "REJECTED")
      )
        throw new RemoteError("unavailable");
      return app;
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError("unavailable");
    }
  }
}
export function reviewHttpAdapter(
  transport: ApiTransport,
  routes: {
    list: string;
    detail: (id: string) => string;
    decision: (id: string) => string;
  },
): ReviewAdapter {
  const detail = async (path: string, signal: AbortSignal) => {
    const data = await transport({ path, method: "GET" }, signal);
    return object(data) ? data.application : undefined;
  };
  return {
    list: (input, signal) =>
      transport(
        {
          path: `${routes.list}?offset=${input.offset}&limit=${input.limit}`,
          method: "GET",
        },
        signal,
      ),
    detail: (id, signal) => detail(routes.detail(id), signal),
    async decide(command, signal) {
      const { companyId, ...body } = command;
      const data = await transport(
        { path: routes.decision(companyId), method: "POST", body },
        signal,
      );
      return object(data) ? data.application : undefined;
    },
  };
}
