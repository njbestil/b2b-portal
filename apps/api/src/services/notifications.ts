import type {
  NotificationInput,
  NotificationRecord,
  NotificationRepository,
} from "../repositories/notifications.js";

export class NotificationError extends Error {
  constructor(readonly code: "invalid_record" | "storage_failed") {
    super(`Notification operation failed: ${code}`);
    this.name = "NotificationError";
  }
}
const invalid = (): never => {
  throw new NotificationError("invalid_record");
};
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
  )
    return invalid();
  return value.toLowerCase();
}
function code(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_.]{0,63}$/.test(value)
    ? value
    : invalid();
}
function text(value: unknown, maximum: number): string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0)!;
      return (
        (point < 32 && point !== 9 && point !== 10) ||
        point === 127 ||
        (point >= 0xd800 && point <= 0xdfff)
      );
    })
    ? value
    : invalid();
}
/** Validate and detach before any queued I/O. Generated records are initially unread. */
export function checkedNotification(
  record: NotificationRecord,
): NotificationRecord {
  if (!record || typeof record !== "object" || Array.isArray(record))
    return invalid();
  const keys = [
    "id",
    "userId",
    "type",
    "title",
    "message",
    "targetType",
    "targetId",
    "createdAt",
    "readAt",
  ];
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    record.readAt !== null ||
    (record.targetType === null) !== (record.targetId === null) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    new Date(record.createdAt).toISOString() !== record.createdAt
  )
    return invalid();
  return {
    id: uuid(record.id),
    userId: uuid(record.userId),
    type: code(record.type),
    title: text(record.title, 200),
    message: text(record.message, 2000),
    targetType: record.targetType === null ? null : code(record.targetType),
    targetId: record.targetId === null ? null : uuid(record.targetId),
    createdAt: record.createdAt,
    readAt: null,
  };
}
export function createNotifications(
  repository: NotificationRepository,
  newId: () => string,
  now: () => Date = () => new Date(),
) {
  return {
    async create(input: NotificationInput) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) =>
            ![
              "userId",
              "type",
              "title",
              "message",
              "targetType",
              "targetId",
            ].includes(key),
        )
      )
        return invalid();
      const record = checkedNotification({
        ...input,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        id: newId(),
        createdAt: now().toISOString(),
        readAt: null,
      });
      return repository.append(record);
    },
  };
}
