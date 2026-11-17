import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrderSnapshot } from "../repositories/order-snapshots.js";
import { checkedOrderSnapshot } from "../services/order-snapshot.js";
import { withPostgresOrderSnapshot } from "./postgres-order-snapshots.js";

export class SubmissionKeyConflict extends Error {
  constructor() {
    super("Submission key conflict.");
  }
}

type Request = {
  readonly key: string;
  readonly companyId: string;
  readonly userId: string;
  readonly orderId: string;
  /** Stable, server-defined canonical request bytes, bounded before hashing. */
  readonly canonicalRequest: string;
};
type Result = {
  readonly snapshot: OrderSnapshot;
  readonly outboundReference: string;
  readonly replayed: boolean;
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

class Replay extends Error {
  constructor(readonly result: Result) {
    super("Replay");
  }
}

/** Internal transaction component. authorize must check current authority for
 * both new requests and replays, on this client. transition must revalidate
 * the draft and live data, transition it on this client, and perform no ERP IO. */
export async function submitIdempotently(
  pool: Pool,
  request: Request,
  authorize: (client: PoolClient) => Promise<void>,
  transition: (
    client: PoolClient,
    outboundReference: string,
  ) => Promise<OrderSnapshot>,
): Promise<Result> {
  if (
    !/^[\x21-\x7e]{1,128}$/.test(request.key) ||
    typeof request.canonicalRequest !== "string" ||
    Buffer.byteLength(request.canonicalRequest, "utf8") > 65536
  )
    throw new TypeError("Invalid submission request.");
  const keyHash = hash(request.key),
    requestHash = hash(request.canonicalRequest);
  let outboundReference = "";
  try {
    const snapshot = await withPostgresOrderSnapshot(pool, async (client) => {
      await authorize(client);
      outboundReference = randomUUID();
      const inserted = await client.query(
        `INSERT INTO submission_idempotency(key_hash,company_id,order_id,user_id,request_hash,outbound_reference)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING key_hash`,
        [
          keyHash,
          request.companyId,
          request.orderId,
          request.userId,
          requestHash,
          outboundReference,
        ],
      );
      if (!inserted.rowCount) {
        const existing = (
          await client.query(
            `SELECT s.company_id AS "companyId",s.order_id AS "orderId",s.user_id AS "userId",s.request_hash AS "requestHash",s.outbound_reference AS "outboundReference",o.order_snapshot AS snapshot
           FROM submission_idempotency s JOIN orders o ON o.id=s.order_id AND o.company_id=s.company_id WHERE s.key_hash=$1`,
            [keyHash],
          )
        ).rows[0];
        if (
          !existing ||
          existing.companyId !== request.companyId ||
          existing.orderId !== request.orderId ||
          existing.userId !== request.userId ||
          existing.requestHash !== requestHash ||
          !existing.snapshot
        )
          throw new SubmissionKeyConflict();
        await authorize(client);
        throw new Replay({
          snapshot: checkedOrderSnapshot(existing.snapshot),
          outboundReference: existing.outboundReference,
          replayed: true,
        });
      }
      const snapshot = await transition(client, outboundReference);
      if (
        snapshot.orderId !== request.orderId ||
        snapshot.companyId !== request.companyId ||
        snapshot.submittedBy.id !== request.userId
      )
        throw new SubmissionKeyConflict();
      await authorize(client);
      return snapshot;
    });
    return { snapshot, outboundReference, replayed: false };
  } catch (error) {
    if (error instanceof Replay) return error.result;
    throw error;
  }
}
