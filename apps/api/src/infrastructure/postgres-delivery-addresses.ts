import type { Pool, PoolClient } from "pg";
import type {
  AddressActor,
  DeliveryAddressRepository,
  DeliveryAddress,
} from "../repositories/delivery-addresses.js";
import type { LoginCredential } from "../repositories/authentication.js";
import {
  addressActor,
  addressCollection,
  addressView,
  changeAddresses,
} from "./delivery-address-state.js";
import { lockedSession } from "./postgres-sessions.js";
import { AddressError } from "../services/delivery-addresses.js";
import { SessionError } from "../services/session-state.js";
import { checkedAssignments } from "../services/sales-assignments.js";
export function createPostgresDeliveryAddresses(
  pool: Pool,
  now = Date.now,
): DeliveryAddressRepository {
  async function run<T>(
    actor: AddressActor,
    companyId: string,
    write: boolean,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      throw new AddressError("unavailable");
    }
    let broken = false;
    const onError = () => {
      broken = true;
    };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      const company = (
        await client.query(
          "SELECT status FROM companies WHERE id=$1 FOR UPDATE",
          [companyId],
        )
      ).rows[0];
      const user = (
        await client.query<LoginCredential>(
          'SELECT id,company_id AS "companyId",display_name AS "displayName",role,status,password_hash AS "passwordHash",must_change_password AS "mustChangePassword" FROM users WHERE id=$1 FOR UPDATE',
          [actor.userId],
        )
      ).rows[0];
      const account = user
        ? {
            ...user,
            companyStatus:
              user.companyId === companyId ? (company?.status ?? null) : null,
          }
        : null;
      const session = await lockedSession(client, actor.sessionId);
      let assigned = false;
      if (actor.role === "SALES_STAFF") {
        const rows = (
          await client.query(
            'SELECT id,company_id AS "companyId",sales_staff_user_id AS "salesStaffUserId",assigned_by_user_id AS "assignedByUserId",is_primary AS "isPrimary",active,created_at AS "createdAt",ended_at AS "endedAt" FROM customer_sales_assignments WHERE company_id=$1 FOR SHARE',
            [companyId],
          )
        ).rows;
        assigned = checkedAssignments(
          rows.map((r) => ({
            ...r,
            createdAt: r.createdAt.toISOString(),
            endedAt: r.endedAt?.toISOString() ?? null,
          })),
        ).some(
          (r) =>
            r.salesStaffUserId === actor.userId &&
            r.active &&
            r.isPrimary &&
            r.endedAt === null &&
            Date.parse(r.createdAt) <= now(),
        );
      }
      const check = () =>
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
      check();
      const result = await work(client);
      check();
      if (broken) throw new AddressError("unavailable");
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      if (e instanceof AddressError || e instanceof SessionError) throw e;
      throw new AddressError("unavailable");
    } finally {
      client.off("error", onError);
      client.release(broken);
    }
  }
  async function collection(client: PoolClient, companyId: string) {
    const rows = (
      await client.query(
        'SELECT id,label,address,active,is_default AS "isDefault" FROM delivery_addresses WHERE company_id=$1 ORDER BY id FOR UPDATE',
        [companyId],
      )
    ).rows;
    if (
      rows.some((r) =>
        Object.keys(r.address ?? {}).some(
          (key) => !["line1", "contactName", "contactPhone"].includes(key),
        ),
      )
    )
      throw new AddressError("unavailable");
    return addressCollection(
      companyId,
      rows.map(
        (r) =>
          ({
            id: r.id,
            label: r.label,
            address: { line1: r.address?.line1 },
            contactName: r.address?.contactName ?? null,
            contactPhone: r.address?.contactPhone ?? null,
            active: r.active,
            isDefault: r.isDefault,
          }) as DeliveryAddress,
      ),
    );
  }
  return {
    read: (actor, companyId) =>
      run(actor, companyId, false, async (client) =>
        addressView(await collection(client, companyId), actor.role),
      ),
    change: (actor, companyId, command) =>
      run(actor, companyId, true, async (client) => {
        const current = await collection(client, companyId),
          result = changeAddresses(current, command);
        // Clear before setting a new default to satisfy the immediate unique index.
        await client.query(
          "UPDATE delivery_addresses SET is_default=false WHERE company_id=$1 AND is_default",
          [companyId],
        );
        for (const row of result.addresses.items) {
          const payload = {
            line1: row.address.line1,
            contactName: row.contactName,
            contactPhone: row.contactPhone,
          };
          if (current.items.some((r) => r.id === row.id))
            await client.query(
              "UPDATE delivery_addresses SET label=$1,address=$2::jsonb,active=$3,is_default=$4,updated_at=$5 WHERE company_id=$6 AND id=$7",
              [
                row.label,
                JSON.stringify(payload),
                row.active,
                row.isDefault,
                new Date(now()).toISOString(),
                companyId,
                row.id,
              ],
            );
          else
            await client.query(
              "INSERT INTO delivery_addresses(id,company_id,label,address,active,is_default,created_at,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$7)",
              [
                row.id,
                companyId,
                row.label,
                JSON.stringify(payload),
                row.active,
                row.isDefault,
                new Date(now()).toISOString(),
              ],
            );
        }
        return result;
      }),
  };
}
