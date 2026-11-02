import type { LoginCredential } from "../../repositories/authentication.js";
import type { JsonSecurityCoordinator } from "./security.js";
export async function readJsonSecurityAccount(
  security: JsonSecurityCoordinator,
  userId: string,
): Promise<LoginCredential | null> {
  const user = (await security.store.read("users")).find(
    (row) => row.id === userId,
  );
  if (
    !user ||
    user.passwordHash === undefined ||
    user.mustChangePassword === undefined
  )
    return null;
  const company =
    user.companyId === null
      ? null
      : (await security.store.read("companies")).find(
          (row) => row.id === user.companyId,
        );
  return {
    ...user,
    companyStatus: company?.status ?? null,
    passwordHash: user.passwordHash,
    mustChangePassword: user.mustChangePassword,
  };
}
