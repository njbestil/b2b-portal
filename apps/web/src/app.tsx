import { useEffect, useState } from "react";
import { Link, Navigate, Outlet, Route, Routes } from "react-router";
import { Badge } from "./shared/ui";
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
  Page,
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

function PublicLayout() {
  return (
    <div className="public-layout">
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

function PublicPlaceholder({ title }: { title: string }) {
  return (
    <Page
      title={title}
      eyebrow="Business customer portal"
      description="Account access is coming in the authentication and onboarding issues."
    >
      <Badge tone="warning">Shell preview</Badge>
      <p>No credentials or applications are collected by this shell.</p>
      <Link className="button button-primary" to="/dashboard">
        Explore workspace preview
      </Link>
      <nav aria-label="Account access">
        <Link to="/login">Sign in</Link>
        <Link to="/apply">Apply for an account</Link>
        <Link to="/forgot-password">Forgot password?</Link>
      </nav>
    </Page>
  );
}

export function App({ initialRole }: { initialRole?: Role } = {}) {
  const [role, setRole] = useState<Role>(() => {
    const saved = readPreference("b2b-preview-role");
    return initialRole ?? (isRole(saved) ? saved : "Customer Admin");
  });
  const [dark, setDark] = useState(
    () => readPreference("b2b-preview-theme") === "dark",
  );
  useEffect(() => {
    savePreference("b2b-preview-role", role);
  }, [role]);
  useEffect(() => {
    savePreference("b2b-preview-theme", dark ? "dark" : "light");
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route
          path="login"
          element={<PublicPlaceholder title="Welcome back" />}
        />
        <Route
          path="apply"
          element={<PublicPlaceholder title="Apply for an account" />}
        />
        <Route
          path="forgot-password"
          element={<PublicPlaceholder title="Forgot your password?" />}
        />
      </Route>
      <Route
        element={
          <WorkspaceLayout
            role={role}
            setRole={setRole}
            dark={dark}
            setDark={setDark}
          />
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
                <Dashboard role={role} />
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
