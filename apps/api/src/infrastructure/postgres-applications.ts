import type { Pool } from "pg";
import type { ApplicationRepository } from "../repositories/applications.js";
import {
  ApplicationError,
  checkedApplication,
  checkedPending,
  applicationId,
  licenseKey,
} from "../services/applications.js";

export function createPostgresApplications(
  pool: Pick<Pool, "connect">,
): ApplicationRepository {
  return {
    async submit(input) {
      const r = checkedApplication(input);
      const client = await pool.connect().catch(() => {
        throw new ApplicationError("unavailable");
      });
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(1937825,36)");
        const duplicate = await client.query<{
          id: string | null;
          trade_license_reference: string | null;
          administrator_email: string | null;
        }>(
          "SELECT c.id,c.trade_license_reference,NULL::text AS administrator_email FROM companies c UNION ALL SELECT u.company_id,NULL,u.email FROM users u",
        );
        const found = duplicate.rows.find(
          (x) =>
            (x.trade_license_reference !== null &&
              licenseKey(x.trade_license_reference) ===
                r.tradeLicenseReference) ||
            (x.administrator_email !== null &&
              x.administrator_email.trim().toLowerCase() ===
                r.administratorEmail),
        );
        if (found) {
          await client.query("COMMIT");
          return { companyId: found.id };
        }
        await client.query(
          "INSERT INTO companies(id,legal_name,trade_name,status,contact_name,contact_email,contact_phone,trade_license_reference,billing_address,created_at,updated_at) VALUES($1,$2,$2,'PENDING',$3,$4,$5,$6,$7::jsonb,$8,$8)",
          [
            r.companyId,
            r.companyName,
            r.administratorName,
            r.businessEmail,
            r.phone,
            r.tradeLicenseReference,
            JSON.stringify({ line1: r.billingAddress }),
            r.createdAt,
          ],
        );
        await client.query(
          "INSERT INTO users(id,company_id,email,password_hash,display_name,mobile,role,status,must_change_password,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'CUSTOMER_ADMIN','PENDING',true,$7,$7)",
          [
            r.administratorUserId,
            r.companyId,
            r.administratorEmail,
            r.passwordHash,
            r.administratorName,
            r.administratorMobile,
            r.createdAt,
          ],
        );
        await client.query(
          "INSERT INTO delivery_addresses(id,company_id,label,address,active,is_default,created_at,updated_at) VALUES($1,$2,'Main delivery',$3::jsonb,true,true,$4,$4)",
          [
            r.deliveryAddressId,
            r.companyId,
            JSON.stringify({ line1: r.deliveryAddress }),
            r.createdAt,
          ],
        );
        await client.query(
          "UPDATE companies SET initial_admin_user_id=$2,initial_delivery_address_id=$3 WHERE id=$1",
          [r.companyId, r.administratorUserId, r.deliveryAddressId],
        );
        await client.query("COMMIT");
        return { companyId: r.companyId };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        // An account writer may race outside the intake lock. Do not convert
        // unrelated constraints or ID collisions into a successful receipt.
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23505" &&
          "constraint" in error &&
          error.constraint === "users_email_unique_idx"
        ) {
          return { companyId: null };
        }
        throw new ApplicationError("unavailable");
      } finally {
        client.release();
      }
    },
    async pending(input) {
      const id = applicationId(input),
        client = await pool.connect().catch(() => {
          throw new ApplicationError("unavailable");
        });
      try {
        const result = await client.query(
          `SELECT c.id AS "companyId",c.created_at AS "createdAt",u.id AS "administratorUserId",d.id AS "deliveryAddressId",
          c.legal_name AS "companyName",c.trade_license_reference AS "tradeLicenseReference",
          c.contact_email AS "businessEmail",c.contact_phone AS phone,c.billing_address->>'line1' AS "billingAddress",
          d.address->>'line1' AS "deliveryAddress",u.display_name AS "administratorName",u.email AS "administratorEmail",u.mobile AS "administratorMobile"
          FROM companies c JOIN users u ON u.id=c.initial_admin_user_id AND u.company_id=c.id
          JOIN delivery_addresses d ON d.id=c.initial_delivery_address_id AND d.company_id=c.id AND d.active AND d.is_default
          WHERE c.id=$1 AND c.status='PENDING' AND u.status='PENDING' AND u.role='CUSTOMER_ADMIN' AND u.must_change_password=true`,
          [id],
        );
        const row = result.rows[0];
        return row
          ? checkedPending({ ...row, createdAt: row.createdAt.toISOString() })
          : null;
      } catch {
        throw new ApplicationError("unavailable");
      } finally {
        client.release();
      }
    },
  };
}
