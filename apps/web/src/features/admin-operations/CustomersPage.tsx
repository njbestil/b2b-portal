import { useCallback, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { Page } from "../../shell/pages";
import { Badge, Button } from "../../shared/ui";
import { RemoteError } from "../../shared/remote";
import { type AdminClient } from "./api";
import { AdminNavigation, Paging, ResourceStatus, useResource } from "./shared";
function AssignmentEditor({
  company,
  client,
}: {
  company: string;
  client: AdminClient;
}) {
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState(""),
    [validation, setValidation] = useState(""),
    select = useRef<HTMLSelectElement>(null),
    label = useId();
  const read = useCallback(
      async (s: AbortSignal) => {
        const [assignment, staff] = await Promise.all([
          client.assignment(company, s),
          client.staff(offset, s),
        ]);
        return { assignment, staff };
      },
      [client, company, offset],
    ),
    state = useResource(read);
  async function save() {
    if (
      !selected ||
      !state.data?.staff.items.some(
        (u) => u.id === selected && u.status === "ACTIVE",
      )
    ) {
      setValidation("Choose an active Sales Staff account from this page.");
      select.current?.focus();
      return;
    }
    setValidation("");
    await state.model.write(async (data, s) => ({
      ...data,
      assignment: await client.assign(
        company,
        selected,
        data.assignment?.id ?? null,
        s,
      ),
    }));
  }
  return (
    <section className="admin-ops-section" aria-labelledby={`${label}-heading`}>
      <h3 id={`${label}-heading`}>Primary Sales assignment</h3>
      <ResourceStatus state={state} />
      {state.data && !state.busy && (
        <>
          <p>
            Current Sales Staff ID:{" "}
            {state.data.assignment?.salesStaffUserId ?? "Unassigned"}
          </p>
          <p>
            One primary assignment per customer. Reassignment ends the previous
            assignment.
          </p>
          <label htmlFor={label}>New Sales Staff account</label>
          <select
            id={label}
            ref={select}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            aria-describedby={`${label}-error`}
          >
            <option value="">Choose an account</option>
            {state.data.staff.items
              .filter((u) => u.status === "ACTIVE")
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                  {u.mustChangePassword ? " · First login pending" : ""}
                </option>
              ))}
          </select>
          <p role="alert" id={`${label}-error`}>
            {validation}
          </p>
          <Paging
            offset={offset}
            total={state.data.staff.total}
            busy={state.busy}
            setOffset={(n) => {
              setOffset(n);
              setSelected("");
            }}
          />
          <Button
            unavailable={
              state.needsReload ||
              selected === state.data.assignment?.salesStaffUserId
            }
            onClick={() => void save()}
          >
            Save primary assignment
          </Button>
        </>
      )}
      <Button
        variant="secondary"
        unavailable={state.busy}
        onClick={state.refresh}
      >
        Refresh assignment
      </Button>
    </section>
  );
}
function CompanyDetails({
  id,
  client,
  onChanged,
}: {
  id: string;
  client: AdminClient;
  onChanged: () => void;
}) {
  const read = useCallback(
      async (s: AbortSignal) => {
        const [company, status] = await Promise.all([
          client.company(id, s),
          client.status("companies", id, s),
        ]);
        if (company.status !== status) throw new RemoteError("conflict");
        return { company, status };
      },
      [client, id],
    ),
    state = useResource(read),
    dialog = useRef<HTMLDialogElement>(null),
    title = useId();
  const next = state.data?.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
  async function change() {
    const saved = await state.model.write(async (data, s) => {
      const status = await client.changeCompany(id, data.status, next, s);
      return { company: { ...data.company, status }, status };
    });
    dialog.current?.close();
    if (saved) onChanged();
  }
  return (
    <article className="panel admin-ops-detail">
      <h2>Customer details</h2>
      <ResourceStatus state={state} />
      {state.data && !state.busy && (
        <>
          <h3>{state.data.company.legalName}</h3>
          <Badge tone="neutral">{state.data.status}</Badge>
          <dl>
            <dt>Trade name</dt>
            <dd>{state.data.company.tradeName}</dd>
            <dt>ERP customer reference</dt>
            <dd>{state.data.company.erpCustomerReference ?? "Unavailable"}</dd>
          </dl>
          <Link to={`/customers/${id}/company`}>Open company profile</Link>
          {["ACTIVE", "SUSPENDED"].includes(state.data.status) ? (
            <Button
              variant="secondary"
              unavailable={state.needsReload}
              onClick={() => dialog.current?.showModal()}
            >
              {next === "SUSPENDED"
                ? "Suspend customer"
                : "Reactivate customer"}
            </Button>
          ) : (
            <p>
              This lifecycle state cannot change here. Pending applications use
              application review.
            </p>
          )}
          <AssignmentEditor company={id} client={client} />
        </>
      )}
      <Button
        variant="secondary"
        unavailable={state.busy}
        onClick={state.refresh}
      >
        Refresh customer
      </Button>
      <dialog ref={dialog} className="admin-ops-dialog" aria-labelledby={title}>
        <h2 id={title}>
          {next === "SUSPENDED"
            ? "Suspend customer account?"
            : "Reactivate customer account?"}
        </h2>
        <p>{state.data?.company.legalName}</p>
        <p>
          {next === "SUSPENDED"
            ? "This denies company access and revokes its current sessions."
            : "Users will need a fresh sign-in. Existing first-login requirements still apply."}
        </p>
        <div className="admin-ops-actions">
          <Button variant="secondary" onClick={() => dialog.current?.close()}>
            Cancel
          </Button>
          <Button
            unavailable={state.busy || state.needsReload}
            onClick={() => void change()}
          >
            Confirm account change
          </Button>
        </div>
      </dialog>
    </article>
  );
}
export function CustomersPage({ client }: { client: AdminClient }) {
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<string | null>(null),
    read = useCallback(
      (s: AbortSignal) => client.companies(offset, s),
      [client, offset],
    ),
    state = useResource(read),
    current =
      state.data?.items.find((c) => c.id === selected)?.id ??
      state.data?.items[0]?.id;
  return (
    <Page
      title="Customer management"
      eyebrow="Customer accounts"
      description="Manage account status and primary Sales Staff assignments."
    >
      <AdminNavigation />
      <ResourceStatus state={state} />
      <Button
        variant="secondary"
        unavailable={state.busy}
        onClick={state.refresh}
      >
        Refresh customers
      </Button>
      {state.data && !state.busy && !state.error && (
        <>
          <section className="panel admin-ops-panel">
            <div className="admin-ops-table">
              <table>
                <caption>Customer directory</caption>
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col">ERP reference</th>
                    <th scope="col">Status</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.items.map((c) => (
                    <tr key={c.id}>
                      <th scope="row">
                        {c.legalName}
                        <small>{c.tradeName}</small>
                      </th>
                      <td>{c.erpCustomerReference ?? "Unavailable"}</td>
                      <td>
                        <Badge tone="neutral">{c.status}</Badge>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="button button-secondary"
                          aria-pressed={current === c.id}
                          onClick={() => setSelected(c.id)}
                        >
                          View {c.tradeName}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!state.data.items.length && <p>No customers on this page.</p>}
            <Paging
              offset={offset}
              total={state.data.total}
              busy={state.busy}
              setOffset={setOffset}
            />
          </section>
          {current && (
            <CompanyDetails
              key={current}
              id={current}
              client={client}
              onChanged={state.refresh}
            />
          )}
        </>
      )}
    </Page>
  );
}
