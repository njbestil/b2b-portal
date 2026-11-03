import type { Pool, PoolClient } from "pg";
import type {
  CompanyProfileActor,
  CompanyProfileRepository,
} from "../repositories/company-profiles.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { AccountStatus } from "../repositories/common.js";
import { CompanyProfileError } from "../services/company-profiles.js";
import { SessionError } from "../services/session-state.js";
import { checkedAssignments } from "../services/sales-assignments.js";
import { lockedSession } from "./postgres-sessions.js";
import { canonicalCompany, profileActor } from "./company-profile-state.js";
const projection =
  'id,legal_name AS "legalName",trade_name AS "tradeName",status,contact_name AS "primaryContact",contact_email AS "businessEmail",contact_phone AS phone,billing_address AS "billingAddress",trade_license_reference AS "tradeLicenseReference",erp_customer_reference AS "erpCustomerReference",payment_terms AS "paymentTerms",credit_status AS "creditStatus"';
interface CompanyRow {
  id: string;
  legalName: string;
  tradeName: string;
  status: AccountStatus;
  primaryContact: string | null;
  businessEmail: string | null;
  phone: string | null;
  billingAddress: { line1?: string } | null;
  tradeLicenseReference: string | null;
  erpCustomerReference: string | null;
  paymentTerms: string | null;
  creditStatus: string | null;
}
function view(row: CompanyRow) {
  return canonicalCompany({
    id: row.id,
    legalName: row.legalName,
    status: row.status,
    tradeLicenseReference: row.tradeLicenseReference,
    portal: {
      tradeName: row.tradeName,
      primaryContact: row.primaryContact,
      businessEmail: row.businessEmail,
      phone: row.phone,
      billingAddress: row.billingAddress?.line1 ?? null,
    },
    commercial: {
      erpCustomerReference: row.erpCustomerReference,
      paymentTerms: row.paymentTerms,
      creditStatus: row.creditStatus,
    },
  });
}
export function createPostgresCompanyProfiles(
  pool: Pool,
  now = Date.now,
): CompanyProfileRepository {
  async function run<T>(
    actor: CompanyProfileActor,
    companyId: string,
    write: boolean,
    work: (client: PoolClient, row: CompanyRow) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      throw new CompanyProfileError("unavailable");
    }
    let broken = false;
    const onError = () => {
      broken = true;
    };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      const company = (
        await client.query<CompanyRow>(
          `SELECT ${projection} FROM companies WHERE id=$1 FOR UPDATE`,
          [companyId],
        )
      ).rows[0];
      const user = (
          await client.query<LoginCredential>(
            'SELECT id,company_id AS "companyId",display_name AS "displayName",role,status,password_hash AS "passwordHash",must_change_password AS "mustChangePassword" FROM users WHERE id=$1 FOR UPDATE',
            [actor.userId],
          )
        ).rows[0],
        account = user
          ? {
              ...user,
              companyStatus:
                user.companyId === companyId ? (company?.status ?? null) : null,
            }
          : null;
      const session = await lockedSession(client, actor.sessionId);
      let assigned = false;
      if (actor.role === "SALES_STAFF") {
        const rows = (
          await client.query(
            'SELECT id,company_id AS "companyId",sales_staff_user_id AS "salesStaffUserId",assigned_by_user_id AS "assignedByUserId",is_primary AS "isPrimary",active,created_at AS "createdAt",ended_at AS "endedAt" FROM customer_sales_assignments WHERE company_id=$1 FOR SHARE',
            [companyId],
          )
        ).rows;
        assigned = checkedAssignments(
          rows.map((r) => ({
            ...r,
            createdAt: r.createdAt.toISOString(),
            endedAt: r.endedAt?.toISOString() ?? null,
          })),
        ).some(
          (r) =>
            r.salesStaffUserId === actor.userId &&
            r.active &&
            r.isPrimary &&
            r.endedAt === null &&
            Date.parse(r.createdAt) <= now(),
        );
      }
      const check = () =>
        profileActor(
          actor,
          account,
          session,
          companyId,
          company?.status ?? null,
          assigned,
          write,
          now(),
        );
      check();
      if (!company) throw new CompanyProfileError("not_found");
      const result = await work(client, company);
      check();
      if (broken) throw new CompanyProfileError("unavailable");
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      if (e instanceof CompanyProfileError || e instanceof SessionError)
        throw e;
      throw new CompanyProfileError("unavailable");
    } finally {
      client.off("error", onError);
      client.release(broken);
    }
  }
  return {
    read: (actor, companyId) =>
      run(actor, companyId, false, async (_client, row) => view(row)),
    save: (actor, companyId, version, fields) =>
      run(actor, companyId, true, async (client, row) => {
        if (view(row).version !== version)
          throw new CompanyProfileError("conflict");
        const updated = (
          await client.query<CompanyRow>(
            `UPDATE companies SET trade_name=$1,contact_name=$2,contact_email=$3,contact_phone=$4,billing_address=$5::jsonb,updated_at=$6 WHERE id=$7 RETURNING ${projection}`,
            [
              fields.tradeName,
              fields.primaryContact,
              fields.businessEmail,
              fields.phone,
              fields.billingAddress === null
                ? null
                : JSON.stringify({
                    ...row.billingAddress,
                    line1: fields.billingAddress,
                  }),
              new Date(now()).toISOString(),
              companyId,
            ],
          )
        ).rows[0];
        if (!updated) throw new CompanyProfileError("unavailable");
        return view(updated);
      }),
  };
}
