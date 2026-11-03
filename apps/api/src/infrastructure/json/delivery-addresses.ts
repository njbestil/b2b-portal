import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AddressActor,
  DeliveryAddress,
  DeliveryAddressRepository,
} from "../../repositories/delivery-addresses.js";
import { AddressError, addressId } from "../../services/delivery-addresses.js";
import { SessionError } from "../../services/session-state.js";
import { checkedAssignments } from "../../services/sales-assignments.js";
import {
  addressActor,
  addressCollection,
  addressView,
  changeAddresses,
  checkedAddress,
} from "../delivery-address-state.js";
import type { JsonSecurityCoordinator } from "./security.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { createJsonSessionFile, type FileIo } from "./session-file.js";
type StoredAddress = DeliveryAddress & { companyId: string };
export function createJsonDeliveryAddresses(
  security: JsonSecurityCoordinator,
  now = Date.now,
  io: FileIo = fs,
  afterPublish: () => Promise<void> = async () => {},
): DeliveryAddressRepository {
  const path = join(security.directory, "delivery_addresses.json"),
    sessions = createJsonSessionFile(security.directory);
  async function read(name: string): Promise<unknown | null> {
    const target = join(security.directory, name);
    try {
      const stat = await io.lstat(target);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 10 * 1024 * 1024
      )
        throw new AddressError("unavailable");
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
      throw e;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await io.readFile(target),
      ),
    );
  }
  async function rows(): Promise<StoredAddress[]> {
    const raw = await read("delivery_addresses.json");
    if (raw === null) return [];
    if (!Array.isArray(raw)) throw new AddressError("unavailable");
    const result = raw.map((r: StoredAddress) => {
      if (
        !r ||
        typeof r !== "object" ||
        Array.isArray(r) ||
        Object.keys(r).some(
          (k) =>
            ![
              "id",
              "companyId",
              "label",
              "address",
              "active",
              "isDefault",
              "contactName",
              "contactPhone",
            ].includes(k),
        )
      )
        throw new AddressError("unavailable");
      return { ...checkedAddress(r), companyId: addressId(r.companyId) };
    });
    if (new Set(result.map((r) => r.id)).size !== result.length)
      throw new AddressError("unavailable");
    const companies = await security.store.read("companies");
    if (result.some((r) => !companies.some((c) => c.id === r.companyId)))
      throw new AddressError("unavailable");
    for (const companyId of new Set(result.map((r) => r.companyId)))
      addressCollection(
        companyId,
        result.filter((r) => r.companyId === companyId),
      );
    return result;
  }
  async function publish(rows: StoredAddress[]) {
    const text = JSON.stringify(rows, null, 2) + "\n";
    if (Buffer.byteLength(text) > 10 * 1024 * 1024)
      throw new AddressError("unavailable");
    const temp = join(
      security.directory,
      `.delivery-addresses.${randomUUID()}.tmp`,
    );
    try {
      const handle = await io.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await io.rename(temp, path);
      await afterPublish();
    } finally {
      await io.unlink(temp).catch(() => {});
    }
  }
  const run = <T>(
    actor: AddressActor,
    companyId: string,
    write: boolean,
    work: (rows: StoredAddress[]) => Promise<T>,
  ) =>
    security.run(async () => {
      try {
        if ((await read("application_intent.json")) !== null)
          throw new AddressError("unavailable");
        const companies = await security.store.read("companies"),
          company = companies.find((c) => c.id === companyId),
          account = await readJsonSecurityAccount(security, actor.userId),
          session =
            (await sessions.read()).find((r) => r.id === actor.sessionId) ??
            null;
        let assigned = false;
        if (actor.role === "SALES_STAFF") {
          const raw = await read("customer_sales_assignments.json"),
            assignments = checkedAssignments(raw ?? []),
            users = await security.store.read("users");
          if (
            assignments.some(
              (r) =>
                !companies.some((c) => c.id === r.companyId) ||
                !users.some((u) => u.id === r.salesStaffUserId) ||
                !users.some((u) => u.id === r.assignedByUserId),
            )
          )
            throw new AddressError("unavailable");
          assigned = assignments.some(
            (r) =>
              r.companyId === companyId &&
              r.salesStaffUserId === actor.userId &&
              r.active &&
              r.isPrimary &&
              r.endedAt === null &&
              Date.parse(r.createdAt) <= now(),
          );
        }
        addressActor(
          actor,
          account,
          session,
          companyId,
          company?.status ?? null,
          assigned,
          write,
          now(),
        );
        const input = await rows();
        addressActor(
          actor,
          account,
          session,
          companyId,
          company?.status ?? null,
          assigned,
          write,
          now(),
        );
        return await work(input);
      } catch (e) {
        if (e instanceof AddressError || e instanceof SessionError) throw e;
        throw new AddressError("unavailable");
      }
    });
  return {
    read: (actor, companyId) =>
      run(actor, companyId, false, async (rows) =>
        addressView(
          addressCollection(
            companyId,
            rows.filter((r) => r.companyId === companyId),
          ),
          actor.role,
        ),
      ),
    change: (actor, companyId, command) =>
      run(actor, companyId, true, async (rows) => {
        const result = changeAddresses(
          addressCollection(
            companyId,
            rows.filter((r) => r.companyId === companyId),
          ),
          command,
        );
        await publish([
          ...rows.filter((r) => r.companyId !== companyId),
          ...result.addresses.items.map((r) => ({ ...r, companyId })),
        ]);
        return result;
      }),
  };
}
