import { randomUUID } from "node:crypto";
import { lstat, readFile, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ApplicationDecision,
  ApplicationReviewRepository,
  ReviewActor,
} from "../../repositories/application-reviews.js";
import { checkedPending } from "../../services/applications.js";
import { ReviewError } from "../../services/application-decisions.js";
import { SessionError } from "../../services/session-state.js";
import {
  checkedDecision,
  pendingReview,
  newDecision,
  replay,
  reviewActor,
} from "../application-review-state.js";
import type { JsonSecurityCoordinator } from "./security.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { createJsonSessionFile } from "./session-file.js";

export function createJsonApplicationReviews(
  security: JsonSecurityCoordinator,
  now = Date.now,
  afterPublish: (stage: string) => Promise<void> = async () => {},
) {
  const root = security.directory,
    file = "application_reviews.json",
    intent = "application_review_intent.json",
    sessions = createJsonSessionFile(root);
  async function read(name: string): Promise<unknown | null> {
    const path = join(root, name);
    try {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 10 * 1024 * 1024
      )
        throw new ReviewError("unavailable");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)),
    );
  }
  async function publish(name: string, value: unknown, stage: string) {
    const temporary = join(root, `.application-review.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, join(root, name));
      await afterPublish(stage);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async function decisions() {
    const value = await read(file);
    if (value === null) return [];
    if (!Array.isArray(value)) throw new ReviewError("unavailable");
    const rows = value.map(checkedDecision);
    if (new Set(rows.map((r) => r.application.companyId)).size !== rows.length)
      throw new ReviewError("unavailable");
    return rows;
  }
  async function apply(record: ApplicationDecision) {
    const rows = await decisions(),
      companies = await security.store.read("companies"),
      users = await security.store.read("users"),
      a = record.application;
    const existing = rows.find((r) => r.application.companyId === a.companyId);
    if (existing && !isDeepStrictEqual(existing, record))
      throw new ReviewError("unavailable");
    const c = companies.find((c) => c.id === a.companyId),
      u = users.find(
        (u) => u.id === a.administratorUserId && u.companyId === a.companyId,
      ),
      status = a.status === "APPROVED" ? "ACTIVE" : "REJECTED";
    if (
      !c?.application ||
      pendingReview(c.application).version !== record.originalVersion ||
      !["PENDING", status].includes(c.status) ||
      !u ||
      u.role !== "CUSTOMER_ADMIN" ||
      !["PENDING", status].includes(u.status) ||
      !u.passwordHash ||
      u.mustChangePassword !== true ||
      u.email !== a.administratorEmail ||
      u.mobile !== a.administratorMobile
    )
      throw new ReviewError("unavailable");
    // Retain the decision before either projection. Credentials/flags are never overwritten.
    if (!existing) await publish(file, [...rows, record], "decision");
    await security.store.replace(
      "companies",
      companies.map((row) => (row.id === c.id ? { ...row, status } : row)),
    );
    await afterPublish("companies");
    await security.store.replace(
      "users",
      users.map((row) => (row.id === u.id ? { ...row, status } : row)),
    );
    await afterPublish("users");
    await unlink(join(root, intent));
    await afterPublish("complete");
  }
  async function recover() {
    const value = await read(intent);
    if (value !== null)
      await apply(checkedDecision(value as ApplicationDecision));
  }
  async function run<T>(
    actor: ReviewActor | null,
    work: () => Promise<T>,
  ): Promise<T> {
    return security.run(async () => {
      try {
        await recover();
        if (actor) {
          // Do not collide with an interrupted intake that has not been recovered.
          if ((await read("application_intent.json")) !== null)
            throw new ReviewError("unavailable");
          reviewActor(
            actor,
            await readJsonSecurityAccount(security, actor.userId),
            (await sessions.read()).find((s) => s.id === actor.sessionId) ??
              null,
            now(),
          );
        }
        return await work();
      } catch (error) {
        if (error instanceof ReviewError || error instanceof SessionError)
          throw error;
        throw new ReviewError("unavailable");
      }
    }, true);
  }
  async function pending(id: string) {
    const c = (await security.store.read("companies")).find(
      (c) => c.id === id && c.status === "PENDING",
    );
    if (!c?.application) return null;
    const p = checkedPending(c.application),
      u = (await security.store.read("users")).find(
        (u) => u.id === p.administratorUserId && u.companyId === id,
      );
    const raw = await read("delivery_addresses.json");
    if (!Array.isArray(raw)) throw new ReviewError("unavailable");
    const matches = raw.filter((d) => d && d.id === p.deliveryAddressId);
    const d = matches[0];
    if (
      matches.length !== 1 ||
      !d ||
      d.companyId !== id ||
      d.active !== true ||
      d.isDefault !== true ||
      d.address?.line1 !== p.deliveryAddress ||
      !u ||
      u.role !== "CUSTOMER_ADMIN" ||
      u.status !== "PENDING" ||
      u.mustChangePassword !== true ||
      !/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(u.passwordHash ?? "") ||
      u.email !== p.administratorEmail ||
      u.mobile !== p.administratorMobile
    )
      return null;
    return pendingReview(p);
  }
  const repository: ApplicationReviewRepository = {
    list: (actor, offset, limit) =>
      run(actor, async () => {
        const items = [];
        for (const c of (await security.store.read("companies"))
          .filter((c) => c.status === "PENDING")
          .sort((a, b) => a.id.localeCompare(b.id))) {
          const row = await pending(c.id);
          if (row) items.push(row);
        }
        return {
          items: items.slice(offset, offset + limit),
          total: items.length,
        };
      }),
    detail: (actor, id) =>
      run(
        actor,
        async () =>
          (await decisions()).find((d) => d.application.companyId === id)
            ?.application ?? (await pending(id)),
      ),
    decide: (actor, id, command) =>
      run(actor, async () => {
        const existing = (await decisions()).find(
          (d) => d.application.companyId === id,
        );
        if (existing) return replay(existing, command);
        const row = await pending(id);
        if (!row) throw new ReviewError("not_found");
        const record = newDecision(row, actor, command, now());
        await publish(intent, record, "intent");
        await apply(record);
        return record;
      }),
    effect: (actor, id, key, expected, next) =>
      run(actor, async () => {
        const rows = await decisions(),
          record = rows.find((d) => d.application.companyId === id);
        if (!record || record.application[key] !== expected) return false;
        await publish(
          file,
          rows.map((r) =>
            r === record
              ? { ...r, application: { ...r.application, [key]: next } }
              : r,
          ),
          key,
        );
        return true;
      }),
  };
  return { ...repository, recover: () => run(null, recover) };
}
