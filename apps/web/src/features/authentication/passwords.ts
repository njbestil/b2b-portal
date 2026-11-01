import { AuthError } from "./session";

export interface PasswordFlows {
  changeInitialPassword(
    currentPassword: string,
    newPassword: string,
    signal?: AbortSignal,
  ): Promise<void>;
  requestRecovery(email: string, signal?: AbortSignal): Promise<void>;
  redeemRecovery(
    proof: string,
    newPassword: string,
    signal?: AbortSignal,
  ): Promise<void>;
}
/** Normalized UI producer port, not a claim about unmerged HTTP DTOs/routes. */
export interface PasswordProducer {
  changeInitialPassword(
    input: { currentPassword: string; newPassword: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
  requestRecovery(
    input: { email: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
  redeemRecovery(
    input: { token: string; newPassword: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
}
/** Reconcile this Figma validation with final server bounds at producer integration. */
export function replacementPasswordError(value: string): string | undefined {
  if (
    new TextEncoder().encode(value).length > 1024 ||
    Array.from(value).some((c) => {
      const n = c.codePointAt(0)!;
      return n >= 0xd800 && n <= 0xdfff;
    })
  )
    return "Choose a shorter password.";
  if (
    value.length < 8 ||
    !/[A-Z]/.test(value) ||
    !/[0-9]/.test(value) ||
    !/[^A-Za-z0-9\s]/.test(value)
  )
    return "Use 8+ characters with an uppercase letter, number and symbol.";
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
/** Wire confirmed producers here; no configured producer means honest unavailable. */
export function createPasswordFlows(
  producer?: PasswordProducer,
): PasswordFlows {
  async function outcome(
    run: () => Promise<unknown>,
    kind: "received" | "password-changed",
    signal?: AbortSignal,
  ) {
    if (!producer) throw new AuthError("unavailable");
    try {
      if (signal?.aborted) throw new AuthError("unavailable");
      const result = await run();
      if (
        signal?.aborted ||
        !record(result) ||
        result.kind !== kind ||
        (kind === "password-changed" && result.requiresLogin !== true)
      )
        throw new AuthError("unavailable");
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError("unavailable");
    }
  }
  function newPassword(value: string) {
    if (replacementPasswordError(value)) throw new AuthError("invalid");
  }
  return {
    async changeInitialPassword(currentPassword, replacement, signal) {
      if (
        !currentPassword.length ||
        new TextEncoder().encode(currentPassword).length > 1024
      )
        throw new AuthError("invalid");
      newPassword(replacement);
      await outcome(
        () =>
          producer!.changeInitialPassword(
            { currentPassword, newPassword: replacement },
            signal,
          ),
        "password-changed",
        signal,
      );
    },
    async requestRecovery(email, signal) {
      if (
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
      )
        throw new AuthError("invalid");
      await outcome(
        () => producer!.requestRecovery({ email: email.trim() }, signal),
        "received",
        signal,
      );
    },
    async redeemRecovery(token, replacement, signal) {
      if (!token.length || token.length > 1024) throw new AuthError("invalid");
      newPassword(replacement);
      await outcome(
        () =>
          producer!.redeemRecovery({ token, newPassword: replacement }, signal),
        "password-changed",
        signal,
      );
    },
  };
}
