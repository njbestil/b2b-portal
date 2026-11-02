import { EnvironmentConfigurationError } from "@b2b-portal/config/server";
export interface SessionConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Uint8Array>;
  readonly accessSeconds: number;
  readonly refreshSeconds: number;
}
/** Absent configuration disables session issuance (503), never invents a key.
 * Partially supplied or invalid configuration fails startup with names only. */
export function parseSessionConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): SessionConfiguration | undefined {
  const names = [
    "AUTH_JWT_ISSUER",
    "AUTH_JWT_AUDIENCE",
    "AUTH_JWT_ACTIVE_KID",
    "AUTH_JWT_KEYS",
    "AUTH_ACCESS_TTL_SECONDS",
    "AUTH_REFRESH_TTL_SECONDS",
  ];
  if (names.every((name) => env[name] === undefined)) return undefined;
  const problems: string[] = [];
  const text = (name: string) => {
    const value = env[name] ?? "";
    if (
      !value ||
      value.length > 200 ||
      value !== value.trim() ||
      [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      problems.push(name + " must be bounded nonempty text");
    return value;
  };
  const issuer = text("AUTH_JWT_ISSUER"),
    audience = text("AUTH_JWT_AUDIENCE"),
    activeKeyId = text("AUTH_JWT_ACTIVE_KID");
  const keys = new Map<string, Uint8Array>();
  try {
    const raw: unknown = JSON.parse(env.AUTH_JWT_KEYS ?? "");
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).length > 5
    )
      throw new Error();
    for (const [id, value] of Object.entries(raw)) {
      if (
        !/^[A-Za-z0-9_-]{1,32}$/.test(id) ||
        typeof value !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(value)
      )
        throw new Error();
      const bytes = Buffer.from(value, "base64url");
      if (
        bytes.length < 32 ||
        bytes.length > 64 ||
        bytes.toString("base64url") !== value
      )
        throw new Error();
      keys.set(id, bytes);
    }
    if (!keys.has(activeKeyId)) throw new Error();
  } catch {
    problems.push(
      "AUTH_JWT_KEYS must map at most five local key IDs to canonical base64url keys of 32–64 bytes, including AUTH_JWT_ACTIVE_KID",
    );
  }
  const seconds = (name: string, fallback: number) => {
    const value = env[name] ?? String(fallback),
      number = Number(value);
    if (
      !/^\d+$/.test(value) ||
      !Number.isInteger(number) ||
      number < 1 ||
      number > fallback
    )
      problems.push(name + " must be an integer between 1 and " + fallback);
    return number;
  };
  const accessSeconds = seconds("AUTH_ACCESS_TTL_SECONDS", 900),
    refreshSeconds = seconds("AUTH_REFRESH_TTL_SECONDS", 604800);
  if (problems.length) throw new EnvironmentConfigurationError(problems);
  return { issuer, audience, activeKeyId, keys, accessSeconds, refreshSeconds };
}
