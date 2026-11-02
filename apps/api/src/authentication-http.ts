import { HttpError } from "./http.js";
import { SessionError } from "./services/session-state.js";
export function sessionHttpError(error: unknown): HttpError {
  if (error instanceof SessionError) {
    if (error.code === "invalid_proof")
      return new HttpError(
        401,
        "INVALID_SESSION",
        "Invalid or expired authentication.",
      );
    if (error.code === "restricted")
      return new HttpError(
        403,
        "PASSWORD_CHANGE_REQUIRED",
        "Change your password before continuing.",
      );
    if (error.code === "invalid_input")
      return new HttpError(
        400,
        "INVALID_SESSION_REQUEST",
        "Invalid authentication request.",
      );
  }
  return new HttpError(
    503,
    "AUTH_UNAVAILABLE",
    "Authentication is temporarily unavailable.",
  );
}
/** Use raw headers to reject duplicates instead of trusting Node's merged value. */
export function accessBearer(rawHeaders: readonly string[]): string {
  const values: string[] = [];
  for (let n = 0; n < rawHeaders.length; n += 2)
    if (rawHeaders[n]?.toLowerCase() === "authorization")
      values.push(rawHeaders[n + 1] ?? "");
  if (
    values.length !== 1 ||
    !/^Bearer [A-Za-z0-9_.-]{1,4096}$/i.test(values[0]!)
  )
    throw new SessionError("invalid_proof");
  return values[0]!.slice(7);
}
