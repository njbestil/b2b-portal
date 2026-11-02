import type { PoolClient } from "pg";
import type { LoginCredential } from "../repositories/authentication.js";
/** Caller holds common account locks and owns transaction commit. */
export async function publishPostgresCredential(
  client: PoolClient,
  user: LoginCredential,
  newHash: string,
  time: number,
) {
  if (
    !/^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(newHash) ||
    newHash === user.passwordHash
  )
    throw new Error("Invalid credential");
  await client.query(
    "UPDATE users SET password_hash=$1,must_change_password=false,updated_at=$2 WHERE id=$3",
    [newHash, new Date(time).toISOString(), user.id],
  );
  await client.query(
    "UPDATE user_sessions SET revoked_at=COALESCE(revoked_at,$1) WHERE user_id=$2",
    [new Date(time).toISOString(), user.id],
  );
}
