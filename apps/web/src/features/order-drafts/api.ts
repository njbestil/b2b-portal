import {
  AuthError,
  type SessionClient,
  type SessionUser,
} from "../authentication/session";
import {
  entityId,
  object,
  RemoteError,
  safeText,
  timestamp,
} from "../../shared/remote";

export type Draft = {
  id: string;
  companyId: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  version: string;
  deliveryAddressId: string | null;
};
export type Item = { id: string; productId: string; quantity: string };
export type Basket = { draft: Draft; items: Item[] };
export function quantity(value: string): boolean {
  return (
    /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(value) &&
    /[1-9]/.test(value)
  );
}
export function meetsMinimum(value: string, minimum: string): boolean {
  if (!quantity(value) || !quantity(minimum)) return false;
  const scale = (v: string) => {
    const [whole, fraction = ""] = v.split(".");
    return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  };
  return scale(value) >= scale(minimum);
}
function parseDraft(value: unknown, user: SessionUser): Draft {
  if (
    !object(value) ||
    !entityId(value.id) ||
    value.companyId !== user.companyId ||
    value.createdByUserId !== user.id ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    !safeText(value.version, 200) ||
    value.status !== "DRAFT" ||
    value.integrationStatus !== "NOT_SENT" ||
    (value.deliveryAddressId !== null && !entityId(value.deliveryAddressId))
  )
    throw new RemoteError("unavailable");
  return {
    id: value.id,
    companyId: value.companyId as string,
    createdByUserId: value.createdByUserId as string,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: value.version,
    deliveryAddressId: value.deliveryAddressId as string | null,
  };
}
function parseBasket(value: unknown, user: SessionUser): Basket {
  if (!object(value) || !Array.isArray(value.items) || value.items.length > 100)
    throw new RemoteError("unavailable");
  const draft = parseDraft(value.draft, user);
  const items = value.items.map((item): Item => {
    if (
      !object(item) ||
      !entityId(item.id) ||
      !entityId(item.productId) ||
      typeof item.quantity !== "string" ||
      !quantity(item.quantity)
    )
      throw new RemoteError("unavailable");
    return { id: item.id, productId: item.productId, quantity: item.quantity };
  });
  if (
    new Set(items.map((i) => i.id)).size !== items.length ||
    new Set(items.map((i) => i.productId)).size !== items.length
  )
    throw new RemoteError("unavailable");
  return { draft, items };
}
export class DraftClient {
  constructor(
    private readonly session: SessionClient,
    private readonly user: SessionUser,
  ) {}
  private async request(
    path: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.session.request(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok)
        throw new RemoteError(
          response.status === 400
            ? "invalid"
            : response.status === 401
              ? "session"
              : response.status === 403
                ? "forbidden"
                : response.status === 404
                  ? "not-found"
                  : response.status === 409
                    ? "conflict"
                    : response.status === 429
                      ? "rate"
                      : "unavailable",
        );
      if (
        !/^application\/json(?:;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        throw new RemoteError("unavailable");
      const data: unknown = await response.json();
      if (
        !object(data) ||
        data.success !== true ||
        !entityId(data.requestId) ||
        !object(data.data)
      )
        throw new RemoteError("unavailable");
      return data.data;
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      if (
        error instanceof AuthError &&
        (error.code === "session" || error.code === "restricted")
      )
        throw new RemoteError("session");
      throw new RemoteError("unavailable");
    }
  }
  async list(offset: number): Promise<{ drafts: Draft[]; total: number }> {
    const data = await this.request(
      `/api/v1/companies/${this.user.companyId}/orders?offset=${offset}&limit=20`,
      "GET",
    );
    if (
      !Array.isArray(data.items) ||
      !Number.isSafeInteger(data.total) ||
      (data.total as number) < 0 ||
      data.items.length > 20
    )
      throw new RemoteError("unavailable");
    const drafts: Draft[] = [];
    for (const item of data.items) {
      if (
        !object(item) ||
        !entityId(item.id) ||
        item.companyId !== this.user.companyId
      )
        throw new RemoteError("unavailable");
      if (item.status !== "DRAFT" || item.integrationStatus !== "NOT_SENT")
        continue;
      try {
        const result = await this.request(
          `/api/v1/order-drafts/${item.id}`,
          "GET",
        );
        drafts.push(parseDraft(result.draft, this.user));
      } catch (error) {
        if (!(error instanceof RemoteError && error.code === "not-found"))
          throw error;
      }
    }
    return { drafts, total: data.total as number };
  }
  async create(): Promise<Draft> {
    return parseDraft(
      (await this.request("/api/v1/order-drafts", "POST", {})).draft,
      this.user,
    );
  }
  async read(id: string): Promise<Basket> {
    if (!entityId(id)) throw new RemoteError("invalid");
    const result = parseBasket(
      await this.request(`/api/v1/order-drafts/${id}/items`, "GET"),
      this.user,
    );
    if (result.draft.id !== id) throw new RemoteError("unavailable");
    return result;
  }
  async add(b: Basket, productId: string, value: string): Promise<Basket> {
    if (!entityId(productId) || !quantity(value))
      throw new RemoteError("invalid");
    return parseBasket(
      await this.request(`/api/v1/order-drafts/${b.draft.id}/items`, "POST", {
        version: b.draft.version,
        productId,
        quantity: value,
      }),
      this.user,
    );
  }
  async update(b: Basket, item: Item, value: string): Promise<Basket> {
    if (!quantity(value)) throw new RemoteError("invalid");
    return parseBasket(
      await this.request(
        `/api/v1/order-drafts/${b.draft.id}/items/${item.id}`,
        "PATCH",
        { version: b.draft.version, quantity: value },
      ),
      this.user,
    );
  }
  async remove(b: Basket, item: Item): Promise<Basket> {
    return parseBasket(
      await this.request(
        `/api/v1/order-drafts/${b.draft.id}/items/${item.id}`,
        "DELETE",
        { version: b.draft.version },
      ),
      this.user,
    );
  }
  async address(b: Basket, addressId: string | null): Promise<Basket> {
    const value = await this.request(
      `/api/v1/order-drafts/${b.draft.id}`,
      "PATCH",
      { version: b.draft.version, deliveryAddressId: addressId },
    );
    return { draft: parseDraft(value.draft, this.user), items: b.items };
  }
  async delete(b: Basket): Promise<void> {
    const value = await this.request(
      `/api/v1/order-drafts/${b.draft.id}`,
      "DELETE",
      { version: b.draft.version },
    );
    if (value.deleted !== true || value.draftId !== b.draft.id)
      throw new RemoteError("unavailable");
  }
}
