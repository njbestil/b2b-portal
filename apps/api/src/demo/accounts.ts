import { demoId } from "./dataset.js";
import type { JsonUser, JsonCompany } from "../infrastructure/json/models.js";
import type { SalesAssignment } from "../repositories/sales-assignments.js";
import { checkedAssignments } from "../services/sales-assignments.js";
import { validNewPassword } from "../services/password-policy.js";
import { hashPassword, verifyPassword } from "../infrastructure/passwords.js";

export class DemoAccountsError extends Error {
  constructor() {
    super("Demo account operation refused or failed.");
    this.name = "DemoAccountsError";
  }
}
export const demoAccounts = [
  {
    key: "internal-admin",
    id: demoId(10),
    email: "internal-admin@demo.example.test",
    role: "INTERNAL_ADMIN",
    companyId: null,
    secret: "DEMO_INTERNAL_ADMIN_PASSWORD",
  },
  {
    key: "sales-staff",
    id: demoId(11),
    email: "sales-staff@demo.example.test",
    role: "SALES_STAFF",
    companyId: null,
    secret: "DEMO_SALES_STAFF_PASSWORD",
  },
  {
    key: "customer-admin",
    id: demoId(21),
    email: "customer-admin@demo.example.test",
    role: "CUSTOMER_ADMIN",
    companyId: demoId(1),
    secret: "DEMO_CUSTOMER_ADMIN_PASSWORD",
  },
  {
    key: "customer-user",
    id: demoId(31),
    email: "customer-user@demo.example.test",
    role: "CUSTOMER_USER",
    companyId: demoId(1),
    secret: "DEMO_CUSTOMER_USER_PASSWORD",
  },
] as const;
export type DemoAccountKey = (typeof demoAccounts)[number]["key"];
export const demoAssignmentId = demoId(400);
export const demoMarker = "b2b-portal-demo:v1";
export function demoTarget(value: unknown): value is string {
  return typeof value === "string" && /^b2b_demo_[a-z0-9_]{1,40}$/.test(value);
}
/** No secrets are consumed by runtime configuration. Production cannot opt in. */
export function demoMode(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const names = [
    "DEMO_ACCOUNTS_ENABLED",
    "DEMO_DEPLOYMENT",
    "DEMO_ACCOUNTS_TARGET",
  ];
  if (names.every((name) => env[name] === undefined)) return undefined;
  if (
    env.NODE_ENV !== "development" ||
    env.DEMO_ACCOUNTS_ENABLED !== "true" ||
    env.DEMO_DEPLOYMENT !== "dedicated-demo" ||
    !demoTarget(env.DEMO_ACCOUNTS_TARGET)
  )
    throw new DemoAccountsError();
  return env.DEMO_ACCOUNTS_TARGET;
}
export function selectedAccounts(value: unknown) {
  if (value === "all") return [...demoAccounts];
  const account = demoAccounts.find((row) => row.key === value);
  if (!account) throw new DemoAccountsError();
  return [account];
}
export function ownedAccounts(
  users: readonly JsonUser[],
  companies: readonly JsonCompany[],
  inputAssignments: unknown,
) {
  if (users.length > 10000 || companies.length > 10000)
    throw new DemoAccountsError();
  for (const definition of demoAccounts) {
    const matches = users.filter((user) => user.id === definition.id);
    const user = matches[0];
    if (
      matches.length !== 1 ||
      !user ||
      user.role !== definition.role ||
      user.companyId !== definition.companyId ||
      user.status !== "ACTIVE" ||
      (user.email !== undefined &&
        user.email !== definition.email &&
        user.email !== definition.id + "@example.test") ||
      users.some(
        (other) =>
          other.id !== definition.id &&
          other.email?.toLowerCase() === definition.email,
      )
    )
      throw new DemoAccountsError();
    if (
      user.email !== definition.email &&
      user.passwordHash !== undefined &&
      user.passwordHash !== "!DISABLED_DEMO_LOGIN!"
    )
      throw new DemoAccountsError();
  }
  const company = companies.find((row) => row.id === demoId(1));
  if (
    !company ||
    company.status !== "ACTIVE" ||
    company.erpCustomerReference !== "DEMO-C001"
  )
    throw new DemoAccountsError();
  const assignments = checkedAssignments(inputAssignments);
  const own = assignments.find((row) => row.id === demoAssignmentId);
  if (
    own &&
    (own.companyId !== demoId(1) ||
      own.salesStaffUserId !== demoId(11) ||
      own.assignedByUserId !== demoId(10) ||
      !own.active ||
      !own.isPrimary ||
      own.endedAt !== null)
  )
    throw new DemoAccountsError();
  if (
    assignments.some(
      (row) =>
        row.id !== demoAssignmentId &&
        row.active &&
        (row.salesStaffUserId === demoId(11) ||
          (row.companyId === demoId(1) && row.isPrimary)),
    )
  )
    throw new DemoAccountsError();
  return assignments;
}
/** All selected hashes are prepared before either store publishes any row. */
export async function accountPlan(
  users: readonly JsonUser[],
  companies: readonly JsonCompany[],
  inputAssignments: unknown,
  selection: unknown,
  secrets: Readonly<Record<string, string | undefined>>,
  now = new Date().toISOString(),
  hash = hashPassword,
  verify = verifyPassword,
) {
  const assignments = ownedAccounts(users, companies, inputAssignments),
    selected = selectedAccounts(selection);
  for (const account of selected)
    if (!validNewPassword(secrets[account.secret]))
      throw new DemoAccountsError();
  const changed = new Map<string, JsonUser>();
  for (const account of selected) {
    const user = users.find((row) => row.id === account.id)!;
    const password = secrets[account.secret]!;
    const unchanged =
      user.email === account.email &&
      user.passwordHash !== undefined &&
      (await verify(password, user.passwordHash));
    const passwordHash = unchanged ? user.passwordHash! : await hash(password);
    if (!/^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(passwordHash))
      throw new DemoAccountsError();
    changed.set(user.id, {
      ...user,
      email: account.email,
      passwordHash,
      mustChangePassword: false,
    });
  }
  return {
    users: users.map((user) => changed.get(user.id) ?? user),
    assignments: assignments.some((row) => row.id === demoAssignmentId)
      ? assignments
      : [
          ...assignments,
          {
            id: demoAssignmentId,
            companyId: demoId(1),
            salesStaffUserId: demoId(11),
            assignedByUserId: demoId(10),
            active: true,
            isPrimary: true,
            createdAt: now,
            endedAt: null,
          } satisfies SalesAssignment,
        ],
  };
}
