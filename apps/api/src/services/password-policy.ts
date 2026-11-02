export function validNewPassword(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).byteLength <= 1024 &&
    Array.from(value).length >= 8 &&
    /\p{Lu}/u.test(value) &&
    /\p{N}/u.test(value) &&
    /[\p{P}\p{S}]/u.test(value)
  );
}
