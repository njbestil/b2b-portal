/** Trusted backend content and recipient; never an HTTP body or authorization proof. */
export interface NotificationInput {
  readonly userId: string;
  readonly type: string;
  readonly title: string;
  readonly message: string;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
}
export interface NotificationRecord extends NotificationInput {
  readonly id: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly createdAt: string;
  readonly readAt: null;
}
/** Creation only. No public read, marking read, or recipient authorization. */
export interface NotificationRepository {
  append(record: NotificationRecord): Promise<NotificationRecord>;
}
