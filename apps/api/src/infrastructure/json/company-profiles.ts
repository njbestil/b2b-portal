import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CompanyProfileActor,
  CompanyProfileRepository,
} from "../../repositories/company-profiles.js";
import { CompanyProfileError } from "../../services/company-profiles.js";
import { SessionError } from "../../services/session-state.js";
import { checkedAssignments } from "../../services/sales-assignments.js";
import { canonicalCompany, profileActor } from "../company-profile-state.js";
import type { JsonSecurityCoordinator } from "./security.js";
import type { JsonCompany } from "./models.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { createJsonSessionFile } from "./session-file.js";
function view(c: JsonCompany) {
  const original = c.application,
    portal = c.portalProfile ?? {
      primaryContact: original?.administratorName ?? null,
      businessEmail: original?.businessEmail ?? null,
      phone: original?.phone ?? null,
      billingAddress: original?.billingAddress ?? null,
    };
  return canonicalCompany({
    id: c.id,
    legalName: c.legalName,
    status: c.status,
    tradeLicenseReference:
      c.tradeLicenseReference === undefined
        ? (original?.tradeLicenseReference ?? null)
        : c.tradeLicenseReference,
    portal: { tradeName: c.tradeName, ...portal },
    commercial: {
      erpCustomerReference: c.erpCustomerReference,
      paymentTerms: c.paymentTerms ?? null,
      creditStatus: c.creditStatus ?? null,
    },
  });
}
export function createJsonCompanyProfiles(
  security: JsonSecurityCoordinator,
  now = Date.now,
  write: (rows: readonly JsonCompany[]) => Promise<void> = (rows) =>
    security.store.replace("companies", rows),
): CompanyProfileRepository {
  const sessions = createJsonSessionFile(security.directory);
  async function read(name: string): Promise<unknown | null> {
    const path = join(security.directory, name);
    try {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 2 * 1024 * 1024
      )
        throw new CompanyProfileError("unavailable");
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
      throw e;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)),
    );
  }
  const run = <T>(
    actor: CompanyProfileActor,
    companyId: string,
    change: boolean,
    work: (rows: JsonCompany[], row: JsonCompany) => Promise<T>,
  ) =>
    security.run(async () => {
      try {
        if ((await read("application_intent.json")) !== null)
          throw new CompanyProfileError("unavailable");
        const companies = await security.store.read("companies"),
          company = companies.find((c) => c.id === companyId),
          account = await readJsonSecurityAccount(security, actor.userId),
          session =
            (await sessions.read()).find((r) => r.id === actor.sessionId) ??
            null;
        let assigned = false;
        if (actor.role === "SALES_STAFF") {
          const rows = checkedAssignments(
              (await read("customer_sales_assignments.json")) ?? [],
            ),
            users = await security.store.read("users");
          if (
            rows.some(
              (r) =>
                !companies.some((c) => c.id === r.companyId) ||
                !users.some((u) => u.id === r.salesStaffUserId) ||
                !users.some((u) => u.id === r.assignedByUserId),
            )
          )
            throw new CompanyProfileError("unavailable");
          assigned = rows.some(
            (r) =>
              r.companyId === companyId &&
              r.salesStaffUserId === actor.userId &&
              r.active &&
              r.isPrimary &&
              r.endedAt === null &&
              Date.parse(r.createdAt) <= now(),
          );
        }
        profileActor(
          actor,
          account,
          session,
          companyId,
          company?.status ?? null,
          assigned,
          change,
          now(),
        );
        if (!company) throw new CompanyProfileError("not_found");
        return await work(companies, company);
      } catch (e) {
        if (e instanceof CompanyProfileError || e instanceof SessionError)
          throw e;
        throw new CompanyProfileError("unavailable");
      }
    });
  return {
    read: (actor, companyId) =>
      run(actor, companyId, false, async (_rows, row) => view(row)),
    save: (actor, companyId, version, fields) =>
      run(actor, companyId, true, async (rows, row) => {
        if (view(row).version !== version)
          throw new CompanyProfileError("conflict");
        const { tradeName, ...portalProfile } = fields,
          next = { ...row, tradeName, portalProfile };
        const result = view(next);
        await write(rows.map((c) => (c.id === companyId ? next : c)));
        return result;
      }),
  };
}
