import type { AuthenticationRepository } from "../../repositories/authentication.js";
import type { JsonFileStore } from "./store.js";
export function createJsonAuthentication(
  store: JsonFileStore,
): AuthenticationRepository {
  return {
    async findByEmail(email) {
      try {
        const matches = (await store.read("users")).filter(
          (user) => user.email === email,
        );
        if (matches.length > 1) throw new Error();
        const user = matches[0];
        if (
          !user ||
          user.passwordHash === undefined ||
          user.mustChangePassword === undefined
        )
          return null;
        const company =
          user.companyId === null
            ? null
            : (await store.read("companies")).find(
                (c) => c.id === user.companyId,
              );
        return {
          id: user.id,
          companyId: user.companyId,
          displayName: user.displayName,
          role: user.role,
          status: user.status,
          companyStatus: company?.status ?? null,
          passwordHash: user.passwordHash,
          mustChangePassword: user.mustChangePassword,
        };
      } catch {
        throw new Error("Credential storage unavailable.");
      }
    },
  };
}
