import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const format = /^scrypt-v1\$([0-9a-f]{32})\$([0-9a-f]{64})$/;
const dummySalt = Buffer.alloc(16);
const dummyKey = Buffer.alloc(32);
// Bound memory and libuv work for the whole API process, without an unbounded queue.
let running = 0;
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (Buffer.byteLength(password, "utf8") > 1024 || running >= 2)
    throw new Error("Password operation unavailable.");
  running++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        32,
        { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
        (error, key) =>
          error
            ? reject(new Error("Password operation unavailable."))
            : resolve(key),
      );
    });
  } finally {
    running--;
  }
}
/** Backend provisioning primitive; never put plaintext passwords in seed data/logs. */
export async function hashPassword(password: string): Promise<string> {
  if (!password.length) throw new Error("Password operation unavailable.");
  const salt = randomBytes(16),
    key = await derive(password, salt);
  return `scrypt-v1$${salt.toString("hex")}$${key.toString("hex")}`;
}
export async function verifyPassword(
  password: string,
  hash: string | null,
): Promise<boolean> {
  const parts = typeof hash === "string" ? format.exec(hash) : null;
  const salt = parts ? Buffer.from(parts[1]!, "hex") : dummySalt;
  const expected = parts ? Buffer.from(parts[2]!, "hex") : dummyKey;
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected) && parts !== null;
}
