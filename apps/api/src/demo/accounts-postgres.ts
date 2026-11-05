import type { Client } from "pg";
import {
  accountPlan,
  demoMarker,
  DemoAccountsError,
  demoTarget,
  ownedAccounts,
} from "./accounts.js";
import type { JsonUser, JsonCompany } from "../infrastructure/json/models.js";
async function inspect(client: Pick<Client, "query">, target: string) {
  const {
    rows: [state],
  } = await client.query(
    "SELECT current_database() AS name, obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname='public'",
  );
  if (
    !demoTarget(target) ||
    state?.name !== target ||
    state?.marker !== demoMarker
  )
    throw new DemoAccountsError();
  const { rows: users } = await client.query<JsonUser>(
    'SELECT id,company_id AS "companyId",email,password_hash AS "passwordHash",must_change_password AS "mustChangePassword",display_name AS "displayName",role,status FROM users LIMIT 10001',
  );
  const { rows: companies } = await client.query<JsonCompany>(
    'SELECT id,status,erp_customer_reference AS "erpCustomerReference" FROM companies LIMIT 10001',
  );
  const { rows: assignments } = await client.query(
    'SELECT id,company_id AS "companyId",sales_staff_user_id AS "salesStaffUserId",is_primary AS "isPrimary",active,assigned_by_user_id AS "assignedByUserId",created_at AS "createdAt",ended_at AS "endedAt" FROM customer_sales_assignments LIMIT 10001',
  );
  const normalized = assignments.map((row) => ({
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    endedAt: row.endedAt === null ? null : new Date(row.endedAt).toISOString(),
  }));
  ownedAccounts(users, companies, normalized);
  return { users, companies, assignments: normalized };
}
export async function inspectPostgresDemo(
  client: Pick<Client, "query">,
  target: string,
) {
  await inspect(client, target);
}
export async function provisionPostgresAccounts(
  client: Pick<Client, "query">,
  target: string,
  selection: unknown,
  secrets: Readonly<Record<string, string | undefined>>,
  offline: boolean,
) {
  if (offline !== true || !demoTarget(target)) throw new DemoAccountsError();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SET LOCAL search_path TO public,pg_catalog");
    await client.query("SELECT pg_advisory_xact_lock(1937825,13)");
    await client.query(
      "LOCK TABLE users,companies,customer_sales_assignments IN EXCLUSIVE MODE",
    );
    const current = await inspect(client, target);
    const plan = await accountPlan(
      current.users,
      current.companies,
      current.assignments,
      selection,
      secrets,
    );
    for (const user of plan.users) {
      const prior = current.users.find((row) => row.id === user.id)!;
      if (
        prior.email === user.email &&
        prior.passwordHash === user.passwordHash &&
        prior.mustChangePassword === user.mustChangePassword
      )
        continue;
      await client.query(
        "UPDATE users SET email=$1,password_hash=$2,must_change_password=$3,updated_at=CURRENT_TIMESTAMP WHERE id=$4",
        [user.email, user.passwordHash, user.mustChangePassword, user.id],
      );
    }
    if (plan.assignments.length !== current.assignments.length) {
      const row = plan.assignments[plan.assignments.length - 1]!;
      await client.query(
        "INSERT INTO customer_sales_assignments(id,company_id,sales_staff_user_id,assigned_by_user_id,is_primary,active,created_at) VALUES($1,$2,$3,$4,true,true,$5)",
        [
          row.id,
          row.companyId,
          row.salesStaffUserId,
          row.assignedByUserId,
          row.createdAt,
        ],
      );
    }
    await client.query("COMMIT");
    began = false;
  } catch {
    if (began) await client.query("ROLLBACK").catch(() => {});
    throw new DemoAccountsError();
  }
}
