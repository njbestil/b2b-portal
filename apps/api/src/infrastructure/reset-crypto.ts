import { randomBytes, randomUUID, createHash } from "node:crypto";
export const resetProofs = {
  newId: randomUUID,
  token: (id: string) =>
    "p1." + id + "." + randomBytes(32).toString("base64url"),
  digest: (token: string) => createHash("sha256").update(token).digest("hex"),
};
