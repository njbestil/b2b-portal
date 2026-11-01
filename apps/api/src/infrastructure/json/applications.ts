import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ApplicationRecord,
  ApplicationRepository,
} from "../../repositories/applications.js";
import {
  ApplicationError,
  checkedApplication,
  checkedPending,
  pendingProjection,
  applicationId,
  applicationText,
} from "../../services/applications.js";
import { JsonFileStore } from "./store.js";
import type { JsonCompany, JsonUser } from "./models.js";

interface Address {
  id: string;
  companyId: string;
  label: string;
  address: { line1: string };
  active: boolean;
  isDefault: boolean;
}
/** Single shared instance per directory/process. Offline reset/refresh only. */
export function createJsonApplications(
  directory: string,
  store = new JsonFileStore(directory),
  afterPublish: (stage: string) => Promise<void> = async () => {},
) {
  const root = resolve(directory),
    intentPath = join(root, "application_intent.json"),
    addressesPath = join(root, "delivery_addresses.json");
  const missing = Symbol("missing");
  let queue = Promise.resolve();
  let waiting = 0;
  async function ordered<T>(operation: () => Promise<T>): Promise<T> {
    if (waiting >= 32) throw new ApplicationError("unavailable");
    waiting++;
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    try {
      return await result;
    } catch {
      throw new ApplicationError("unavailable");
    } finally {
      waiting--;
    }
  }
  async function read(path: string): Promise<unknown> {
    try {
      const s = await lstat(path);
      if (!s.isFile() || s.isSymbolicLink()) throw new Error();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return missing;
      throw error;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)),
    );
  }
  async function publish(path: string, data: unknown, stage: string) {
    const temp = join(root, `.application.${randomUUID()}.tmp`);
    try {
      const h = await open(temp, "wx", 0o600);
      try {
        await h.writeFile(JSON.stringify(data, null, 2) + "\n", "utf8");
        await h.sync();
      } finally {
        await h.close();
      }
      await rename(temp, path);
      await afterPublish(stage);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  async function addresses(): Promise<Address[]> {
    const value = await read(addressesPath);
    if (value === missing) return [];
    if (!Array.isArray(value)) throw new Error();
    const ids = new Set<string>(),
      defaults = new Set<string>();
    return value.map((r: Address) => {
      if (
        !r ||
        typeof r !== "object" ||
        Object.keys(r).sort().join(",") !==
          "active,address,companyId,id,isDefault,label" ||
        typeof r.label !== "string" ||
        !r.label.trim() ||
        !r.address ||
        Object.keys(r.address).join(",") !== "line1" ||
        typeof r.address.line1 !== "string" ||
        !r.address.line1.trim() ||
        typeof r.active !== "boolean" ||
        typeof r.isDefault !== "boolean" ||
        (r.isDefault && !r.active)
      )
        throw new Error();
      const id = applicationId(r.id),
        companyId = applicationId(r.companyId);
      if (ids.has(id) || (r.isDefault && defaults.has(companyId)))
        throw new Error();
      ids.add(id);
      if (r.isDefault) defaults.add(companyId);
      return {
        id,
        companyId,
        label: applicationText(r.label, 100),
        address: { line1: applicationText(r.address.line1, 500) },
        active: r.active,
        isDefault: r.isDefault,
      };
    });
  }
  async function collections() {
    const c = await read(join(root, "companies.json")),
      u = await read(join(root, "users.json"));
    if ((c === missing) !== (u === missing)) throw new Error();
    if (c === missing) {
      const entries = await readdir(root).catch((error) => {
        if (error && error.code === "ENOENT") return [];
        throw error;
      });
      if (entries.length !== 0) throw new Error();
    }
    return {
      companies: c === missing ? [] : await store.read("companies"),
      users: u === missing ? [] : await store.read("users"),
    };
  }
  async function apply(r: ApplicationRecord) {
    // A valid intent can reconstruct an absent new file after an interrupted first intake.
    const cRaw = await read(join(root, "companies.json")),
      uRaw = await read(join(root, "users.json"));
    const companies: JsonCompany[] =
      cRaw === missing ? [] : await store.read("companies");
    const users: JsonUser[] = uRaw === missing ? [] : await store.read("users");
    const addressRows = await addresses();
    const company: JsonCompany = {
      id: r.companyId,
      legalName: r.companyName,
      tradeName: r.companyName,
      status: "PENDING",
      erpCustomerReference: null,
      application: pendingProjection(r),
    };
    const user: JsonUser = {
      id: r.administratorUserId,
      companyId: r.companyId,
      displayName: r.administratorName,
      role: "CUSTOMER_ADMIN",
      status: "PENDING",
      email: r.administratorEmail,
      passwordHash: r.passwordHash,
      mustChangePassword: true,
      mobile: r.administratorMobile,
    };
    const address: Address = {
      id: r.deliveryAddressId,
      companyId: r.companyId,
      label: "Main delivery",
      address: { line1: r.deliveryAddress },
      active: true,
      isDefault: true,
    };
    if (
      companies.some(
        (c) =>
          c.id !== r.companyId &&
          c.application?.tradeLicenseReference === r.tradeLicenseReference,
      ) ||
      users.some(
        (u) =>
          u.id !== r.administratorUserId && u.email === r.administratorEmail,
      )
    )
      throw new Error();
    function reconcile<T extends { id: string }>(rows: T[], next: T) {
      const existing = rows.find((row) => row.id === next.id);
      if (existing && !isDeepStrictEqual(existing, next)) throw new Error();
      if (!existing) rows.push(next);
    }
    reconcile(companies, company);
    reconcile(users, user);
    reconcile(addressRows, address);
    if (
      addressRows.some((d) => !companies.some((c) => c.id === d.companyId)) ||
      users.some(
        (u) =>
          u.companyId !== null && !companies.some((c) => c.id === u.companyId),
      )
    )
      throw new Error();
    if (
      addressRows.some(
        (d) =>
          d.companyId === r.companyId &&
          d.isDefault &&
          d.id !== r.deliveryAddressId,
      )
    )
      throw new Error();
    await store.replace("companies", companies);
    await afterPublish("companies");
    await store.replace("users", users);
    await afterPublish("users");
    await publish(addressesPath, addressRows, "addresses");
    const final = await collections(),
      finalAddresses = await addresses();
    if (
      !isDeepStrictEqual(
        final.companies.find((c) => c.id === r.companyId),
        company,
      ) ||
      !isDeepStrictEqual(
        final.users.find((u) => u.id === r.administratorUserId),
        user,
      ) ||
      !isDeepStrictEqual(
        finalAddresses.find((d) => d.id === r.deliveryAddressId),
        address,
      )
    )
      throw new Error();
    await unlink(intentPath);
    await afterPublish("complete");
  }
  async function recover() {
    const stat = await lstat(root).catch((error) => {
      if (error && error.code === "ENOENT") return null;
      throw error;
    });
    if (stat === null) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    const intent = await read(intentPath);
    if (intent !== missing) {
      if (
        !intent ||
        typeof intent !== "object" ||
        Array.isArray(intent) ||
        Object.keys(intent).sort().join(",") !== "record,version" ||
        !("version" in intent) ||
        intent.version !== 1 ||
        !("record" in intent)
      )
        throw new Error();
      const r = checkedApplication(intent.record as ApplicationRecord);
      if (!isDeepStrictEqual(r, intent.record)) throw new Error();
      await apply(r);
    } else await collections();
  }
  const repository: ApplicationRepository = {
    async submit(input) {
      const r = checkedApplication(input);
      return ordered(async () => {
        await recover();
        const { companies, users } = await collections();
        const duplicateUser = users.find(
          (u) => u.email === r.administratorEmail,
        );
        const duplicateCompany = companies.find(
          (c) =>
            c.application?.tradeLicenseReference === r.tradeLicenseReference,
        );
        if (duplicateUser || duplicateCompany)
          return {
            companyId: duplicateCompany?.id ?? duplicateUser?.companyId ?? null,
          };
        await mkdir(root, { recursive: true });
        await publish(intentPath, { version: 1, record: r }, "intent");
        await apply(r);
        return { companyId: r.companyId };
      });
    },
    async pending(input) {
      const id = applicationId(input);
      return ordered(async () => {
        await recover();
        const { companies, users } = await collections(),
          c = companies.find((c) => c.id === id && c.status === "PENDING");
        if (!c?.application) return null;
        const p = checkedPending(c.application),
          u = users.find(
            (u) => u.id === p.administratorUserId && u.companyId === id,
          );
        const d = (await addresses()).find(
          (d) =>
            d.id === p.deliveryAddressId &&
            d.companyId === id &&
            d.active &&
            d.isDefault,
        );
        if (
          !u ||
          u.status !== "PENDING" ||
          u.role !== "CUSTOMER_ADMIN" ||
          u.mustChangePassword !== true ||
          !u.passwordHash ||
          u.email !== p.administratorEmail ||
          u.mobile !== p.administratorMobile ||
          !d ||
          d.address.line1 !== p.deliveryAddress
        )
          return null;
        return p;
      });
    },
  };
  return { ...repository, recover: () => ordered(recover) };
}
