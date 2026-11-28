import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Button } from "../../shared/ui";
import { RemoteModel, remoteMessage } from "../../shared/remote";
import type { ConfirmationClient, SubmissionQuote } from "./api";

export function AssistedSubmission({
  id,
  confirmationId,
  client,
  onSubmitted,
}: {
  id: string;
  confirmationId: string;
  client: Pick<ConfirmationClient, "quote" | "submit">;
  onSubmitted: () => void;
}) {
  const model = useMemo(() => new RemoteModel<SubmissionQuote>(), []);
  const state = useSyncExternalStore(
    model.subscribe,
    model.snapshot,
    model.snapshot,
  );
  useEffect(() => {
    void model.load((s) => client.quote(id, confirmationId, s));
    return () => model.cancel();
  }, [id, confirmationId, client, model]);
  return (
    <section>
      <h3>Review current submission prices</h3>
      <p role="status">
        {state.busy
          ? "Checking current prices and eligibility…"
          : state.saved
            ? "Submission recorded. Check company orders for ERP status."
            : ""}
      </p>
      <div role="alert">
        {state.error ? remoteMessage(state.error, state.needsReload) : ""}
      </div>
      <Button
        variant="secondary"
        unavailable={state.busy}
        onClick={() =>
          void model.load((s) => client.quote(id, confirmationId, s))
        }
      >
        Refresh submission prices
      </Button>
      {state.data && !state.busy && !state.needsReload && !state.saved && (
        <>
          <SubmissionQuoteDetails quote={state.data} />
          <p>
            Accept these prices and delivery details to submit this confirmed
            order. Availability and eligibility are checked again. Submission
            does not guarantee ERP acceptance.
          </p>
          <Button
            onClick={() =>
              void model.write(async (quote, s) => {
                await client.submit(id, quote, s);
                onSubmitted();
                return quote;
              })
            }
          >
            Accept prices and submit order
          </Button>
        </>
      )}
    </section>
  );
}
export function SubmissionQuoteDetails({ quote }: { quote: SubmissionQuote }) {
  return (
    <>
      <ul>
        {quote.items.map((r) => (
          <li key={r.itemId}>
            {r.name}: {r.quantity} {r.sellingUom} × {r.currency} {r.unitPrice} ={" "}
            {r.lineTotal}
          </li>
        ))}
      </ul>
      <dl>
        <dt>Delivery at submission</dt>
        <dd>
          {quote.delivery.label}
          <br />
          {quote.delivery.line1}
        </dd>
        {quote.delivery.contactName && (
          <>
            <dt>Delivery contact</dt>
            <dd>{quote.delivery.contactName}</dd>
          </>
        )}
        {quote.delivery.contactPhone && (
          <>
            <dt>Delivery phone</dt>
            <dd>{quote.delivery.contactPhone}</dd>
          </>
        )}
      </dl>
      <p>
        <strong>
          Total: {quote.currency} {quote.total}
        </strong>
      </p>
    </>
  );
}
