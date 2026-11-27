import { useCallback, useMemo } from "react";
import { Page } from "../../shell/pages";
import { Button, Badge } from "../../shared/ui";
import { useAuth } from "../authentication/AuthContext";
import { AdminClient, type Diagnostics } from "./api";
import { CustomersPage } from "./CustomersPage";
import { StaffPage } from "./StaffPage";
import { IntegrationsPage } from "./IntegrationsPage";
import { AdminNavigation, ResourceStatus, useResource } from "./shared";
import "./admin.css";
export function DiagnosticsSummary({ report }: { report: Diagnostics }) {
  return (
    <div className="admin-ops-health">
      {[
        {
          name: "Selected storage",
          provider: report.storage.provider,
          status: report.storage.status,
        },
        {
          name: "PostgreSQL connection",
          provider: report.database.configured
            ? "Configured"
            : "Not configured",
          status: report.database.status,
        },
        {
          name: "ERP connection",
          provider: report.erp.provider ?? "Not configured",
          status: report.erp.status,
        },
      ].map((row) => (
        <section key={row.name} className="panel admin-ops-panel">
          <h2>{row.name}</h2>
          <p>{row.provider}</p>
          <Badge
            tone={
              row.status === "up"
                ? "success"
                : row.status === "down" || row.status === "timeout"
                  ? "danger"
                  : "neutral"
            }
          >
            {row.status.replaceAll("_", " ")}
          </Badge>
        </section>
      ))}
    </div>
  );
}
function DiagnosticsPage({ client }: { client: AdminClient }) {
  const read = useCallback((s: AbortSignal) => client.diagnostics(s), [client]),
    state = useResource(read);
  return (
    <Page
      title="System diagnostics"
      eyebrow="Platform operations"
      description="Check the selected storage, database connection and ERP probe."
    >
      <AdminNavigation />
      <ResourceStatus state={state} />
      <Button
        variant="secondary"
        unavailable={state.busy}
        onClick={state.refresh}
      >
        Run diagnostics
      </Button>
      {state.data && !state.busy && !state.error && (
        <DiagnosticsSummary report={state.data} />
      )}
      <p>
        Probe results describe current connectivity and readiness. They do not
        change the selected storage provider or confirm a business operation.
      </p>
    </Page>
  );
}
export type AdminView = "customers" | "staff" | "integrations" | "diagnostics";
function Connected({ view }: { view: AdminView }) {
  const { client, user } = useAuth(),
    adapter = useMemo(() => new AdminClient(client, user!), [client, user]);
  return view === "customers" ? (
    <CustomersPage client={adapter} />
  ) : view === "staff" ? (
    <StaffPage client={adapter} />
  ) : view === "integrations" ? (
    <IntegrationsPage client={adapter} />
  ) : (
    <DiagnosticsPage client={adapter} />
  );
}
export function AdminEntry({ view }: { view: AdminView }) {
  const { user } = useAuth();
  if (
    !user ||
    user.mustChangePassword ||
    user.role !== "INTERNAL_ADMIN" ||
    user.companyId !== null
  )
    return (
      <Page
        title="Admin operations"
        description="Sign in with a normal Internal Admin account."
      >
        <p>Administrative data is unavailable in this workspace.</p>
      </Page>
    );
  return <Connected key={`${user.id}:${view}`} view={view} />;
}
