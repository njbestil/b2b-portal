import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useId,
} from "react";
import { Link, useParams } from "react-router";
import { Page } from "../../shell/pages";
import { Badge, Button } from "../../shared/ui";
import { RemoteModel, remoteMessage } from "../../shared/remote";
import { useAuth } from "../authentication/AuthContext";
import { ConfirmationClient, type Review } from "./api";
import "./confirmation.css";
export function ConfirmationContents({ review }: { review: Review }) {
  return (
    <>
      <p>Created on your behalf by {review.order.createdBy}</p>
      <ul className="confirmation-products">
        {review.order.items.map((line) => (
          <li key={line.id}>
            <span>
              <strong>{line.name}</strong>
              <small>{line.sku}</small>
            </span>
            <strong>
              {line.quantity} {line.sellingUom}
            </strong>
          </li>
        ))}
      </ul>
      <dl>
        <dt>Delivery address</dt>
        <dd>
          {review.order.delivery ? (
            <>
              {review.order.delivery.label}
              <br />
              {review.order.delivery.line1}
            </>
          ) : (
            "Unavailable"
          )}
        </dd>
      </dl>
      <p className="confirmation-notice">
        This records your decision. Current pricing, availability and account
        eligibility must be validated before ERP submission. No financial total
        is available at this stage.
      </p>
    </>
  );
}
export function ConfirmationPage({
  id,
  client,
}: {
  id: string;
  client: Pick<ConfirmationClient, "find" | "decide">;
}) {
  const model = useMemo(() => new RemoteModel<Review>(), []),
    state = useSyncExternalStore(
      model.subscribe,
      model.snapshot,
      model.snapshot,
    ),
    dialog = useRef<HTMLDialogElement>(null),
    [reason, setReason] = useState(""),
    [validation, setValidation] = useState(""),
    reasonField = useRef<HTMLTextAreaElement>(null),
    titleId = useId(),
    reasonId = useId();
  useEffect(() => {
    const modal = dialog.current;
    void model.load((s) => client.find(id, s));
    return () => {
      model.cancel();
      modal?.close();
    };
  }, [id, client, model]);
  async function decide(decision: "CONFIRMED" | "REJECTED") {
    if (
      decision === "REJECTED" &&
      (!reason.trim() ||
        reason.length > 1000 ||
        Array.from(reason).some((c) => {
          const n = c.codePointAt(0)!;
          return n < 32 || (n >= 127 && n <= 159);
        }))
    ) {
      setValidation("Enter a rejection reason, up to 1,000 characters.");
      reasonField.current?.focus();
      return;
    }
    setValidation("");
    const saved = await model.write((data, signal) =>
      client.decide(
        id,
        data.confirmation.id,
        decision,
        decision === "REJECTED" ? reason.trim() : null,
        signal,
      ),
    );
    if (saved) dialog.current?.close();
  }
  const record = state.data?.confirmation;
  return (
    <Page
      title="Customer confirmation"
      eyebrow="Assisted orders"
      description="Review the order created for your company and record your decision."
    >
      <Link to="/orders/history">Back to company orders</Link>
      <p role="status">
        {state.busy
          ? "Loading or recording confirmation…"
          : record?.status === "CONFIRMED"
            ? "Confirmation recorded. Awaiting submission."
            : record?.status === "REJECTED"
              ? "Rejection recorded."
              : ""}
      </p>
      <div role="alert">
        {state.error ? remoteMessage(state.error, state.needsReload) : ""}
      </div>
      <Button
        variant="secondary"
        unavailable={state.busy}
        onClick={() => void model.load((s) => client.find(id, s))}
      >
        Refresh confirmation
      </Button>
      {state.data && !state.busy && !state.needsReload && (
        <section className="panel confirmation-summary">
          <Badge tone={record?.status === "PENDING" ? "warning" : "neutral"}>
            {record?.status}
          </Badge>
          <h2>
            {record?.status === "PENDING"
              ? "Order awaiting your confirmation"
              : "Your decision"}
          </h2>
          <ConfirmationContents review={state.data} />
          {record?.reason && <p>Rejection reason: {record.reason}</p>}
          {record?.status === "PENDING" && (
            <Button onClick={() => dialog.current?.showModal()}>
              Review and decide
            </Button>
          )}
        </section>
      )}
      <dialog
        className="confirmation-dialog"
        ref={dialog}
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>Order awaiting your confirmation</h2>
        {state.data && <ConfirmationContents review={state.data} />}
        <label htmlFor={reasonId}>
          Rejection reason (required only if rejecting)
        </label>
        <textarea
          id={reasonId}
          ref={reasonField}
          maxLength={1000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-describedby={`${reasonId}-error`}
          readOnly={state.busy}
        />
        <p id={`${reasonId}-error`} role="alert">
          {validation}
        </p>
        <div role="alert">
          {state.error ? remoteMessage(state.error, state.needsReload) : ""}
        </div>
        <div className="confirmation-actions">
          <Button variant="secondary" onClick={() => dialog.current?.close()}>
            Close
          </Button>
          <Button
            variant="danger"
            unavailable={state.busy || state.needsReload}
            onClick={() => void decide("REJECTED")}
          >
            Reject order
          </Button>
          <Button
            unavailable={state.busy || state.needsReload}
            onClick={() => void decide("CONFIRMED")}
          >
            Confirm order
          </Button>
        </div>
      </dialog>
    </Page>
  );
}
function Connected({ id }: { id: string }) {
  const { client, user } = useAuth(),
    adapter = useMemo(
      () => new ConfirmationClient(client, user!),
      [client, user],
    );
  return <ConfirmationPage id={id} client={adapter} />;
}
export function ConfirmationEntry() {
  const { user } = useAuth(),
    { orderId } = useParams();
  if (
    !user ||
    user.mustChangePassword ||
    !user.companyId ||
    !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(user.role)
  )
    return (
      <Page
        title="Customer confirmation"
        description="Sign in with an authorized customer account."
      >
        <p>Confirmation unavailable in this workspace.</p>
      </Page>
    );
  return (
    <Connected
      key={`${user.id}:${user.companyId}:${orderId}`}
      id={orderId ?? ""}
    />
  );
}
