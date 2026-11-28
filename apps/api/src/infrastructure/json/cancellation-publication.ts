import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FileIo } from "./session-file.js";
import { parseCollection } from "./schema.js";
import { checkedAudit } from "../../services/audit.js";
import { checkedCancellationLedger } from "./cancellation-ledger.js";
export const cancellationIntentFile = "cancellation_publication_intent.json";
export const cancellationFiles = [
  "orders.json",
  "audit_logs.json",
  "order_cancellations.json",
] as const;
type Name = (typeof cancellationFiles)[number];
type Change = { name: Name; before: string | null; after: string };
type Intent = { schemaVersion: 1; files: Change[] };
const limit = 10 * 1024 * 1024;
export async function cancellationFile(
  root: string,
  name: string,
  io: FileIo = fs,
): Promise<string | null> {
  const path = join(root, name);
  try {
    const stat = await io.lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > (name === cancellationIntentFile ? 65 * 1024 * 1024 : limit)
    )
      throw Error("Publication unavailable.");
    const bytes = await io.readFile(path);
    if (
      bytes.byteLength >
      (name === cancellationIntentFile ? 65 * 1024 * 1024 : limit)
    )
      throw Error("Publication unavailable.");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
    throw e;
  }
}
function validate(name: Name, text: string | null) {
  if (text === null) {
    if (name === "orders.json") throw Error("Orders missing.");
    return;
  }
  if (Buffer.byteLength(text) > limit) throw Error("Publication too large.");
  const raw: unknown = JSON.parse(text);
  const parsed =
    name === "orders.json"
      ? parseCollection("orders", raw)
      : name === "order_cancellations.json"
        ? checkedCancellationLedger(raw)
        : Array.isArray(raw)
          ? raw.map(checkedAudit)
          : null;
  if (!isDeepStrictEqual(parsed, raw))
    throw Error("Unsupported private publication data.");
  if (
    name === "audit_logs.json" &&
    Array.isArray(parsed) &&
    new Set(parsed.map((r) => r.id)).size !== parsed.length
  )
    throw Error("Duplicate audit.");
}
async function atomic(root: string, name: string, text: string, io: FileIo) {
  const tmp = join(root, ".cancellation." + randomUUID() + ".tmp");
  try {
    const h = await io.open(tmp, "wx", 0o600);
    try {
      await h.writeFile(text, "utf8");
      await h.sync();
    } finally {
      await h.close();
    }
    await io.rename(tmp, join(root, name));
  } finally {
    await io.unlink(tmp).catch(() => {});
  }
}
function intent(input: unknown): Intent {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("Invalid publication.");
  const r = input as Intent;
  if (
    Object.keys(r).sort().join(",") !== "files,schemaVersion" ||
    r.schemaVersion !== 1 ||
    !Array.isArray(r.files) ||
    r.files.length !== 3
  )
    throw Error("Invalid publication.");
  for (const [i, f] of r.files.entries()) {
    if (
      !f ||
      Object.keys(f).sort().join(",") !== "after,before,name" ||
      f.name !== cancellationFiles[i] ||
      !(f.before === null || typeof f.before === "string") ||
      typeof f.after !== "string"
    )
      throw Error("Invalid publication.");
    validate(f.name, f.before);
    validate(f.name, f.after);
  }
  // Every retained cancellation has matching required audit in the same publication.
  const rows = checkedCancellationLedger(JSON.parse(r.files[2]!.after)),
    audits = JSON.parse(r.files[1]!.after);
  const previous = checkedCancellationLedger(
      JSON.parse(r.files[2]!.before ?? "[]"),
    ),
    previousAudit: unknown[] = JSON.parse(r.files[1]!.before ?? "[]");
  if (
    rows.length < previous.length ||
    rows.length > previous.length + 1 ||
    audits.length < previousAudit.length ||
    !isDeepStrictEqual(audits.slice(0, previousAudit.length), previousAudit)
  )
    throw Error("Publication would discard retained history.");
  for (const [i, old] of previous.entries()) {
    const next = rows[i]!;
    for (const key of [
      "id",
      "companyId",
      "orderId",
      "userId",
      "keyHash",
      "reasonHash",
      "reason",
      "createdAt",
    ] as const)
      if (old[key] !== next[key]) throw Error("Cancellation identity changed.");
    if (!isDeepStrictEqual(next.audit.slice(0, old.audit.length), old.audit))
      throw Error("Cancellation audit changed.");
    if (old.status !== "PENDING" && !isDeepStrictEqual(old, next))
      throw Error("Terminal cancellation changed.");
    if (old.attempt) {
      if (
        !next.attempt ||
        old.attempt.id !== next.attempt.id ||
        old.attempt.expectedStatus !== next.attempt.expectedStatus ||
        !isDeepStrictEqual(old.attempt.payload, next.attempt.payload)
      )
        throw Error("ERP correlation changed.");
      const allowed = {
        PENDING: ["PENDING", "PROCESSING"],
        PROCESSING: ["PROCESSING", "SUCCESS", "FAILED"],
        SUCCESS: ["SUCCESS"],
        FAILED: ["FAILED"],
      };
      if (!allowed[old.attempt.status].includes(next.attempt.status))
        throw Error("ERP claim regressed.");
    }
  }
  const oldOrders = parseCollection("orders", JSON.parse(r.files[0]!.before!)),
    newOrders = parseCollection("orders", JSON.parse(r.files[0]!.after));
  if (newOrders.length !== oldOrders.length)
    throw Error("Order collection changed.");
  for (const [i, old] of oldOrders.entries()) {
    const next = newOrders[i]!;
    if (!isDeepStrictEqual(old, next)) {
      if (
        next.status !== "CANCELLED" ||
        ["DELIVERED", "CANCELLED", "REJECTED"].includes(old.status) ||
        !rows.some(
          (e) =>
            e.orderId === old.id &&
            e.companyId === old.companyId &&
            e.status === "APPROVED",
        ) ||
        !isDeepStrictEqual(
          { ...old, status: next.status, updatedAt: next.updatedAt },
          { ...next, updatedAt: next.updatedAt },
        )
      )
        throw Error("Unexpected order publication.");
    }
  }
  for (const row of rows)
    for (const a of row.audit)
      if (!audits.some((e: unknown) => isDeepStrictEqual(a, e)))
        throw Error("Missing required cancellation audit.");
  return r;
}
/** Call only while holding the directory's shared coordinator. Recovery performs
 * local file publication only, never authorization decisions or external I/O. */
