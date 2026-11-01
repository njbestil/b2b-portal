import { useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router";
import {
  canViewPage,
  isRole,
  type Role,
  workspacePages,
} from "./shell/navigation";
import {
  Dashboard,
  DesignSystem,
  FeaturePlaceholder,
  UnavailablePage,
} from "./shell/pages";
import { Brand, WorkspaceLayout } from "./shell/WorkspaceLayout";

function readPreference(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function savePreference(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* A blocked storage policy must not break the shell. */
  }
}

import { ApplicationPage } from "./features/customer-applications/ApplicationPage";
import { ApplicationReceiptPage } from "./features/customer-applications/ApplicationReceiptPage";
import {
  AuthProvider,
  useAuth,
  type PasswordFlows,
} from "./features/authentication/AuthContext";
import { AuthPage } from "./features/authentication/AuthPages";
import { SessionClient, type ApiRole } from "./features/authentication/session";

function PublicLayout({ application = false }: { application?: boolean }) {
  return (
    <div className="public-layout" data-application={application || undefined}>
      <aside className="public-brand">
        <Brand />
        <div>
          <p className="eyebrow">Built for UAE businesses</p>
          <p className="public-statement">
            Ordering that keeps your operation moving.
          </p>
          <p>
            Company-specific catalogues, agreed pricing, and one reliable place
            for every order.
          </p>
        </div>
        <small>Gulf Provision · Trade portal</small>
      </aside>
      <main id="main-content" className="public-main">
        <Outlet />
      </main>
    </div>
  );
}

export function App({
  initialRole,
  sessionClient,
  passwords,
}: {
  initialRole?: Role;
  sessionClient?: SessionClient;
  passwords?: PasswordFlows;
} = {}) {
  return (
    <AuthProvider client={sessionClient} passwords={passwords}>
      <AppRoutes initialRole={initialRole} />
    </AuthProvider>
  );
}
const roleNames: Record<ApiRole, Role> = {
  CUSTOMER_ADMIN: "Customer Admin",
  CUSTOMER_USER: "Customer User",
  INTERNAL_ADMIN: "Internal Admin",
  SALES_STAFF: "Sales Staff",
};
function AppRoutes({ initialRole }: { initialRole?: Role }) {
  const { user, client } = useAuth();
  const [previewRole, setRole] = useState<Role>(() => {
    const saved = readPreference("b2b-preview-role");
    return initialRole ?? (isRole(saved) ? saved : "Customer Admin");
  });
  const [dark, setDark] = useState(
    () => readPreference("b2b-preview-theme") === "dark",
  );
  const role = user ? roleNames[user.role] : previewRole;
  useEffect(() => {
    savePreference("b2b-preview-role", previewRole);
  }, [previewRole]);
  useEffect(() => {
    savePreference("b2b-preview-theme", dark ? "dark" : "light");
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  return (
    <Routes>
      <Route element={<PublicLayout application />}>
        <Route path="login" element={<AuthPage key="login" mode="login" />} />

        <Route
          path="forgot-password"
          element={<AuthPage key="forgot" mode="forgot" />}
        />
        <Route
          path="first-login"
          element={<AuthPage key="temporary" mode="temporary" />}
        />
        <Route
          path="reset-password"
          element={<AuthPage key="reset" mode="reset" />}
        />
      </Route>
      <Route element={<PublicLayout application />}>
        <Route path="apply" element={<ApplicationPage />} />
      </Route>
      <Route path="apply/received" element={<ApplicationReceiptPage />} />
      <Route
        element={
          user?.mustChangePassword ? (
            <Navigate to="/first-login" replace />
          ) : client.requiresLogin ? (
            <Navigate to="/login" replace />
          ) : (
            <WorkspaceLayout
              role={role}
              setRole={setRole}
              dark={dark}
              setDark={setDark}
              identity={user ?? undefined}
            />
          )
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        {workspacePages.map((page) => (
          <Route
            key={page.path}
            path={page.path}
            element={
              !canViewPage(role, page) ? (
                <UnavailablePage />
              ) : page.path === "/dashboard" ? (
                <Dashboard role={role} preview={!user} />
              ) : (
                <FeaturePlaceholder page={page} />
              )
            }
          />
        ))}
        <Route path="design-system" element={<DesignSystem />} />
        <Route path="*" element={<UnavailablePage notFound />} />
      </Route>
    </Routes>
  );
}
