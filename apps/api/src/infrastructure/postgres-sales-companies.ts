import type { Pool } from "pg";
import type { CompanyProfile } from "../repositories/companies.js";
import type { SalesAssignmentRepository } from "../repositories/sales-assignments.js";
import type { LoginCredential } from "../repositories/authentication.js";
import {
  assignmentId,
  checkedSalesPage,
  SalesAssignmentError,
} from "../services/sales-assignments.js";
import { SessionError } from "../services/session-state.js";
import { salesListingActor } from "./sales-list-state.js";
type Row = CompanyProfile & {
  __userId: string | null;
  __companyId: string | null;
  __displayName: string;
  __role: LoginCredential["role"];
  __status: LoginCredential["status"];
  __passwordHash: string;
  __mustChangePassword: boolean;
  __sessionId: string | null;
  __refreshTokenHash: string | null;
  __credentialFingerprint: string | null;
  __sessionCreatedAt: Date | null;
  __sessionExpiresAt: Date | null;
  __revokedAt: Date | null;
  __invalid: boolean;
  __total: string;
};
const listingSql = `WITH authority AS MATERIALIZED (
  SELECT u.id AS "__userId",u.company_id AS "__companyId",u.display_name AS "__displayName",u.role AS "__role",u.status AS "__status",u.password_hash AS "__passwordHash",u.must_change_password AS "__mustChangePassword",
    s.id AS "__sessionId",s.refresh_token_hash AS "__refreshTokenHash",s.credential_fingerprint AS "__credentialFingerprint",s.created_at AS "__sessionCreatedAt",s.expires_at AS "__sessionExpiresAt",s.revoked_at AS "__revokedAt"
  FROM users u LEFT JOIN user_sessions s ON s.id=$2 AND s.user_id=u.id WHERE u.id=$1
), integrity AS MATERIALIZED (
  SELECT EXISTS(
    SELECT 1 FROM customer_sales_assignments WHERE active AND is_primary GROUP BY company_id HAVING count(*)>1
    UNION ALL SELECT 1 FROM customer_sales_assignments WHERE active GROUP BY company_id,sales_staff_user_id HAVING count(*)>1
    UNION ALL SELECT 1 FROM customer_sales_assignments WHERE active AND ended_at IS NOT NULL
  ) AS invalid
), matching AS MATERIALIZED (
  SELECT c.id,c.legal_name AS "legalName",c.trade_name AS "tradeName",c.status,c.erp_customer_reference AS "erpCustomerReference"
  FROM companies c JOIN customer_sales_assignments a ON a.company_id=c.id
  WHERE c.status='ACTIVE' AND a.sales_staff_user_id=$1 AND a.active AND a.is_primary AND a.ended_at IS NULL AND a.created_at<=$3::timestamptz
    AND EXISTS(SELECT 1 FROM authority WHERE "__role"='SALES_STAFF' AND "__status"='ACTIVE' AND "__companyId" IS NULL AND "__mustChangePassword"=false)
)
SELECT authority.*,integrity.invalid AS "__invalid",tot.total AS "__total",p.*
FROM (SELECT count(*)::text AS total FROM matching) tot CROSS JOIN integrity
LEFT JOIN authority ON true
LEFT JOIN LATERAL(SELECT * FROM matching ORDER BY id LIMIT $4 OFFSET $5) p ON true
ORDER BY p.id`;
export function createPostgresSalesCompanies(
  pool: Pick<Pool, "query">,
  now = Date.now,
): SalesAssignmentRepository["listAssigned"] {
  return async (actor, input) => {
    const page = checkedSalesPage(input),
      staff = assignmentId(actor.userId),
      sessionId = assignmentId(actor.sessionId);
    try {
      const rows = (
        await pool.query<Row>(listingSql, [
          staff,
          sessionId,
          new Date(now()).toISOString(),
          page.limit,
          page.offset,
        ])
      ).rows;
      const row = rows[0];
      if (!row) throw new Error();
      const account = row.__userId
        ? {
            id: row.__userId,
            companyId: row.__companyId,
            displayName: row.__displayName,
            role: row.__role,
            status: row.__status,
            passwordHash: row.__passwordHash,
            mustChangePassword: row.__mustChangePassword,
            companyStatus: null,
          }
        : null;
      const session = row.__sessionId
        ? {
            id: row.__sessionId,
            userId: staff,
            refreshTokenHash: row.__refreshTokenHash!,
            credentialFingerprint: row.__credentialFingerprint,
            createdAt: row.__sessionCreatedAt!.toISOString(),
            expiresAt: row.__sessionExpiresAt!.toISOString(),
            revokedAt: row.__revokedAt?.toISOString() ?? null,
          }
        : null;
      salesListingActor(
        { ...actor, userId: staff, sessionId },
        account,
        session,
        now(),
      );
      const total = Number(row.__total);
      if (row.__invalid || !Number.isSafeInteger(total) || total < 0)
        throw new Error();
      return {
        total,
        items: rows
          .filter((r) => r.id !== null)
          .map(
            ({ id, legalName, tradeName, status, erpCustomerReference }) => ({
              id,
              legalName,
              tradeName,
              status,
              erpCustomerReference,
            }),
          ),
      };
    } catch (e) {
      if (
        e instanceof SessionError ||
        (e instanceof SalesAssignmentError && e.code === "forbidden")
      )
        throw e;
      throw new SalesAssignmentError("unavailable");
    }
  };
}