export async function recoverCancellationPublication(
  root: string,
  io: FileIo = fs,
  afterPublish: (stage: string) => Promise<void> = async () => {},
) {
  const text = await cancellationFile(root, cancellationIntentFile, io);
  if (text === null) return;
  const plan = intent(JSON.parse(text));
  // Validate every current file before changing any: never overwrite offline drift.
  const current = await Promise.all(
    plan.files.map((f) => cancellationFile(root, f.name, io)),
  );
  for (const [i, f] of plan.files.entries())
    if (current[i] !== f.before && current[i] !== f.after)
      throw Error("Publication conflicts with current files.");
  for (const [i, f] of plan.files.entries()) {
    if (current[i] !== f.after) await atomic(root, f.name, f.after, io);
    await afterPublish(f.name);
  }
  await io.unlink(join(root, cancellationIntentFile));
  await afterPublish("complete");
}
export async function publishCancellation(
  root: string,
  before: Readonly<Record<Name, string | null>>,
  after: Readonly<Record<Name, string>>,
  io: FileIo = fs,
  afterPublish: (stage: string) => Promise<void> = async () => {},
) {
  if ((await cancellationFile(root, cancellationIntentFile, io)) !== null)
    throw Error("Pending publication.");
  const plan = intent({
    schemaVersion: 1,
    files: cancellationFiles.map((name) => ({
      name,
      before: before[name],
      after: after[name],
    })),
  });
  for (const f of plan.files)
    if ((await cancellationFile(root, f.name, io)) !== f.before)
      throw Error("Publication changed.");
  const encoded = JSON.stringify(plan) + "\n";
  if (Buffer.byteLength(encoded) > 65 * 1024 * 1024)
    throw Error("Publication intent too large.");
  await atomic(root, cancellationIntentFile, encoded, io);
  await afterPublish("intent");
  await recoverCancellationPublication(root, io, afterPublish);
}
