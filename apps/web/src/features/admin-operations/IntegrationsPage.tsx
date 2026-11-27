import { useCallback, useId, useRef, useState } from "react";
import { Page } from "../../shell/pages";
import { Badge, Button, Field } from "../../shared/ui";
import {
  type AdminClient,
  type Filters,
  type Transaction,
  integrationStatuses,
  monitorQuery,
  canRequestRetry,
} from "./api";
import {
  AdminNavigation,
  Paging,
  ResourceStatus,
  useResource,
  recordedDate,
} from "./shared";
export function TransactionDetails({ row }: { row: Transaction }) {
  return (
    <>
      <h2>Transaction {row.id}</h2>
      <Badge
        tone={
          row.status === "SUCCESS"
            ? "success"
            : row.status === "FAILED"
              ? "danger"
              : "neutral"
        }
      >
        {row.status}
      </Badge>
      <dl className="admin-ops-fields">
        <dt>Company ID</dt>
        <dd>{row.companyId}</dd>
        <dt>Order ID</dt>
        <dd>{row.orderId}</dd>
        <dt>Operation</dt>
        <dd>{row.operation}</dd>
        <dt>Retry count</dt>
        <dd>{row.retryCount}</dd>
        <dt>Next retry recorded</dt>
        <dd>
          {row.nextRetryAt ? recordedDate(row.nextRetryAt) : "None recorded"}
        </dd>
        <dt>Last updated</dt>
        <dd>{recordedDate(row.updatedAt)}</dd>
        <dt>Error category</dt>
        <dd>{row.errorCode ?? "None recorded"}</dd>
      </dl>
      <p>
        Technical state is separate from order business state. No automatic
        recovery or ERP acceptance is implied by a retry command.
      </p>
    </>
  );
}
function Details({ id, client }: { id: string; client: AdminClient }) {
  const read = useCallback(
      (s: AbortSignal) => client.transaction(id, s),
      [client, id],
    ),
    state = useResource(read),
    dialog = useRef<HTMLDialogElement>(null),
    title = useId();
  async function retry() {
    await state.model.write(async (row, s) => {
      await client.retry(row, s);
      return client.transaction(id, s);
    });
    dialog.current?.close();
  }
  return (
    <article className="panel admin-ops-detail">
      <ResourceStatus state={state} />
      {state.data && !state.busy && (
        <>
          <TransactionDetails row={state.data} />
          {canRequestRetry(state.data) ? (
            <Button
              variant="secondary"
              unavailable={state.needsReload}
              onClick={() => dialog.current?.showModal()}
            >
              Request one ERP retry
            </Button>
          ) : (
            <p>
              A manual retry is unavailable for this recorded state. Unknown,
              business-rejected, accepted or in-flight outcomes must not be
              replayed.
            </p>
          )}
        </>
      )}
      <Button
        variant="secondary"
        unavailable={state.busy}
        onClick={state.refresh}
      >
        Refresh transaction
      </Button>
      <dialog ref={dialog} className="admin-ops-dialog" aria-labelledby={title}>
        <h2 id={title}>Request one further ERP attempt?</h2>
        <p>
          The server will verify the retained request, current authority,
          outcome and version. An uncertain response requires a fresh read and
          may require reconciliation.
        </p>
        <div className="admin-ops-actions">
          <Button variant="secondary" onClick={() => dialog.current?.close()}>
            Cancel
          </Button>
          <Button
            unavailable={state.busy || state.needsReload}
            onClick={() => void retry()}
          >
            Confirm retry request
          </Button>
        </div>
      </dialog>
    </article>
  );
}
const empty: Filters = { q: "", status: "", companyId: "", orderId: "" };
export function IntegrationsPage({ client }: { client: AdminClient }) {
  const [draft, setDraft] = useState<Filters>(empty),
    [filters, setFilters] = useState<Filters>(empty),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<string | null>(null),
    [validation, setValidation] = useState(""),
    error = useRef<HTMLDivElement>(null),
    statusId = useId(),
    read = useCallback(
      (s: AbortSignal) => client.transactions(filters, offset, s),
      [client, filters, offset],
    ),
    state = useResource(read),
    current =
      state.data?.items.find((t) => t.id === selected)?.id ??
      state.data?.items[0]?.id;
  function apply(e: React.FormEvent) {
    e.preventDefault();
    try {
      monitorQuery(draft, 0);
      setValidation("");
      setOffset(0);
      setFilters({ ...draft });
      setSelected(null);
    } catch {
      setValidation(
        "Use a valid status and UUID identifiers; search supports letters, digits, spaces, hyphens and underscores, up to 128 characters.",
      );
      error.current?.focus();
    }
  }
  return (
    <Page
      title="Integration monitoring"
      eyebrow="ERP synchronization"
      description="Inspect retained handoffs and explicitly retry eligible technical failures."
    >
      <AdminNavigation />
      <form className="admin-ops-filters" onSubmit={apply}>
        <Field
          label="Search transaction or order"
          maxLength={128}
          value={draft.q}
          onChange={(e) => setDraft({ ...draft, q: e.target.value })}
        />
        <div className="field">
          <label htmlFor={statusId}>Integration status</label>
          <select
            id={statusId}
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          >
            <option value="">All statuses</option>
            {integrationStatuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Company ID"
          maxLength={36}
          value={draft.companyId}
          onChange={(e) => setDraft({ ...draft, companyId: e.target.value })}
        />
        <Field
          label="Order ID"
          maxLength={36}
          value={draft.orderId}
          onChange={(e) => setDraft({ ...draft, orderId: e.target.value })}
        />
        <Button type="submit">Apply filters</Button>
      </form>
      <div role="alert" ref={error} tabIndex={-1}>
        {validation}
      </div>
      <ResourceStatus state={state} />
      <Button
        variant="secondary"
        unavailable={state.busy}
        onClick={state.refresh}
      >
        Refresh transactions
      </Button>
      {state.data && !state.busy && !state.error && (
        <>
          <section className="panel admin-ops-panel">
            <div className="admin-ops-table">
              <table>
                <caption>Integration transactions</caption>
                <thead>
                  <tr>
                    <th scope="col">Transaction</th>
                    <th scope="col">Order</th>
                    <th scope="col">Status</th>
                    <th scope="col">Retry count</th>
                    <th scope="col">Last updated</th>
                    <th scope="col">Error category</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.items.map((t) => (
                    <tr key={t.id}>
                      <th scope="row">
                        {t.id}
                        <small>{t.operation}</small>
                      </th>
                      <td>{t.orderId}</td>
                      <td>
                        <Badge
                          tone={t.status === "FAILED" ? "danger" : "neutral"}
                        >
                          {t.status}
                        </Badge>
                      </td>
                      <td>{t.retryCount}</td>
                      <td>{recordedDate(t.updatedAt)}</td>
                      <td>{t.errorCode ?? "None recorded"}</td>
                      <td>
                        <button
                          type="button"
                          className="button button-secondary"
                          aria-pressed={current === t.id}
                          onClick={() => setSelected(t.id)}
                        >
                          Inspect {t.id.slice(0, 8)}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!state.data.items.length && (
              <p>No transactions match on this page.</p>
            )}
            <Paging
              offset={offset}
              total={state.data.total}
              busy={state.busy}
              setOffset={setOffset}
            />
          </section>
          {current && <Details key={current} id={current} client={client} />}
        </>
      )}
    </Page>
  );
}
