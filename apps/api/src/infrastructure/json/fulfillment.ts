import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  FulfillmentActor,
  FulfillmentRepository,
} from "../../repositories/fulfillment.js";
import type { JsonOrder } from "./models.js";
import type { JsonSecurityCoordinator } from "./security.js";
import { createJsonSessionFile, type FileIo } from "./session-file.js";
import { parseCollection } from "./schema.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { fulfillmentActor } from "../fulfillment-state.js";
import {
  FulfillmentError,
  fulfillmentId,
  checkedFulfillmentLink,
  checkedFulfillmentObservation,
  sameFulfillmentLink,
  matchesFulfillment,
  fulfillmentTransition,
} from "../../services/fulfillment.js";
import { SessionError } from "../../services/session-state.js";
export function createJsonFulfillment(
  security: JsonSecurityCoordinator,
  now = Date.now,
  io: FileIo = fs,
): FulfillmentRepository {
  const sessions = createJsonSessionFile(security.directory),
    path = join(security.directory, "orders.json");
  async function orders(): Promise<JsonOrder[]> {
    const stat = await io.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024)
      throw new FulfillmentError("unavailable");
    const bytes = await io.readFile(path);
    if (bytes.byteLength > 10 * 1024 * 1024)
      throw new FulfillmentError("unavailable");
    const raw = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ),
      checked = parseCollection("orders", raw);
    // Fail closed on any unsupported top-level or nested private data; never drop it.
    if (!isDeepStrictEqual(raw, checked))
      throw new FulfillmentError("unavailable");
    return checked;
  }
  async function publish(rows: JsonOrder[], check: () => void) {
    if (!isDeepStrictEqual(rows, parseCollection("orders", rows)))
      throw new FulfillmentError("unavailable");
    const text = JSON.stringify(rows, null, 2) + "\n";
    if (Buffer.byteLength(text) > 10 * 1024 * 1024)
      throw new FulfillmentError("unavailable");
    const temporary = join(
      security.directory,
      `.orders.fulfillment.${randomUUID()}.tmp`,
    );
    try {
      const handle = await io.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      check();
      await io.rename(temporary, path);
    } finally {
      await io.unlink(temporary).catch(() => {});
    }
  }
  const run = <T>(work: () => Promise<T>) =>
    security.run(async () => {
      try {
        return await work();
      } catch (e) {
        if (e instanceof FulfillmentError || e instanceof SessionError) throw e;
        throw new FulfillmentError("unavailable");
      }
    });
  async function state(
    actor: FulfillmentActor,
    companyId: string,
    orderId: string,
    signal: AbortSignal,
  ) {
    fulfillmentId(companyId);
    fulfillmentId(orderId);
    try {
      await fs.lstat(join(security.directory, "application_intent.json"));
      throw new FulfillmentError("unavailable");
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
    const account = await readJsonSecurityAccount(security, actor.userId),
      proofs = await sessions.read(),
      check = () =>
        fulfillmentActor(
          actor,
          account,
          proofs.find((s) => s.id === actor.sessionId) ?? null,
          now(),
          signal,
        );
    check();
    const rows = await orders(),
      company = (await security.store.read("companies")).find(
        (c) => c.id === companyId,
      ),
      row = rows.find((r) => r.id === orderId && r.companyId === companyId);
    if (!company || !row) throw new FulfillmentError("not_found");
    if (!company.erpCustomerReference || !row.erpOrderReference)
      throw new FulfillmentError("conflict");
    const link = checkedFulfillmentLink({
      companyId,
      orderId,
      erpOrderReference: row.erpOrderReference,
      customerReference: company.erpCustomerReference,
      status: row.status,
    });
    check();
    return { rows, row, link, check };
  }
  return {
    capture: (actor, companyId, orderId, signal) =>
      run(async () => {
        const s = await state(actor, companyId, orderId, signal);
        return s.link;
      }),
    apply: (actor, expected, input, signal) =>
      run(async () => {
        const link = checkedFulfillmentLink(expected),
          s = await state(actor, link.companyId, link.orderId, signal),
          observation = checkedFulfillmentObservation(input, now());
        if (
          !sameFulfillmentLink(s.link, link) ||
          !matchesFulfillment(s.link, observation)
        )
          throw new FulfillmentError("conflict");
        const changed = fulfillmentTransition(s.row.status, observation.status);
        if (changed)
          await publish(
            s.rows.map((r) =>
              r.id === s.row.id ? { ...r, status: observation.status } : r,
            ),
            () => {
              s.check();
              checkedFulfillmentObservation(observation, now());
            },
          );
        // A known completed rename is committed; return it so required audit runs.
        // Only a no-op still needs a final admission check here.
        else s.check();
        return {
          companyId: link.companyId,
          orderId: link.orderId,
          status: observation.status,
          changed,
        };
      }),
  };
}
