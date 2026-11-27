import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Page } from "../../shell/pages";
import { Badge, Button } from "../../shared/ui";
import { RemoteError, RemoteModel, remoteMessage } from "../../shared/remote";
import { useAuth } from "../authentication/AuthContext";
import { InvoiceClient, type Invoice, type InvoiceAdapter } from "./api";
import "./invoices.css";
const date = (value: string) => (
  <time dateTime={value}>{new Date(value).toLocaleDateString("en-AE")}</time>
);
export function InvoiceDetails({ invoice }: { invoice: Invoice }) {
  return (
    <>
      <h2>Invoice {invoice.invoiceNumber}</h2>
      <Badge tone="info">Available</Badge>
      <dl className="invoice-details">
        <dt>Order reference</dt>
        <dd>{invoice.orderId}</dd>
        <dt>Issued</dt>
        <dd>{date(invoice.issuedAt)}</dd>
        <dt>Last updated</dt>
        <dd>{date(invoice.syncedAt)}</dd>
        <dt>Amount</dt>
        <dd>
          {invoice.currency} {invoice.amount}
        </dd>
      </dl>
      <p>
        Mock document · Synthetic demonstration only. No financial authority.
      </p>
    </>
  );
}
function Detail({ id, adapter }: { id: string; adapter: InvoiceAdapter }) {
  const model = useMemo(() => new RemoteModel<Invoice>(), []),
    state = useSyncExternalStore(
      model.subscribe,
      model.snapshot,
      model.snapshot,
    );
  const controller = useRef<AbortController | null>(null),
    [download, setDownload] = useState(""),
    [downloading, setDownloading] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    void model.load((s) => adapter.find(id, s));
    return () => {
      model.cancel();
      controller.current?.abort();
    };
  }, [id, adapter, model, reload]);
  async function save() {
    if (downloading) return;
    const current = new AbortController();
    controller.current?.abort();
    controller.current = current;
    setDownloading(true);
    setDownload("");
    try {
      const result = await adapter.download(id, current.signal);
      if (current.signal.aborted) return;
      const url = URL.createObjectURL(
        new Blob([result.text], { type: "text/plain;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownload("Download ready. Check your browser downloads.");
    } catch (error) {
      if (!current.signal.aborted)
        setDownload(
          remoteMessage(
            error instanceof RemoteError
              ? error
              : new RemoteError("unavailable"),
          ),
        );
    } finally {
      if (!current.signal.aborted) setDownloading(false);
    }
  }
  return (
    <section className="panel invoice-detail" aria-label="Selected invoice">
      <p role="status">{state.busy ? "Loading invoice…" : ""}</p>
      <div role="alert">{state.error ? remoteMessage(state.error) : ""}</div>
      {state.data && !state.busy && !state.error && (
        <>
          <InvoiceDetails invoice={state.data} />
          <Button
            unavailable={!state.data.documentAvailable || downloading}
            onClick={() => void save()}
          >
            {downloading
              ? "Preparing download…"
              : "Download mock document (.txt)"}
          </Button>
          {!state.data.documentAvailable && <p>Document unavailable.</p>}
        </>
      )}
      <p role="status">{download}</p>
      <Button
        variant="secondary"
        unavailable={state.busy || downloading}
        onClick={() => setReload((n) => n + 1)}
      >
        Refresh invoice
      </Button>
    </section>
  );
}
export function InvoicePage({ adapter }: { adapter: InvoiceAdapter }) {
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<string | null>(null),
    [reload, setReload] = useState(0),
    model = useMemo(
      () => new RemoteModel<{ items: Invoice[]; total: number }>(),
      [],
    ),
    state = useSyncExternalStore(
      model.subscribe,
      model.snapshot,
      model.snapshot,
    );
  useEffect(() => {
    void model.load((s) => adapter.list(offset, s));
    return () => model.cancel();
  }, [adapter, model, offset, reload]);
  const current =
    state.data?.items.find((v) => v.id === selected)?.id ??
    state.data?.items[0]?.id;
  return (
    <Page
      title="Invoices"
      eyebrow="Your account"
      description="View your company’s issued invoices and download mock documents."
    >
      <div className="panel-head">
        <Badge tone="neutral">Read only · ERP</Badge>
        <Button
          variant="secondary"
          unavailable={state.busy}
          onClick={() => setReload((n) => n + 1)}
        >
          Refresh invoices
        </Button>
      </div>
      <p role="status">
        {state.busy
          ? "Loading invoices…"
          : state.data
            ? `${state.data.total} invoices available.`
            : ""}
      </p>
      <div role="alert">{state.error ? remoteMessage(state.error) : ""}</div>
      {state.data && !state.busy && !state.error && (
        <>
          <section className="panel invoice-list" aria-label="Company invoices">
            <div className="invoice-table">
              <table>
                <caption>Issued invoices</caption>
                <thead>
                  <tr>
                    <th scope="col">Invoice</th>
                    <th scope="col">Order reference</th>
                    <th scope="col">Date</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Status</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.items.map((v) => (
                    <tr key={v.id}>
                      <th scope="row">{v.invoiceNumber}</th>
                      <td>{v.orderId}</td>
                      <td>{date(v.issuedAt)}</td>
                      <td>
                        {v.currency} {v.amount}
                      </td>
                      <td>
                        <Badge tone="info">Available</Badge>
                      </td>
                      <td>
                        <button
                          className="button button-secondary"
                          aria-pressed={current === v.id}
                          onClick={() => setSelected(v.id)}
                        >
                          View {v.invoiceNumber}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!state.data.items.length && <p>No invoices on this page.</p>}
            <div className="catalog-pagination">
              <Button
                variant="secondary"
                unavailable={offset === 0}
                onClick={() => setOffset((n) => Math.max(0, n - 20))}
              >
                Previous
              </Button>
              <span>Page {Math.floor(offset / 20) + 1}</span>
              <Button
                variant="secondary"
                unavailable={
                  offset + 20 >= state.data.total || offset + 20 > 100000
                }
                onClick={() => setOffset((n) => n + 20)}
              >
                Next
              </Button>
            </div>
          </section>
          {current && <Detail key={current} id={current} adapter={adapter} />}
        </>
      )}
    </Page>
  );
}
function Connected() {
  const { client, user } = useAuth();
  const adapter = useMemo(
    () => new InvoiceClient(client, user!),
    [client, user],
  );
  return <InvoicePage adapter={adapter} />;
}
export function InvoiceEntry() {
  const { user } = useAuth();
  if (
    !user ||
    user.mustChangePassword ||
    !user.companyId ||
    !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(user.role)
  )
    return (
      <Page
        title="Invoices"
        description="Sign in with a normal customer account to view company invoices."
      >
        <p>Invoice data is unavailable in this workspace.</p>
      </Page>
    );
  return <Connected key={`${user.id}:${user.companyId}`} />;
}
