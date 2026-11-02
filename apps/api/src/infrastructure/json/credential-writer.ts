import type { LoginCredential } from "../../repositories/authentication.js";
import type { JsonSecurityCoordinator } from "./security.js";
import type { JsonUser } from "./models.js";
import type { createJsonSessionFile } from "./session-file.js";
import { SessionError } from "../../services/session-state.js";
/** Caller holds the shared security coordinator. Publish credential before any
 * cleanup; old session/reset fingerprints deny even after interruption. */
export async function publishJsonCredential(
  security: JsonSecurityCoordinator,
  user: LoginCredential,
  newHash: string,
  time: number,
  sessions: ReturnType<typeof createJsonSessionFile>,
  writeUsers: (rows: readonly JsonUser[]) => Promise<void> = (rows) =>
    security.store.replace("users", rows),
) {
  if (
    !/^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(newHash) ||
    newHash === user.passwordHash
  )
    throw new Error("Invalid credential");
  const users = await security.store.read("users"),
    index = users.findIndex((row) => row.id === user.id);
  if (index < 0 || users[index]!.passwordHash !== user.passwordHash)
    throw new SessionError("invalid_proof");
  const rows = await sessions.read();
  users[index] = {
    ...users[index]!,
    passwordHash: newHash,
    mustChangePassword: false,
  };
  await writeUsers(users);
  await sessions.publish(
    rows.map((row) =>
      row.userId === user.id && row.revokedAt === null
        ? { ...row, revokedAt: new Date(time).toISOString() }
        : row,
    ),
  );
}
