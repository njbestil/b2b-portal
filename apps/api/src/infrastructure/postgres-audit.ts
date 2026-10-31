import type { Pool } from "pg";
import type { AuditRepository } from "../repositories/audit.js";
import { AuditError, checkedAudit } from "../services/audit.js";

export function createPostgresAudit(
  pool: Pick<Pool, "query">,
): AuditRepository {
  return {
    async append(input) {
      const record = checkedAudit(input);
      try {
        await pool.query(
          "INSERT INTO audit_logs(id,company_id,actor_user_id,actor_role,action,target_type,target_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)",
          [
            record.id,
            record.companyId,
            record.actorUserId,
            record.actorRole,
            record.action,
            record.targetType,
            record.targetId,
            JSON.stringify(record.metadata),
            record.createdAt,
          ],
        );
        return checkedAudit(record);
      } catch {
        throw new AuditError("storage_failed");
      }
    },
  };
}
