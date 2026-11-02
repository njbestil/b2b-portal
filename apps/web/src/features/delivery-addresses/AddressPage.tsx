import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useParams } from "react-router";
import { useAuth } from "../authentication/AuthContext";
import { CompanySections } from "../company-profile/CompanyPage";
import { Page } from "../../shell/pages";
import { Badge, Button, Field } from "../../shared/ui";
import { RemoteFailure, useRemote } from "../../shared/remote-ui";
import { RemoteError, type RemoteState } from "../../shared/remote";
import {
  AddressClient,
  addressErrors,
  addressFields,
  addressInput,
  type AddressAdapter,
  type AddressCollection,
  type DeliveryAddress,
} from "./api";
type Editor =
  { kind: "create" } | { kind: "update" | "deactivate"; id: string };
export function AddressEditor({
  current,
  busy,
  commit,
  cancel,
}: {
  current?: DeliveryAddress;
  busy: boolean;
  commit: (
    draft: Record<string, unknown>,
    makeDefault: boolean,
  ) => Promise<void>;
  cancel: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null),
    summary = useRef<HTMLDivElement>(null),
    checkId = useId(),
    [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    if (Object.keys(errors).length) summary.current?.focus();
  }, [errors]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget),
      draft = Object.fromEntries(
        Object.keys(addressFields).map((key) => [
          key,
          String(data.get(key) ?? ""),
        ]),
      ),
      invalid = addressErrors(draft);
    if (Object.keys(invalid).length) {
      setErrors(invalid);
      return;
    }
    addressInput(draft);
    setErrors({});
    await commit(draft, data.get("makeDefault") === "on");
  }
  const values = {
    label: current?.label,
    line1: current?.address.line1,
    contactName: current?.contactName,
    contactPhone: current?.contactPhone,
  };
  return (
    <section
      className="panel account-form-card address-editor"
      aria-labelledby={`${checkId}-heading`}
    >
      <h2 id={`${checkId}-heading`} ref={heading} tabIndex={-1}>
        {current ? "Edit delivery address" : "Add delivery address"}
      </h2>
      <form noValidate onSubmit={submit}>
        {Object.keys(errors).length > 0 && (
          <div className="application-error" tabIndex={-1} ref={summary}>
            <h3>Check address details</h3>
            <p>Correct the highlighted fields.</p>
          </div>
        )}
        <fieldset disabled={busy} className="company-fields">
          <legend className="visually-hidden">Delivery address details</legend>
          {Object.entries(addressFields).map(([key, definition]) => (
            <Field
              key={key}
              name={key}
              label={definition.label}
              defaultValue={values[key as keyof typeof values] ?? ""}
              required={definition.required}
              maxLength={definition.limit}
              type={key === "contactPhone" ? "tel" : "text"}
              autoComplete={
                key === "line1"
                  ? "street-address"
                  : key === "contactName"
                    ? "name"
                    : key === "contactPhone"
                      ? "tel"
                      : "off"
              }
              aria-invalid={errors[key] ? true : undefined}
              hint={
                errors[key] ??
                `${definition.limit} characters maximum${definition.required ? "." : "; optional."}`
              }
            />
          ))}
          {!current && (
            <div>
              <input id={checkId} type="checkbox" name="makeDefault" />
              <label htmlFor={checkId}>Make this the default address</label>
            </div>
          )}
        </fieldset>
        <div className="account-actions">
          <Button type="submit">Save address</Button>
          <Button variant="secondary" unavailable={busy} onClick={cancel}>
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}
export function DeactivateAddress({
  current,
  choices,
  busy,
  commit,
  cancel,
}: {
  current: DeliveryAddress;
  choices: DeliveryAddress[];
  busy: boolean;
  commit: (replacementId: string | null) => Promise<void>;
  cancel: () => void;
}) {
  const selectId = useId(),
    heading = useRef<HTMLHeadingElement>(null),
    summary = useRef<HTMLDivElement>(null),
    [invalid, setInvalid] = useState(0);
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    if (invalid) summary.current?.focus();
  }, [invalid]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const choice = String(
      new FormData(event.currentTarget).get("replacement") ?? "",
    );
    if (
      current.isDefault &&
      choice !== "clear" &&
      !choices.some(
        (item) => item.id === choice && item.active && item.id !== current.id,
      )
    ) {
      setInvalid((n) => n + 1);
      return;
    }
    await commit(current.isDefault && choice !== "clear" ? choice : null);
  }
  return (
    <section
      className="panel account-form-card address-editor"
      aria-labelledby={`${selectId}-heading`}
    >
      <h2 id={`${selectId}-heading`} tabIndex={-1} ref={heading}>
        Deactivate {current.label}
      </h2>
      <p>
        This preserves the address and historical order references. It becomes
        unavailable for new selections.
      </p>
      <form noValidate onSubmit={submit}>
        {invalid > 0 && (
          <div className="application-error" tabIndex={-1} ref={summary}>
            <h3>Choose default handling</h3>
            <p>
              Explicitly clear the default or choose another active address.
            </p>
          </div>
        )}
        {current.isDefault && (
          <div className="field">
            <label htmlFor={selectId}>Default replacement</label>
            <select
              id={selectId}
              name="replacement"
              defaultValue=""
              disabled={busy}
              required
              aria-invalid={invalid > 0 || undefined}
              aria-describedby={`${selectId}-hint`}
            >
              <option value="">Choose how to handle the default</option>
              <option value="clear">Clear default without replacement</option>
              {choices
                .filter((item) => item.active && item.id !== current.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
            </select>
            <small id={`${selectId}-hint`}>
              No address will be chosen automatically.
            </small>
          </div>
        )}
        <div className="account-actions">
          <Button variant="danger" type="submit">
            Confirm deactivation
          </Button>
          <Button variant="secondary" unavailable={busy} onClick={cancel}>
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}
export function AddressView({
  state,
  canManage,
  canSelect,
  canInspectInactive,
  reload,
  open,
  activate,
  setDefault,
  select,
}: {
  state: RemoteState<AddressCollection>;
  canManage: boolean;
  canSelect: boolean;
  canInspectInactive: boolean;
  reload: () => void;
  open: (editor: Editor, button: HTMLButtonElement) => void;
  activate: (id: string) => void;
  setDefault: (id: string) => void;
  select: (id: string) => DeliveryAddress;
}) {
  const groupId = useId(),
    summary = useRef<HTMLDivElement>(null),
    [showInactive, setShowInactive] = useState(false),
    [choice, setChoice] = useState(""),
    [picked, setPicked] = useState<string | null>(null),
    [invalid, setInvalid] = useState(0);
  useEffect(() => {
    if (invalid) summary.current?.focus();
  }, [invalid]);
  const data = state.data,
    active = data?.items.filter((item) => item.active) ?? [],
    visible =
      data?.items.filter(
        (item) => item.active || (canInspectInactive && showInactive),
      ) ?? [];
  const selected = active.some((item) => item.id === choice)
      ? choice
      : (active.find((item) => item.isDefault)?.id ?? ""),
    confirmed = active.find((item) => item.id === picked);
  function choose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.busy || state.needsReload) return;
    try {
      const value = select(
        String(new FormData(event.currentTarget).get("addressId") ?? ""),
      );
      setPicked(value.id);
      setInvalid(0);
    } catch {
      setInvalid((n) => n + 1);
    }
  }
  return (
    <>
      <p role="status">
        {state.busy
          ? "Loading or saving addresses…"
          : state.saved
            ? "The server confirmed the address change."
            : ""}
      </p>
      {state.error && (
        <RemoteFailure
          error={state.error}
          mutation={state.needsReload}
          reload={reload}
        />
      )}
      {data && (
        <>
          <div className="address-toolbar">
            <p>
              {canInspectInactive
                ? `${data.items.length} addresses supplied · ${active.length} active`
                : `${active.length} active delivery addresses`}
            </p>
            {canInspectInactive && (
              <label>
                <input
                  type="checkbox"
                  checked={showInactive}
                  onChange={(event) => setShowInactive(event.target.checked)}
                />{" "}
                Show inactive addresses
              </label>
            )}
            {canManage && (
              <Button
                unavailable={state.busy || state.needsReload}
                onClick={(event) =>
                  open({ kind: "create" }, event.currentTarget)
                }
              >
                Add delivery address
              </Button>
            )}
          </div>
          {active.length === 0 && (
            <div className="panel account-form-card">
              <h2>No active delivery addresses</h2>
              <p>
                Ordering requires a valid active address.{" "}
                {canManage
                  ? "Add or activate an address to continue."
                  : "Contact your company administrator."}
              </p>
            </div>
          )}
          {invalid > 0 && (
            <div className="application-error" ref={summary} tabIndex={-1}>
              <h2>Select an active address</h2>
              <p>Reload if the address is no longer available.</p>
            </div>
          )}
          <form onSubmit={choose}>
            <fieldset className="address-choices" disabled={state.busy}>
              <legend className="visually-hidden">
                Existing delivery addresses
              </legend>
              <div className="address-card-grid">
                {visible.map((item) => (
                  <article className="panel account-form-card" key={item.id}>
                    <Badge
                      tone={
                        item.isDefault
                          ? "success"
                          : item.active
                            ? "info"
                            : "neutral"
                      }
                    >
                      {item.isDefault
                        ? "Default"
                        : item.active
                          ? "Active"
                          : "Inactive"}
                    </Badge>
                    <h2>{item.label}</h2>
                    <p>{item.address.line1}</p>
                    <p className="address-contact">
                      {item.contactName ?? "Contact not supplied"} ·{" "}
                      {item.contactPhone ?? "Phone not supplied"}
                    </p>
                    {canSelect && item.active && (
                      <label htmlFor={`${groupId}-${item.id}`}>
                        <input
                          id={`${groupId}-${item.id}`}
                          name="addressId"
                          type="radio"
                          value={item.id}
                          checked={selected === item.id}
                          onChange={() => setChoice(item.id)}
                        />{" "}
                        Select {item.label}
                      </label>
                    )}
                  </article>
                ))}
              </div>
            </fieldset>
            {canSelect && active.length > 0 && (
              <Button type="submit">Use selected address on this screen</Button>
            )}
          </form>
          {canManage && visible.length > 0 && (
            <section
              className="panel account-form-card"
              aria-labelledby={`${groupId}-manage`}
            >
              <h2 id={`${groupId}-manage`}>Manage addresses</h2>
              <ul className="address-management">
                {visible.map((item) => (
                  <li key={item.id}>
                    <strong>{item.label}</strong>
                    <div className="account-actions">
                      <Button
                        variant="secondary"
                        unavailable={state.busy || state.needsReload}
                        onClick={(event) =>
                          open(
                            { kind: "update", id: item.id },
                            event.currentTarget,
                          )
                        }
                      >
                        Edit
                        <span className="visually-hidden"> {item.label}</span>
                      </Button>
                      {!item.active ? (
                        <Button
                          variant="secondary"
                          unavailable={state.busy || state.needsReload}
                          onClick={() => activate(item.id)}
                        >
                          Activate
                          <span className="visually-hidden"> {item.label}</span>
                        </Button>
                      ) : (
                        <>
                          {!item.isDefault && (
                            <Button
                              variant="secondary"
                              unavailable={state.busy || state.needsReload}
                              onClick={() => setDefault(item.id)}
                            >
                              Set default
                              <span className="visually-hidden">
                                {" "}
                                {item.label}
                              </span>
                            </Button>
                          )}
                          <Button
                            variant="danger"
                            unavailable={state.busy || state.needsReload}
                            onClick={(event) =>
                              open(
                                { kind: "deactivate", id: item.id },
                                event.currentTarget,
                              )
                            }
                          >
                            Deactivate
                            <span className="visually-hidden">
                              {" "}
                              {item.label}
                            </span>
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p role="status">
            {confirmed
              ? `Selected on this screen: ${confirmed.label}. No order was changed; ordering must revalidate this address.`
              : ""}
          </p>
        </>
      )}
    </>
  );
}
function AddressScreen({
  client,
  companyId,
}: {
  client: AddressClient;
  companyId?: string;
}) {
  const read = useCallback(
      (signal: AbortSignal) => client.read(signal),
      [client],
    ),
    { state, model, reload } = useRemote(read),
    [editor, setEditor] = useState<Editor | null>(null),
    returnFocus = useRef<HTMLButtonElement | null>(null);
  const current =
    editor && editor.kind !== "create"
      ? state.data?.items.find((item) => item.id === editor.id)
      : undefined;
  const close = () => {
    setEditor(null);
    returnFocus.current?.focus();
  };
  async function commit(draft: Record<string, unknown>, makeDefault: boolean) {
    if (!editor) return;
    const saved = await model.write((collection, signal) =>
      editor.kind === "create"
        ? client.create(collection, draft, makeDefault, signal)
        : client.update(collection, editor.id, draft, signal),
    );
    if (saved) close();
  }
  return (
    <Page
      title="Delivery addresses"
      eyebrow="Company management"
      description="Manage portal-owned delivery locations or select an existing active address."
    >
      <CompanySections companyId={companyId} />
      <AddressView
        state={state}
        canManage={client.access.canEdit}
        canSelect={client.access.canSelect}
        canInspectInactive={client.canInspectInactive}
        reload={() => {
          close();
          reload();
        }}
        open={(value, button) => {
          returnFocus.current = button;
          setEditor(value);
        }}
        activate={(id) => {
          void model.write((collection, signal) =>
            client.activate(collection, id, signal),
          );
        }}
        setDefault={(id) => {
          void model.write((collection, signal) =>
            client.setDefault(collection, id, signal),
          );
        }}
        select={(id) => {
          if (!state.data) throw new RemoteError("not-found");
          return client.select(state.data, id);
        }}
      />
      {editor &&
        client.access.canEdit &&
        (editor.kind === "deactivate" && current ? (
          <DeactivateAddress
            key={`${current.id}:${state.data?.version}`}
            current={current}
            choices={state.data?.items ?? []}
            busy={state.busy || state.needsReload}
            cancel={close}
            commit={async (replacement) => {
              const saved = await model.write((collection, signal) =>
                client.deactivate(collection, current.id, replacement, signal),
              );
              if (saved) close();
            }}
          />
        ) : (
          (editor.kind === "create" || current) && (
            <AddressEditor
              key={editor.kind === "create" ? "create" : current?.id}
              current={current}
              busy={state.busy || state.needsReload}
              commit={commit}
              cancel={close}
            />
          )
        ))}
    </Page>
  );
}
export function AddressEntry({ adapter }: { adapter?: AddressAdapter }) {
  const { user } = useAuth(),
    { scopedCompanyId } = useParams(),
    role = user?.role,
    companyId = user?.companyId ?? null,
    restricted = user?.mustChangePassword ?? true;
  const client = useMemo(() => {
    try {
      return role
        ? new AddressClient(
            { role, companyId, mustChangePassword: restricted },
            adapter,
            scopedCompanyId,
          )
        : null;
    } catch (error) {
      if (!(error instanceof RemoteError)) throw error;
      return null;
    }
  }, [role, companyId, restricted, adapter, scopedCompanyId]);
  if (!client || !user)
    return (
      <Page
        title="Delivery addresses"
        eyebrow="Company management"
        description="Sign in with an authorized company context to view active delivery addresses."
      >
        <Link to="/login">Sign in</Link>
      </Page>
    );
  return (
    <AddressScreen
      key={`${user.id}:${client.access.companyId}`}
      client={client}
      companyId={scopedCompanyId}
    />
  );
}
