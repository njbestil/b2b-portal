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
import { LogoutButton } from "./features/authentication/LogoutButton";
import { SessionClient, type ApiRole } from "./features/authentication/session";
import { DraftEntry } from "./features/order-drafts/DraftPage";
import { CatalogEntry } from "./features/catalog/CatalogPage";
import type { CatalogAdapter } from "./features/catalog/api";
import { ApplicationReviewEntry } from "./features/application-review/ReviewPage";
import type { ReviewAdapter } from "./features/application-review/api";
import { CompanyEntry } from "./features/company-profile/CompanyPage";
import type { CompanyAdapter } from "./features/company-profile/api";
import { AddressEntry } from "./features/delivery-addresses/AddressPage";
import type { AddressAdapter } from "./features/delivery-addresses/api";

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
  catalog,
  applicationReview,
  companyProfile,
  deliveryAddresses,
}: {
  initialRole?: Role;
  sessionClient?: SessionClient;
  passwords?: PasswordFlows;
  catalog?: CatalogAdapter;
  applicationReview?: ReviewAdapter;
  companyProfile?: CompanyAdapter;
  deliveryAddresses?: AddressAdapter;
} = {}) {
  return (
    <AuthProvider client={sessionClient} passwords={passwords}>
      <AppRoutes
        initialRole={initialRole}
        catalog={catalog}
        applicationReview={applicationReview}
        companyProfile={companyProfile}
        deliveryAddresses={deliveryAddresses}
      />
    </AuthProvider>
  );
}
const roleNames: Record<ApiRole, Role> = {
  CUSTOMER_ADMIN: "Customer Admin",
  CUSTOMER_USER: "Customer User",
  INTERNAL_ADMIN: "Internal Admin",
  SALES_STAFF: "Sales Staff",
};
function AppRoutes({
  initialRole,
  catalog,
  applicationReview,
  companyProfile,
  deliveryAddresses,
}: {
  initialRole?: Role;
  catalog?: CatalogAdapter;
  applicationReview?: ReviewAdapter;
  companyProfile?: CompanyAdapter;
  deliveryAddresses?: AddressAdapter;
}) {
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
          ) : client.requiresLogin || (!user && initialRole === undefined) ? (
            <Navigate to="/login" replace />
          ) : (
            <WorkspaceLayout
              role={role}
              setRole={setRole}
              dark={dark}
              setDark={setDark}
              identity={user ?? undefined}
              accountAction={user ? <LogoutButton /> : undefined}
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
              ) : page.path === "/orders" &&
                (role === "Customer Admin" || role === "Customer User") ? (
                <DraftEntry />
              ) : page.path === "/catalog" ? (
                <CatalogEntry adapter={catalog} />
              ) : page.path === "/customer-applications" ? (
                <ApplicationReviewEntry adapter={applicationReview} />
              ) : page.path === "/company" ? (
                <CompanyEntry adapter={companyProfile} />
              ) : (
                <FeaturePlaceholder page={page} />
              )
            }
          />
        ))}
        <Route
          path="customer-applications/:companyId"
          element={<ApplicationReviewEntry adapter={applicationReview} />}
        />
        <Route
          path="catalog/:productId"
          element={<CatalogEntry adapter={catalog} />}
        />
        <Route path="design-system" element={<DesignSystem />} />
        <Route
          path="company/addresses"
          element={<AddressEntry adapter={deliveryAddresses} />}
        />
        <Route
          path="customers/:scopedCompanyId/addresses"
          element={<AddressEntry adapter={deliveryAddresses} />}
        />
        <Route
          path="customers/:scopedCompanyId/company"
          element={<CompanyEntry adapter={companyProfile} />}
        />
        <Route path="*" element={<UnavailablePage notFound />} />
      </Route>
    </Routes>
  );
}
