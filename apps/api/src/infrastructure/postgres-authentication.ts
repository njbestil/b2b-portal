import type { Pool } from "pg";
import type {
  AuthenticationRepository,
  LoginCredential,
} from "../repositories/authentication.js";
export function createPostgresAuthentication(
  pool: Pool,
): AuthenticationRepository {
  return {
    async findByEmail(email) {
      try {
        const { rows } = await pool.query<LoginCredential>(
          `SELECT u.id,u.company_id AS "companyId",u.display_name AS "displayName",u.role,u.status,
          c.status AS "companyStatus",u.password_hash AS "passwordHash",u.must_change_password AS "mustChangePassword"
          FROM users u LEFT JOIN companies c ON c.id=u.company_id WHERE lower(u.email)=$1 LIMIT 2`,
          [email],
        );
        if (rows.length > 1) throw new Error();
        return rows[0] ?? null;
      } catch {
        throw new Error("Credential storage unavailable.");
      }
    },
  };
}
