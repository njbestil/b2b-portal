import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { Link } from "react-router";
import { useAuth } from "../authentication/AuthContext";
import { Page } from "../../shell/pages";
import { Badge, Button, Field } from "../../shared/ui";
import { RemoteModel, remoteMessage } from "../../shared/remote";
import {
  HistoryClient,
  emptyFilters,
  historyQuery,
  historyStatuses,
  statusNames,
  type HistoryDetail,
} from "./api";
import "./history.css";
const date = (value: string) => new Date(value).toLocaleString("en-AE");
export function OrderTimeline({ order }: { order: HistoryDetail }) {
  return (
    <section
      className="history-timeline"
      aria-labelledby="history-timeline-title"
    >
      <h3 id="history-timeline-title">Order status</h3>
      <ol>
        <li>
          <strong>Created</strong>
          <time dateTime={order.createdAt}>{date(order.createdAt)}</time>
        </li>
        {order.snapshot && (
          <li aria-current={order.status === "SUBMITTED" ? "step" : undefined}>
            <strong>Submitted</strong>
            <time dateTime={order.snapshot.submittedAt}>
              {date(order.snapshot.submittedAt)}
            </time>
          </li>
        )}
        {(!order.snapshot || order.status !== "SUBMITTED") && (
          <li aria-current="step">
            <strong>{statusNames[order.status]}</strong>
            <small>No time recorded for this update.</small>
          </li>
        )}
      </ol>
      <p>
        Only recorded dates are shown. Other transition times and delivery
        estimates are unavailable.
      </p>
    </section>
  );
}
export function OrderHistoryDetails({ order }: { order: HistoryDetail }) {
  const s = order.snapshot;
  return (
    <>
      <div className="history-title">
        <Badge tone={order.state.tone}>{statusNames[order.status]}</Badge>
        <h2>{order.number}</h2>
        <p>
          Created{" "}
          <time dateTime={order.createdAt}>{date(order.createdAt)}</time>
        </p>
      </div>
      <div className="history-notice">
        <strong>{order.state.title}</strong>
        <p>{order.state.message}</p>
      </div>
      <OrderTimeline order={order} />
      {s ? (
        <>
          <dl className="history-meta">
            <div>
              <dt>Submitted by</dt>
              <dd>{s.submittedBy}</dd>
            </div>
            <div>
              <dt>Delivery</dt>
              <dd>
                {s.delivery.label}
                <br />
                {s.delivery.line1}
                {s.delivery.contactName && (
                  <>
                    <br />
                    {s.delivery.contactName}
                  </>
                )}
                {s.delivery.contactPhone && (
                  <>
                    <br />
                    {s.delivery.contactPhone}
                  </>
                )}
              </dd>
            </div>
          </dl>
          <div className="history-table">
            <table>
              <caption>Items at submission</caption>
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Quantity / UOM</th>
                  <th scope="col">MOQ</th>
                  <th scope="col">Unit price</th>
                  <th scope="col">Line total</th>
                </tr>
              </thead>
              <tbody>
                {s.items.map((i) => (
                  <tr key={i.id}>
                    <th scope="row">
                      {i.name}
                      <small>{i.sku}</small>
                    </th>
                    <td>
                      {i.quantity} {i.uom}
                    </td>
                    <td>
                      {i.moq} {i.uom}
                    </td>
                    <td>
                      {s.currency} {i.unitPrice}
                    </td>
                    <td>
                      {s.currency} {i.lineTotal}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="history-total">
            Order total{" "}
            <strong>
              {s.currency} {s.total}
            </strong>
          </p>
        </>
      ) : (
        <p>
          Submitted item and delivery details are unavailable for this order.
        </p>
      )}
    </>
  );
}
function Detail({ client, id }: { client: HistoryClient; id: string }) {
  const model = useMemo(
      () => new RemoteModel<{ order: HistoryDetail; draftId?: string }>(),
      [],
    ),
    state = useSyncExternalStore(
      model.subscribe,
      model.snapshot,
      model.snapshot,
    ),
    [reordered, setReordered] = useState(""),
    [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    void model.load((s) => client.find(id, s));
    return () => model.cancel();
  }, [client, id, model]);
  async function reorder() {
    if (
      await model.write(async (data, signal) => ({
        ...data,
        draftId: await client.reorder(id, signal),
      }))
    ) {
      setReordered(model.snapshot().data!.draftId!);
    } else if (model.snapshot().needsReload) setUncertain(true);
  }
  return (
    <article className="panel history-detail">
      <p role="status">{state.busy ? "Loading or updating order…" : ""}</p>
      <div role="alert">
        {state.error ? remoteMessage(state.error, uncertain) : ""}
      </div>
      <div className="history-actions">
        <Button
          variant="secondary"
          unavailable={state.busy}
          onClick={() => void model.load((s) => client.find(id, s))}
        >
          Refresh order
        </Button>
        <Link to="/orders/cancellations">Manage cancellations</Link>
        {state.data?.order.status === "PENDING_CUSTOMER_CONFIRMATION" && (
          <Link to={`/orders/confirmations/${id}`}>
            Review customer confirmation
          </Link>
        )}
        {reordered ? (
          <Link to={"/orders?draft=" + reordered}>Open new draft</Link>
        ) : uncertain ? (
          <Link to="/orders">Check your drafts before another reorder</Link>
        ) : (
          state.data && (
            <Button
              variant="secondary"
              unavailable={state.busy || state.needsReload}
              onClick={() => void reorder()}
            >
              Reorder as new draft
            </Button>
          )
        )}
      </div>
      {state.data && <OrderHistoryDetails order={state.data.order} />}
      <p className="history-reorder-note">
        Reorders create a new draft. Review current prices, availability, MOQ
        and account eligibility before submission.
      </p>
    </article>
  );
}
function Connected() {
  const { client: session, user } = useAuth(),
    client = useMemo(() => new HistoryClient(session, user!), [session, user]),
    model = useMemo(
      () => new RemoteModel<Awaited<ReturnType<HistoryClient["list"]>>>(),
      [],
    ),
    state = useSyncExternalStore(
      model.subscribe,
      model.snapshot,
      model.snapshot,
    ),
    [fields, setFields] = useState({ ...emptyFilters }),
    [query, setQuery] = useState({
      filters: { ...emptyFilters },
      offset: 0,
      revision: 0,
    }),
    [selected, setSelected] = useState(""),
    [invalid, setInvalid] = useState(""),
    error = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void model.load((s) => client.list(query.filters, query.offset, s));
    return () => model.cancel();
  }, [client, model, query]);
  function apply(e: FormEvent) {
    e.preventDefault();
    try {
      historyQuery(fields, 0);
      setInvalid("");
      setSelected("");
      setQuery((q) => ({
        filters: { ...fields },
        offset: 0,
        revision: q.revision + 1,
      }));
    } catch {
      setInvalid("Check the search text, status and date range.");
      requestAnimationFrame(() => error.current?.focus());
    }
  }
  const current =
    state.data?.items.find((r) => r.id === selected) ?? state.data?.items[0];
  return (
    <Page
      title="Company orders"
      eyebrow="Order management"
      description="Track and review orders across your company."
    >
      <div className="history-actions">
        <Link to="/orders">Drafts and new orders</Link>
        <Link to="/orders/processing">Check processing</Link>
      </div>
      <form className="history-filters" onSubmit={apply} noValidate>
        <Field
          label="Search by order number"
          value={fields.search}
          maxLength={128}
          onChange={(e) => setFields((f) => ({ ...f, search: e.target.value }))}
        />
        <Field
          label="From (UTC)"
          type="date"
          value={fields.from}
          onChange={(e) => setFields((f) => ({ ...f, from: e.target.value }))}
        />
        <Field
          label="To (UTC)"
          type="date"
          value={fields.to}
          onChange={(e) => setFields((f) => ({ ...f, to: e.target.value }))}
        />
        <label className="field">
          Order status
          <select
            value={fields.status}
            onChange={(e) =>
              setFields((f) => ({ ...f, status: e.target.value }))
            }
          >
            <option value="all">All statuses</option>
            {historyStatuses.map((s) => (
              <option key={s} value={s}>
                {statusNames[s]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit">Apply filters</Button>
      </form>
      <div tabIndex={-1} ref={error}>
        {invalid && <p>{invalid}</p>}
      </div>
      <p role="status">
        {state.busy
          ? "Loading company history…"
          : state.data
            ? state.data.total + " orders match these filters."
            : ""}
      </p>
      <div role="alert">{state.error ? remoteMessage(state.error) : ""}</div>
      <Button
        variant="secondary"
        unavailable={state.busy}
        onClick={() => setQuery((q) => ({ ...q, revision: q.revision + 1 }))}
      >
        Refresh history
      </Button>
      {!state.busy && state.data && (
        <>
          <div className="history-layout">
            <section
              className="panel history-list"
              aria-labelledby="history-list-title"
            >
              <h2 id="history-list-title">Orders</h2>
              {!state.data.items.length && <p>No orders match on this page.</p>}
              <ul>
                {state.data.items.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      aria-pressed={o.id === current?.id}
                      onClick={() => setSelected(o.id)}
                    >
                      <span>
                        <strong>{o.number}</strong>
                        <small>{date(o.createdAt)}</small>
                      </span>
                      <Badge tone={o.state.tone}>{statusNames[o.status]}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            {current ? (
              <Detail key={current.id} client={client} id={current.id} />
            ) : (
              <article className="panel">
                <h2>Order details</h2>
                <p>Select an available order to view its details.</p>
              </article>
            )}
          </div>
          <div className="catalog-pagination">
            <Button
              variant="secondary"
              unavailable={query.offset === 0}
              onClick={() => {
                setSelected("");
                setQuery((q) => ({ ...q, offset: Math.max(0, q.offset - 20) }));
              }}
            >
              Previous
            </Button>
            <span>Page {Math.floor(query.offset / 20) + 1}</span>
            <Button
              variant="secondary"
              unavailable={
                query.offset + 20 >= state.data.total ||
                query.offset + 20 > 100000
              }
              onClick={() => {
                setSelected("");
                setQuery((q) => ({ ...q, offset: q.offset + 20 }));
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
export function HistoryEntry() {
  const { user } = useAuth();
  if (
    !user ||
    user.mustChangePassword ||
    !user.companyId ||
    !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(user.role)
  )
    return (
      <Page
        title="Company orders"
        description="Sign in with a customer account to view company order history."
      >
        <Link to="/login">Sign in</Link>
      </Page>
    );
  return <Connected key={user.id + ":" + user.companyId} />;
}
