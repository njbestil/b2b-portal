import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, NavLink, useParams } from "react-router";
import { useAuth } from "../authentication/AuthContext";
import { Page } from "../../shell/pages";
import { Badge, Button, Field } from "../../shared/ui";
import { RemoteFailure, useRemote } from "../../shared/remote-ui";
import { RemoteError, type RemoteState } from "../../shared/remote";
import {
  CompanyClient,
  authenticatedCompanyAdapter,
  profileFields,
  profileInput,
  profileErrors,
  type CompanyAdapter,
  type CompanyProfile,
} from "./api";
export function CompanySections({ companyId }: { companyId?: string }) {
  const base = companyId ? `/customers/${companyId}` : "/company";
  return (
    <nav aria-label="Company sections" className="company-sections">
      <NavLink to={companyId ? `${base}/company` : base} end>
        Company profile
      </NavLink>
      <NavLink to={`${base}/addresses`}>Delivery addresses</NavLink>
    </nav>
  );
}
export function CompanyView({
  state,
  canEdit,
  reload,
  save,
}: {
  state: RemoteState<CompanyProfile>;
  canEdit: boolean;
  reload: () => void;
  save: (draft: Record<string, unknown>) => void;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({}),
    summary = useRef<HTMLDivElement>(null),
    result = useRef<HTMLParagraphElement>(null);
  const invalid = Object.keys(errors).length > 0;
  useEffect(() => {
    if (invalid) summary.current?.focus();
  }, [errors, invalid]);
  useEffect(() => {
    if (state.saved) result.current?.focus();
  }, [state.saved, state.data?.version]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.busy || state.needsReload || !canEdit) return;
    const data = new FormData(event.currentTarget),
      draft = Object.fromEntries(
        Object.keys(profileFields).map((key) => [
          key,
          String(data.get(key) ?? ""),
        ]),
      );
    try {
      profileInput(draft);
      setErrors({});
      save(draft);
    } catch {
      setErrors(profileErrors(draft));
    }
  }
  const profile = state.data;
  return (
    <>
      <p role="status" tabIndex={-1} ref={result}>
        {state.busy
          ? "Loading or saving company information…"
          : state.saved
            ? "Company changes saved by the server."
            : ""}
      </p>
      {state.error && (
        <RemoteFailure
          error={state.error}
          mutation={state.needsReload}
          reload={reload}
        />
      )}
      {!profile && !state.busy && !state.error && (
        <div className="panel account-form-card">
          <h2>No company information</h2>
          <p>Company details have not been supplied.</p>
        </div>
      )}
      {profile && (
        <div className="company-form-layout">
          <article className="panel account-form-card">
            <div className="panel-head">
              <div>
                <p className="eyebrow">Portal-managed</p>
                <h2>Contact information</h2>
              </div>
              <Badge tone={profile.status === "ACTIVE" ? "success" : "warning"}>
                {profile.status}
              </Badge>
            </div>
            {canEdit ? (
              <form
                key={JSON.stringify([profile.version, profile.portal])}
                noValidate
                onSubmit={submit}
              >
                {invalid && (
                  <div
                    className="application-error"
                    ref={summary}
                    tabIndex={-1}
                  >
                    <h3>Check company details</h3>
                    <p>
                      Enter a trading name and a valid business email when
                      supplied. Keep each value within the labelled limit.
                    </p>
                  </div>
                )}
                <fieldset disabled={state.busy} className="company-fields">
                  <legend className="visually-hidden">
                    Portal contact fields
                  </legend>
                  {Object.entries(profileFields).map(([key, definition]) => (
                    <Field
                      key={key}
                      label={definition.label}
                      name={key}
                      defaultValue={
                        profile.portal[key as keyof typeof profile.portal] ?? ""
                      }
                      maxLength={definition.limit}
                      required={key === "tradeName"}
                      type={
                        key === "businessEmail"
                          ? "email"
                          : key === "phone"
                            ? "tel"
                            : "text"
                      }
                      autoComplete={
                        key === "tradeName"
                          ? "organization"
                          : key === "businessEmail"
                            ? "email"
                            : key === "phone"
                              ? "tel"
                              : key === "primaryContact"
                                ? "name"
                                : "street-address"
                      }
                      aria-invalid={errors[key] ? true : undefined}
                      hint={
                        errors[key] ??
                        `${definition.limit} characters maximum${key === "tradeName" ? "." : "; optional, leave blank to clear."}`
                      }
                    />
                  ))}
                </fieldset>
                {state.needsReload && (
                  <p>Reload latest details before another save.</p>
                )}
                <Button type="submit">Save changes</Button>
              </form>
            ) : (
              <>
                <p>This company profile is view-only for this account.</p>
                <dl className="account-review-grid">
                  {Object.entries(profileFields).map(([key, definition]) => (
                    <div key={key}>
                      <dt>{definition.label}</dt>
                      <dd>
                        {profile.portal[key as keyof typeof profile.portal] ??
                          "Not supplied"}
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
            <dl className="account-review-grid">
              <div>
                <dt>Legal name</dt>
                <dd>{profile.legalName}</dd>
              </div>
              <div>
                <dt>Trade licence</dt>
                <dd>{profile.tradeLicenseReference ?? "Not supplied"}</dd>
              </div>
            </dl>
            <p>Trade-licence changes require Internal Admin review.</p>
          </article>
          <aside className="panel account-form-card company-commercial">
            <p className="eyebrow">ERP-owned · Read only</p>
            <h2>Commercial account</h2>
            <dl>
              {[
                ["ERP Customer ID", profile.commercial.erpCustomerReference],
                ["Payment terms", profile.commercial.paymentTerms],
                ["Credit status", profile.commercial.creditStatus],
                ["Credit limit", null],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value ?? "Not supplied"}</dd>
                </div>
              ))}
            </dl>
            <p>
              Commercial values are supplied by the ERP. Contact your assigned
              Sales Staff to discuss terms. No credit-limit source is connected.
            </p>
          </aside>
        </div>
      )}
    </>
  );
}
function CompanyScreen({
  client,
  companyId,
}: {
  client: CompanyClient;
  companyId?: string;
}) {
  const read = useCallback(
      (signal: AbortSignal) => client.read(signal),
      [client],
    ),
    { state, model, reload } = useRemote(read);
  return (
    <Page
      title={
        state.data?.portal.tradeName ||
        state.data?.legalName ||
        "Company profile"
      }
      eyebrow="Company management"
      description="Portal contact details and ERP-owned commercial information."
    >
      <CompanySections companyId={companyId} />
      <CompanyView
        state={state}
        canEdit={client.canEdit(state.data)}
        reload={reload}
        save={(draft) => {
          void model.write((current, signal) =>
            client.save(current, draft, signal),
          );
        }}
      />
    </Page>
  );
}
export function CompanyEntry({ adapter }: { adapter?: CompanyAdapter }) {
  const { user, client: session } = useAuth(),
    { scopedCompanyId } = useParams();
  const role = user?.role,
    companyId = user?.companyId ?? null,
    restricted = user?.mustChangePassword ?? true;
  const client = useMemo(() => {
    try {
      return role
        ? new CompanyClient(
            { role, companyId, mustChangePassword: restricted },
            adapter ?? authenticatedCompanyAdapter(session),
            scopedCompanyId,
          )
        : null;
    } catch (error) {
      if (!(error instanceof RemoteError)) throw error;
      return null;
    }
  }, [role, companyId, restricted, adapter, scopedCompanyId, session]);
  if (!client || !user)
    return (
      <Page
        title="Company profile"
        eyebrow="Company management"
        description="Sign in with an authorized company context to view these details."
      >
        <Link to="/login">Sign in</Link>
      </Page>
    );
  return (
    <CompanyScreen
      key={`${user.id}:${client.access.companyId}`}
      client={client}
      companyId={scopedCompanyId}
    />
  );
}
