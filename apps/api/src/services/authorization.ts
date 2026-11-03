import type { AuthenticatedPrincipal } from "./sessions.js";
import { requireNormalAccess } from "./session-state.js";
type Role = AuthenticatedPrincipal["role"];
export const permissions = Object.freeze({
  "order-drafts.read": Object.freeze(["CUSTOMER_ADMIN", "CUSTOMER_USER"]),
  "order-drafts.manage": Object.freeze(["CUSTOMER_ADMIN", "CUSTOMER_USER"]),
  "company-profile.read": Object.freeze([
    "INTERNAL_ADMIN",
    "SALES_STAFF",
    "CUSTOMER_ADMIN",
    "CUSTOMER_USER",
  ]),
  "company-profile.manage": Object.freeze(["CUSTOMER_ADMIN"]),
  "delivery-addresses.read": Object.freeze([
    "INTERNAL_ADMIN",
    "SALES_STAFF",
    "CUSTOMER_ADMIN",
    "CUSTOMER_USER",
  ]),
  "delivery-addresses.manage": Object.freeze(["CUSTOMER_ADMIN"]),
  "customer-users.manage": Object.freeze(["CUSTOMER_ADMIN"]),
  "accounts.status.read": Object.freeze(["INTERNAL_ADMIN"]),
  "accounts.status.write": Object.freeze(["INTERNAL_ADMIN"]),
  "profile.read": Object.freeze([
    "INTERNAL_ADMIN",
    "SALES_STAFF",
    "CUSTOMER_ADMIN",
    "CUSTOMER_USER",
  ]),
  "company.read": Object.freeze([
    "INTERNAL_ADMIN",
    "SALES_STAFF",
    "CUSTOMER_ADMIN",
    "CUSTOMER_USER",
  ]),
  "catalog.read": Object.freeze([
    "INTERNAL_ADMIN",
    "SALES_STAFF",
    "CUSTOMER_ADMIN",
    "CUSTOMER_USER",
  ]),
  "orders.read": Object.freeze([
    "INTERNAL_ADMIN",
    "SALES_STAFF",
    "CUSTOMER_ADMIN",
    "CUSTOMER_USER",
  ]),
  "customer-users.read": Object.freeze([
    "INTERNAL_ADMIN",
    "SALES_STAFF",
    "CUSTOMER_ADMIN",
  ]),
  "applications.read": Object.freeze(["INTERNAL_ADMIN"]),
  "sales.companies.read": Object.freeze(["SALES_STAFF"]),
} satisfies Record<string, readonly Role[]>);
export type Permission = keyof typeof permissions;
const brand: unique symbol = Symbol("backend-authorized-actor");
export type AuthorizedActor = Readonly<AuthenticatedPrincipal> & {
  readonly [brand]: true;
};
const admitted = new WeakSet<object>();
export class AuthorizationError extends Error {
  constructor() {
    super("Not permitted.");
    this.name = "AuthorizationError";
  }
}
function roleAllows(role: unknown, permission: Permission) {
  return (
    Object.hasOwn(permissions, permission) &&
    typeof role === "string" &&
    (permissions[permission] as readonly string[]).includes(role)
  );
}
/** Runtime capability check: a structural object or serialized profile is not proof. */
export function requirePermission(
  actor: AuthorizedActor,
  permission: Permission,
): void {
  if (!actor || !admitted.has(actor) || !roleAllows(actor.role, permission))
    throw new AuthorizationError();
  requireNormalAccess(actor);
}
export function createAuthorization(
  authenticate: (token: string) => Promise<AuthenticatedPrincipal>,
) {
  return {
    async admit(
      token: string,
      permission: Permission,
    ): Promise<AuthorizedActor> {
      const principal = await authenticate(token);
      requireNormalAccess(principal);
      if (!roleAllows(principal.role, permission))
        throw new AuthorizationError();
      const actor = Object.freeze({ ...principal, [brand]: true as const });
      admitted.add(actor);
      return actor;
    },
  };
}
