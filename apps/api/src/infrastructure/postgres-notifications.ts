import type { Pool } from "pg";
import type { NotificationRepository } from "../repositories/notifications.js";
import {
  NotificationError,
  checkedNotification,
} from "../services/notifications.js";

export function createPostgresNotifications(
  pool: Pick<Pool, "query">,
): NotificationRepository {
  return {
    async append(input) {
      const record = checkedNotification(input);
      try {
        await pool.query(
          "INSERT INTO notifications(id,user_id,type,title,message,target_type,target_id,created_at,read_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            record.id,
            record.userId,
            record.type,
            record.title,
            record.message,
            record.targetType,
            record.targetId,
            record.createdAt,
            record.readAt,
          ],
        );
        return checkedNotification(record);
      } catch {
        throw new NotificationError("storage_failed");
      }
    },
  };
}
