import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { Link } from "react-router";
import { useAuth } from "../authentication/AuthContext";
import { Page } from "../../shell/pages";
import { Badge, Button } from "../../shared/ui";
import { RemoteModel, remoteMessage } from "../../shared/remote";
import {
  CancellationClient,
  cancellationMessage,
  cancellationReason,
  type Cancellation,
  type CancellationOrder,
} from "./api";
import "./cancellations.css";
export function CancellationState({ value }: { value: Cancellation | null }) {
  if (!value) return <p>No cancellation request is recorded for this order.</p>;
  const message = cancellationMessage(value.status);
  return (
    <div className="cancellation-state">
      <Badge tone={message.tone}>{message.title}</Badge>
      <p>{message.message}</p>
    </div>
  );
}
function CancellationPanel({
  client,
  order,
}: {
  client: CancellationClient;
  order: CancellationOrder;
}) {
  const model = useMemo(
      () => new RemoteModel<{ cancellation: Cancellation | null }>(),
      [],
    ),
    state = useSyncExternalStore(
      model.subscribe,
      model.snapshot,
      model.snapshot,
    ),
    dialog = useRef<HTMLDialogElement>(null),
    field = useRef<HTMLTextAreaElement>(null),
    key = useRef<string | null>(null),
    [reason, setReason] = useState(""),
    [formError, setFormError] = useState(""),
    fieldId = useId(),
    errorId = useId(),
    titleId = useId();
  useEffect(() => {
    void model.load((s) => client.latest(order.id, s));
    return () => model.cancel();
  }, [client, order.id, model]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (state.busy || state.needsReload || !state.data) return;
    let checked: string;
    try {
      checked = cancellationReason(reason);
    } catch {
      setFormError(
        "Enter a reason of 1–500 characters without control characters.",
      );
      field.current?.focus();
      return;
    }
    setFormError("");
    key.current ??= crypto.randomUUID();
    if (
      await model.write((_data, signal) =>
        client.submit(order.id, checked, key.current!, signal),
      )
    ) {
      dialog.current?.close();
      setReason("");
      key.current = null;
    }
  }
  const current = state.data?.cancellation,
    terminal = ["DELIVERED", "CANCELLED", "REJECTED"].includes(order.status),
    canRequest =
      !terminal &&
      state.data &&
      (!current || current.status === "REJECTED") &&
      !state.needsReload;
  return (
    <article className="panel cancellation-panel">
      <h2>{order.number}</h2>
      <p role="status">
        {state.busy
          ? "Checking cancellation…"
          : state.saved
            ? "Cancellation status updated."
            : ""}
      </p>
      <div role="alert">
        {state.error ? remoteMessage(state.error, true) : ""}
      </div>
      {state.data && <CancellationState value={state.data.cancellation} />}
      <div className="cancellation-actions">
        <Button
          variant="secondary"
          unavailable={state.busy}
          onClick={() => void model.load((s) => client.latest(order.id, s))}
        >
          Check cancellation status
        </Button>
        {canRequest && (
          <Button
            variant="secondary"
            unavailable={state.busy}
            onClick={() => {
              setFormError("");
              dialog.current?.showModal();
            }}
          >
            Request cancellation
          </Button>
        )}
      </div>
      {terminal && <p>This order cannot start another cancellation request.</p>}
      <dialog
        ref={dialog}
        className="cancellation-dialog"
        aria-labelledby={titleId}
      >
        <div className="panel-head">
          <h2 id={titleId}>Request cancellation</h2>
          <Button variant="quiet" onClick={() => dialog.current?.close()}>
            Close
          </Button>
        </div>
        <p>{order.number}</p>
        <div className="cancellation-state">
          <strong>This request may need review.</strong>
          <p>
            Check the confirmed result below before treating your order as
            cancelled.
          </p>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor={fieldId}>Cancellation reason</label>
            <textarea
              id={fieldId}
              ref={field}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              maxLength={500}
              aria-invalid={!!formError || undefined}
              aria-describedby={errorId}
            />
            <div id={errorId} role="alert">
              {formError}
            </div>
          </div>
          <p role="status">
            {state.busy ? "Submitting cancellation request…" : ""}
          </p>
          <div role="alert">
            {state.error ? remoteMessage(state.error, true) : ""}
          </div>
          <div className="cancellation-actions">
            <Button
              variant="secondary"
              unavailable={state.busy}
              onClick={() => dialog.current?.close()}
            >
              Keep order
            </Button>
            {!state.needsReload && (
              <Button type="submit">Submit cancellation request</Button>
            )}
            {state.needsReload && (
              <Button
                variant="secondary"
                onClick={() => {
                  dialog.current?.close();
                  void model.load((s) => client.latest(order.id, s));
                }}
              >
                Check status before another request
              </Button>
            )}
          </div>
        </form>
      </dialog>
    </article>
  );
}
function Connected() {
  const { client: session, user } = useAuth(),
    client = useMemo(
      () => new CancellationClient(session, user!),
      [session, user],
    ),
    model = useMemo(
      () => new RemoteModel<{ items: CancellationOrder[]; total: number }>(),
      [],
    ),
    state = useSyncExternalStore(
      model.subscribe,
      model.snapshot,
      model.snapshot,
    ),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState(""),
    selectId = useId();
  useEffect(() => {
    void model.load((s) => client.orders(offset, s));
    return () => model.cancel();
  }, [client, offset, model]);
  const order =
    state.data?.items.find((o) => o.id === selected) ?? state.data?.items[0];
  return (
    <Page
      title="Order cancellations"
      eyebrow="Order management"
      description="Request a cancellation and check whether it was requested, approved or rejected."
    >
      <Link to="/orders">Back to drafts</Link>
      <p role="status">{state.busy ? "Loading company orders…" : ""}</p>
      <div role="alert">{state.error ? remoteMessage(state.error) : ""}</div>
      {state.error && (
        <Button
          variant="secondary"
          onClick={() => void model.load((s) => client.orders(offset, s))}
        >
          Reload orders
        </Button>
      )}
      {!state.busy && state.data && (
        <>
          {!state.data.items.length ? (
            <p>No company orders on this page.</p>
          ) : (
            <div className="field">
              <label htmlFor={selectId}>Company order</label>
              <select
                id={selectId}
                value={order?.id ?? ""}
                onChange={(e) => setSelected(e.target.value)}
              >
                {state.data.items.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.number}
                  </option>
                ))}
              </select>
            </div>
          )}
          {order && (
            <CancellationPanel key={order.id} client={client} order={order} />
          )}
          <div className="catalog-pagination">
            <Button
              variant="secondary"
              unavailable={offset === 0}
              onClick={() => {
                setSelected("");
                setOffset((n) => Math.max(0, n - 20));
              }}
            >
              Previous
            </Button>
            <span>Page {Math.floor(offset / 20) + 1}</span>
            <Button
              variant="secondary"
              unavailable={
                offset + 20 >= state.data.total || offset + 20 > 100000
              }
              onClick={() => {
                setSelected("");
                setOffset((n) => n + 20);
              }}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </Page>
  );
}
export function CancellationEntry() {
  const { user } = useAuth();
  if (
    !user ||
    user.mustChangePassword ||
    !user.companyId ||
    !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(user.role)
  )
    return (
      <Page
        title="Order cancellations"
        description="Sign in with a customer account to manage cancellation requests."
      >
        <Link to="/login">Sign in</Link>
      </Page>
    );
  return <Connected key={user.id + ":" + user.companyId} />;
}
