import { useCallback, useId, useRef, useState } from "react";
import { Page } from "../../shell/pages";
import { Badge, Button, Field } from "../../shared/ui";
import type { AdminClient, Staff } from "./api";
import { AdminNavigation, Paging, ResourceStatus, useResource } from "./shared";
function StaffDetails({
  user,
  client,
  onChanged,
}: {
  user: Staff;
  client: AdminClient;
  onChanged: () => void;
}) {
  const read = useCallback(
      async (s: AbortSignal) => ({
        status: await client.status("users", user.id, s),
      }),
      [client, user.id],
    ),
    state = useResource(read),
    dialog = useRef<HTMLDialogElement>(null),
    [next, setNext] = useState<"ACTIVE" | "DEACTIVATED">("DEACTIVATED"),
    title = useId();
  async function change() {
    const saved = await state.model.write(async (data, s) => ({
      status: (await client.changeStaff(user.id, data.status, next, s)).status,
    }));
    dialog.current?.close();
    if (saved) onChanged();
  }
  return (
    <section className="panel admin-ops-detail">
      <h2>{user.displayName}</h2>
      <ResourceStatus state={state} />
      {state.data && !state.busy && (
        <>
          <p>Current account status: {state.data.status}</p>
          <p>
            {user.mustChangePassword
              ? "First-login password change required."
              : "First-login requirement complete."}
          </p>
          <p>
            Current assignments stay in history. Deactivation revokes current
            sessions; reactivation requires fresh sign-in.
          </p>
          {state.data.status !== "ACTIVE" && (
            <Button
              unavailable={state.needsReload}
              onClick={() => {
                setNext("ACTIVE");
                dialog.current?.showModal();
              }}
            >
              Activate Sales Staff
            </Button>
          )}
          {["ACTIVE", "SUSPENDED"].includes(state.data.status) && (
            <Button
              variant="danger"
              unavailable={state.needsReload}
              onClick={() => {
                setNext("DEACTIVATED");
                dialog.current?.showModal();
              }}
            >
              Deactivate Sales Staff
            </Button>
          )}
        </>
      )}
      <Button
        variant="secondary"
        unavailable={state.busy}
        onClick={state.refresh}
      >
        Refresh staff status
      </Button>
      <dialog ref={dialog} className="admin-ops-dialog" aria-labelledby={title}>
        <h2 id={title}>
          {next === "ACTIVE" ? "Activate" : "Deactivate"} Sales Staff account?
        </h2>
        <p>{user.displayName}</p>
        <div className="admin-ops-actions">
          <Button variant="secondary" onClick={() => dialog.current?.close()}>
            Cancel
          </Button>
          <Button
            unavailable={state.busy || state.needsReload}
            onClick={() => void change()}
          >
            Confirm staff change
          </Button>
        </div>
      </dialog>
    </section>
  );
}
function CreateStaff({
  client,
  onCreated,
}: {
  client: AdminClient;
  onCreated: () => Promise<boolean>;
}) {
  const read = useCallback(async () => ({ created: null as Staff | null }), []),
    state = useResource(read),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [validation, setValidation] = useState(""),
    form = useRef<HTMLFormElement>(null),
    heading = useId();
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (
      !name.trim() ||
      !email.trim() ||
      !password.length ||
      new TextEncoder().encode(password).byteLength > 1024
    ) {
      setValidation(
        "Enter name, business email and a temporary password up to 1,024 UTF-8 bytes.",
      );
      form.current?.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    setValidation("");
    const saved = await state.model.write(async (_data, s) => ({
      created: await client.createStaff(
        { displayName: name, email, temporaryPassword: password },
        s,
      ),
    }));
    setPassword("");
    if (saved) {
      setName("");
      setEmail("");
      await onCreated();
    }
  }
  return (
    <section className="panel admin-ops-panel" aria-labelledby={heading}>
      <h2 id={heading}>Create Sales Staff account</h2>
      <p>
        Supply a private temporary credential and hand it to the recipient
        through your approved channel. Their first login requires a password
        change.
      </p>
      <ResourceStatus state={state} />
      {state.data?.created && (
        <p>Created account ID: {state.data.created.id}</p>
      )}
      <form ref={form} onSubmit={(e) => void create(e)}>
        <Field
          label="Display name"
          required
          maxLength={160}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label="Business email"
          type="email"
          required
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Temporary password"
          type="password"
          autoComplete="new-password"
          required
          maxLength={1024}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p role="alert">{validation}</p>
        <Button type="submit" unavailable={state.busy || state.needsReload}>
          Create account
        </Button>
      </form>
      {state.needsReload && (
        <p>
          Check the directory for an existing account before starting another
          creation attempt.
        </p>
      )}
      <Button
        variant="secondary"
        unavailable={state.busy}
        onClick={() => {
          void onCreated().then((confirmed) => {
            if (confirmed) state.refresh();
          });
        }}
      >
        Check directory before another creation
      </Button>
    </section>
  );
}
export function StaffPage({ client }: { client: AdminClient }) {
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<string | null>(null),
    read = useCallback(
      (s: AbortSignal) => client.staff(offset, s),
      [client, offset],
    ),
    state = useResource(read),
    current =
      state.data?.items.find((u) => u.id === selected) ?? state.data?.items[0];
  return (
    <Page
      title="Sales Staff"
      eyebrow="Internal user management"
      description="Manage Sales Staff access and one primary assignment per customer."
    >
      <AdminNavigation />
      <ResourceStatus state={state} />
      <Button
        variant="secondary"
        unavailable={state.busy}
        onClick={state.refresh}
      >
        Refresh Sales Staff
      </Button>
      {state.data && !state.busy && !state.error && (
        <>
          <section className="panel admin-ops-panel">
            <div className="admin-ops-table">
              <table>
                <caption>Sales Staff directory</caption>
                <thead>
                  <tr>
                    <th scope="col">Staff member</th>
                    <th scope="col">Status</th>
                    <th scope="col">First login</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.items.map((u) => (
                    <tr key={u.id}>
                      <th scope="row">
                        {u.displayName}
                        <small>{u.email ?? "Email unavailable"}</small>
                      </th>
                      <td>
                        <Badge tone="neutral">{u.status}</Badge>
                      </td>
                      <td>{u.mustChangePassword ? "Required" : "Complete"}</td>
                      <td>
                        <button
                          type="button"
                          className="button button-secondary"
                          aria-pressed={current?.id === u.id}
                          onClick={() => setSelected(u.id)}
                        >
                          Manage {u.displayName}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!state.data.items.length && <p>No Sales Staff on this page.</p>}
            <Paging
              offset={offset}
              total={state.data.total}
              busy={state.busy}
              setOffset={setOffset}
            />
          </section>
          {current && (
            <StaffDetails
              key={current.id}
              user={current}
              client={client}
              onChanged={state.refresh}
            />
          )}
        </>
      )}
      <CreateStaff
        client={client}
        onCreated={async () => {
          await state.model.load(read);
          return !state.model.snapshot().error;
        }}
      />
    </Page>
  );
}
