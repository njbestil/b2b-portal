import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { RemoteModel, remoteMessage } from "../../shared/remote";
import { Button } from "../../shared/ui";
export function useResource<T>(read: (signal: AbortSignal) => Promise<T>) {
  const model = useMemo(() => new RemoteModel<T>(), []),
    state = useSyncExternalStore(
      model.subscribe,
      model.snapshot,
      model.snapshot,
    );
  useEffect(() => {
    void model.load(read);
    return () => model.cancel();
  }, [model, read]);
  return { ...state, model, refresh: () => void model.load(read) };
}
export function ResourceStatus({
  state,
}: {
  state: ReturnType<RemoteModel<unknown>["snapshot"]>;
}) {
  return (
    <>
      <p role="status">
        {state.busy
          ? "Loading or saving…"
          : state.saved
            ? "Operation confirmed. Review the current record."
            : ""}
      </p>
      <div role="alert">
        {state.error ? remoteMessage(state.error, state.needsReload) : ""}
      </div>
    </>
  );
}
export function AdminNavigation() {
  return (
    <nav className="admin-ops-links" aria-label="Operations">
      <Link to="/customers">Customers</Link>
      <Link to="/sales-staff">Sales Staff</Link>
      <Link to="/erp-integrations">ERP integrations</Link>
      <Link to="/operations/diagnostics">System diagnostics</Link>
      <Link to="/customer-applications">Applications</Link>
    </nav>
  );
}
export function Paging({
  offset,
  total,
  busy,
  setOffset,
}: {
  offset: number;
  total: number;
  busy: boolean;
  setOffset: (offset: number) => void;
}) {
  return (
    <div className="catalog-pagination">
      <Button
        variant="secondary"
        unavailable={busy || offset === 0}
        onClick={() => setOffset(Math.max(0, offset - 20))}
      >
        Previous
      </Button>
      <span>
        Page {Math.floor(offset / 20) + 1} · {total} records
      </span>
      <Button
        variant="secondary"
        unavailable={busy || offset + 20 >= total || offset + 20 > 100000}
        onClick={() => setOffset(offset + 20)}
      >
        Next
      </Button>
    </div>
  );
}
export const recordedDate = (v: string) => (
  <time dateTime={v}>{new Date(v).toLocaleString("en-AE")}</time>
);
