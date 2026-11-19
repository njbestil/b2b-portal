import type { Pool, PoolClient } from "pg";
import type {
  FulfillmentActor,
  FulfillmentLink,
  FulfillmentRepository,
} from "../repositories/fulfillment.js";
import type { LoginCredential } from "../repositories/authentication.js";
import {
  FulfillmentError,
  fulfillmentId,
  checkedFulfillmentLink,
  checkedFulfillmentObservation,
  sameFulfillmentLink,
  matchesFulfillment,
  fulfillmentTransition,
} from "../services/fulfillment.js";
import { SessionError } from "../services/session-state.js";
import { fulfillmentActor } from "./fulfillment-state.js";
import { lockedSession } from "./postgres-sessions.js";
export function createPostgresFulfillment(
  pool: Pool,
  now = Date.now,
): FulfillmentRepository {
  async function run<T>(
    actor: FulfillmentActor,
    companyId: string,
    orderId: string,
    signal: AbortSignal,
    work: (client: PoolClient, link: FulfillmentLink) => Promise<T>,
  ): Promise<T> {
    fulfillmentId(actor.userId);
    fulfillmentId(actor.sessionId);
    fulfillmentId(companyId);
    fulfillmentId(orderId);
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      throw new FulfillmentError("unavailable");
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
        await client.query<{ reference: string | null }>(
          "SELECT erp_customer_reference AS reference FROM companies WHERE id=$1 FOR SHARE",
          [companyId],
        )
      ).rows[0];
      const admin = (
        await client.query<Omit<LoginCredential, "companyStatus">>(
          'SELECT id,company_id AS "companyId",display_name AS "displayName",role,status,password_hash AS "passwordHash",must_change_password AS "mustChangePassword" FROM users WHERE id=$1 FOR UPDATE',
          [actor.userId],
        )
      ).rows[0];
      const session = await lockedSession(client, actor.sessionId),
        account = admin ? { ...admin, companyStatus: null } : null;
      const check = () =>
        fulfillmentActor(actor, account, session, now(), signal);
      check();
      const row = (
        await client.query<{
          status: FulfillmentLink["status"];
          erpOrderReference: string | null;
        }>(
          'SELECT order_status AS status,erp_order_reference AS "erpOrderReference" FROM orders WHERE id=$1 AND company_id=$2 FOR UPDATE',
          [orderId, companyId],
        )
      ).rows[0];
      if (!company || !row) throw new FulfillmentError("not_found");
      if (!row.erpOrderReference || !company.reference)
        throw new FulfillmentError("conflict");
      const link = checkedFulfillmentLink({
        companyId,
        orderId,
        erpOrderReference: row.erpOrderReference,
        customerReference: company.reference,
        status: row.status,
      });
      check();
      const result = await work(client, link);
      check();
      if (broken) throw new FulfillmentError("unavailable");
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      if (e instanceof FulfillmentError || e instanceof SessionError) throw e;
      throw new FulfillmentError("unavailable");
    } finally {
      client.off("error", onError);
      client.release(broken);
    }
  }
  return {
    capture: (actor, companyId, orderId, signal) =>
      run(actor, companyId, orderId, signal, async (_client, link) => link),
    apply: (actor, expected, input, signal) => {
      const link = checkedFulfillmentLink(expected);
      return run(
        actor,
        link.companyId,
        link.orderId,
        signal,
        async (client, current) => {
          const observation = checkedFulfillmentObservation(input, now());
          if (
            !sameFulfillmentLink(current, link) ||
            !matchesFulfillment(current, observation)
          )
            throw new FulfillmentError("conflict");
          const changed = fulfillmentTransition(
            current.status,
            observation.status,
          );
          if (changed)
            await client.query(
              "UPDATE orders SET order_status=$1 WHERE id=$2 AND company_id=$3",
              [observation.status, link.orderId, link.companyId],
            );
          return {
            companyId: link.companyId,
            orderId: link.orderId,
            status: observation.status,
            changed,
          };
        },
      );
    },
  };
}
