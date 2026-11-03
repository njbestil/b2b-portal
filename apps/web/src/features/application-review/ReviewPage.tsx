import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useAuth } from "../authentication/AuthContext";
import { Page } from "../../shell/pages";
import { Badge, Button } from "../../shared/ui";
import { RemoteFailure, useRemote } from "../../shared/remote-ui";
import {
  safeText,
  createApiTransport,
  type RemoteState,
} from "../../shared/remote";
import {
  ReviewClient,
  reviewHttpAdapter,
  type ReviewAdapter,
  type ReviewApplication,
} from "./api";
const labels = {
  companyName: "Legal / trade name",
  tradeLicenseReference: "Trade licence",
  businessEmail: "Business email",
  phone: "Phone",
  administratorName: "Proposed admin",
  administratorEmail: "Admin email",
  administratorMobile: "Admin mobile",
  billingAddress: "Billing address",
  deliveryAddress: "Delivery address",
  createdAt: "Submitted",
} as const;
export function ReviewDetail({
  state,
  reload,
  decide,
}: {
  state: RemoteState<ReviewApplication>;
  reload: () => void;
  decide: (decision: "approve" | "reject", reason: string) => void;
}) {
  const reasonId = useId(),
    summary = useRef<HTMLDivElement>(null),
    [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (invalid) summary.current?.focus();
  }, [invalid]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.busy || state.needsReload) return;
    const button = (event.nativeEvent as SubmitEvent).submitter;
    const decision =
      button instanceof HTMLButtonElement && button.value === "reject"
        ? "reject"
        : "approve";
    const reason = String(
      new FormData(event.currentTarget).get("reason") ?? "",
    );
    if (decision === "reject" && !safeText(reason.trim(), 1000)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    decide(decision, reason);
  }
  const app = state.data;
  return (
    <article className="panel account-form-card">
      <p role="status">
        {state.busy
          ? "Loading or saving application…"
          : state.saved
            ? "Decision saved by the server."
            : ""}
      </p>
      {state.error && (
        <RemoteFailure
          error={state.error}
          mutation={state.needsReload}
          reload={reload}
        />
      )}
      {app && (
        <>
          <div className="panel-head">
            <h2>{app.companyName}</h2>
            <Badge
              tone={
                app.status === "PENDING"
                  ? "warning"
                  : app.status === "APPROVED"
                    ? "success"
                    : "danger"
              }
            >
              {app.status === "PENDING"
                ? "Pending review"
                : app.status === "APPROVED"
                  ? "Approved"
                  : "Rejected"}
            </Badge>
          </div>
          <dl className="account-review-grid">
            {Object.entries(labels).map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{app[key as keyof typeof labels]}</dd>
              </div>
            ))}
          </dl>
          {app.status === "PENDING" ? (
            <form noValidate onSubmit={submit}>
              {invalid && (
                <div className="application-error" ref={summary} tabIndex={-1}>
                  <h3>Enter a rejection reason</h3>
                  <p>
                    Use a nonempty reason of at most 1,000 characters without
                    control characters.
                  </p>
                </div>
              )}
              <div className="field">
                <label htmlFor={reasonId}>
                  Rejection reason (required when rejecting)
                </label>
                <textarea
                  id={reasonId}
                  name="reason"
                  rows={3}
                  maxLength={1000}
                  disabled={state.busy}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? `${reasonId}-error` : undefined}
                />
                {invalid && (
                  <small id={`${reasonId}-error`}>
                    A valid reason is required to reject.
                  </small>
                )}
              </div>
              {state.needsReload && (
                <p>
                  Reload latest details before another decision. A previous
                  request may already be committed.
                </p>
              )}
              <div className="account-actions">
                <Button
                  type="submit"
                  variant="danger"
                  name="decision"
                  value="reject"
                >
                  Reject with reason
                </Button>
                <Button type="submit" name="decision" value="approve">
                  Approve application
                </Button>
              </div>
            </form>
          ) : (
            <div className="account-result">
              <h3>Recorded decision</h3>
              {app.rejectionReason && <p>Reason: {app.rejectionReason}</p>}
              <dl>
                <div>
                  <dt>Audit processing</dt>
                  <dd>{app.auditState}</dd>
                </div>
                <div>
                  <dt>In-app notification processing</dt>
                  <dd>{app.notificationState}</dd>
                </div>
              </dl>
              <p>
                Processing states are reported by the server. Unknown or pending
                does not mean a notification was delivered.
              </p>
            </div>
          )}
        </>
      )}
    </article>
  );
}
function Detail({
  client,
  companyId,
}: {
  client: ReviewClient;
  companyId: string;
}) {
  const read = useCallback(
    (signal: AbortSignal) => client.detail(companyId, signal),
    [client, companyId],
  );
  const { state, model, reload } = useRemote(read);
  return (
    <ReviewDetail
      state={state}
      reload={reload}
      decide={(decision, reason) => {
        void model.write((current, signal) =>
          client.decide(current, decision, reason, signal),
        );
      }}
    />
  );
}
function ReviewScreen({ adapter }: { adapter?: ReviewAdapter }) {
  const client = useMemo(() => new ReviewClient(adapter), [adapter]),
    { companyId } = useParams(),
    [params, setParams] = useSearchParams();
  const raw = params.get("offset") ?? "0",
    offset =
      /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : -1;
  const read = useCallback(
    (signal: AbortSignal) => client.list(offset, signal),
    [client, offset],
  );
  const { state, reload } = useRemote(read),
    data = state.data;
  return (
    <Page
      title="Application review"
      eyebrow="Customer onboarding"
      description="Verify submitted business details before approving access. Decisions and event processing are server controlled."
    >
      <div className="account-review-layout">
        {companyId ? (
          <Detail key={companyId} client={client} companyId={companyId} />
        ) : (
          <article className="panel account-form-card">
            <h2>Select an application</h2>
            <p>Choose an application from the review queue.</p>
          </article>
        )}
        <aside className="panel account-queue">
          <h2>Review queue</h2>
          <p role="status">
            {state.busy
              ? "Loading applications…"
              : data
                ? `${data.total} applications`
                : ""}
          </p>
          {state.error && <RemoteFailure error={state.error} reload={reload} />}
          {data?.total === 0 && <p>No applications to review.</p>}
          {data && (
            <>
              <ul>
                {data.items.map((app) => (
                  <li key={app.companyId}>
                    <Link
                      to={{
                        pathname: `/customer-applications/${app.companyId}`,
                        search: offset ? `?offset=${offset}` : "",
                      }}
                      aria-current={
                        companyId === app.companyId ? "page" : undefined
                      }
                    >
                      <strong>{app.companyName}</strong>
                      <span>
                        {app.status} · {app.createdAt}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {data.total > 0 && data.items.length === 0 && (
                <p>No applications on this page.</p>
              )}
              <div className="account-actions">
                <Button
                  variant="secondary"
                  unavailable={offset <= 0}
                  onClick={() =>
                    setParams(
                      offset > 20 ? { offset: String(offset - 20) } : {},
                    )
                  }
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  unavailable={
                    offset < 0 ||
                    offset > Number.MAX_SAFE_INTEGER - 20 ||
                    offset + 20 >= data.total
                  }
                  onClick={() => {
                    if (offset <= Number.MAX_SAFE_INTEGER - 20)
                      setParams({ offset: String(offset + 20) });
                  }}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </aside>
      </div>
    </Page>
  );
}
export function ApplicationReviewEntry({
  adapter,
}: {
  adapter?: ReviewAdapter;
}) {
  const { user, client } = useAuth();
  const liveAdapter = useMemo(
    () =>
      reviewHttpAdapter(
        createApiTransport((path, init) => client.request(path, init)),
        {
          list: "/api/v1/admin/applications",
          detail: (id) => `/api/v1/admin/applications/${id}`,
          decision: (id) => `/api/v1/admin/applications/${id}/decision`,
        },
      ),
    [client],
  );
  if (!user || user.mustChangePassword || user.role !== "INTERNAL_ADMIN")
    return (
      <Page
        title="Application review"
        eyebrow="Customer onboarding"
        description="Sign in with an authorized Internal Admin account to review applications."
      >
        <Link to="/login">Sign in</Link>
      </Page>
    );
  return <ReviewScreen key={user.id} adapter={adapter ?? liveAdapter} />;
}
