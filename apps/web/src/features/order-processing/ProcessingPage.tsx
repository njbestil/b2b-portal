import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import "./processing.css";
import { Link } from "react-router";
import { Page } from "../../shell/pages";
import { Badge, Button } from "../../shared/ui";
import { Icon } from "../../shared/Icon";
import { RemoteModel, remoteMessage } from "../../shared/remote";
import { useAuth } from "../authentication/AuthContext";
import {
  ProcessingClient,
  type ProcessingAdapter,
  type ProcessingOrder,
} from "./api";

export function OrderProcessingStatus({ order }: { order: ProcessingOrder }) {
  return (
    <div className="processing-notice" role="status">
      <Icon name="pulse" />
      <div>
        <Badge tone={order.state.tone}>{order.state.title}</Badge>
        <p>{order.state.message}</p>
      </div>
    </div>
  );
}
export function ProcessingPage({ adapter }: { adapter: ProcessingAdapter }) {
  const [offset, setOffset] = useState(0),
    [reload, setReload] = useState(0),
    model = useMemo(
      () => new RemoteModel<{ items: ProcessingOrder[]; total: number }>(),
      [],
    ),
    { data, busy, error } = useSyncExternalStore(
      model.subscribe,
      model.snapshot,
      model.snapshot,
    );
  useEffect(() => {
    void model.load((signal) => adapter.list(offset, signal));
    return () => model.cancel();
  }, [adapter, model, offset, reload]);
  return (
    <Page
      title="Order processing"
      eyebrow="Order management"
      description="Check the latest update for your company’s submitted orders."
    >
      <div className="panel-head">
        <Link to="/orders">Back to drafts</Link>
        <Button
          variant="secondary"
          unavailable={busy}
          onClick={() => setReload((n) => n + 1)}
        >
          Check status
        </Button>
      </div>
      <p role="status">
        {busy
          ? "Loading submitted orders…"
          : data && !error
            ? "Order statuses updated."
            : ""}
      </p>
      <div role="alert">{error ? remoteMessage(error) : ""}</div>
      {!busy && data && (
        <section
          className="panel processing-list"
          aria-labelledby="submitted-orders-title"
        >
          <h2 id="submitted-orders-title">Submitted orders</h2>
          {!data.items.length && <p>No submitted orders on this page.</p>}
          {data.items.map((order) => (
            <article className="processing-order" key={order.id}>
              <h3>{order.number}</h3>
              <p>
                Created{" "}
                <time dateTime={order.createdAt}>
                  {new Date(order.createdAt).toLocaleDateString("en-AE")}
                </time>
              </p>
              <OrderProcessingStatus order={order} />
            </article>
          ))}
          <div className="catalog-pagination">
            <Button
              variant="secondary"
              unavailable={offset === 0 || busy}
              onClick={() => setOffset((n) => Math.max(0, n - 20))}
            >
              Previous
            </Button>
            <span>Page {Math.floor(offset / 20) + 1}</span>
            <Button
              variant="secondary"
              unavailable={
                offset + 20 >= data.total || offset + 20 > 100000 || busy
              }
              onClick={() => setOffset((n) => n + 20)}
            >
              Next
            </Button>
          </div>
        </section>
      )}
    </Page>
  );
}
function Connected() {
  const { client, user } = useAuth();
  const adapter = useMemo(
    () => new ProcessingClient(client, user!),
    [client, user],
  );
  return <ProcessingPage adapter={adapter} />;
}
export function ProcessingEntry() {
  const { user } = useAuth();
  if (
    !user ||
    user.mustChangePassword ||
    !user.companyId ||
    !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(user.role)
  )
    return (
      <Page
        title="Order processing"
        description="Sign in with a customer account to view order updates."
      >
        <Link to="/login">Sign in</Link>
      </Page>
    );
  return <Connected key={user.id + ":" + user.companyId} />;
}
