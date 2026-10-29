import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, NavLink, Outlet, useNavigate } from "react-router";
import { Icon } from "../shared/Icon";
import { Badge, Button } from "../shared/ui";
import {
  isRole,
  navigationFor,
  roleProfiles,
  roles,
  type Role,
} from "./navigation";

export function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link className="brand" to="/dashboard" onClick={onNavigate}>
      <span className="brand-mark" aria-hidden="true">
        GP
      </span>
      <span>
        <strong>Gulf Provision</strong>
        <small>Trade portal</small>
      </span>
    </Link>
  );
}

function SidebarContent({
  role,
  onNavigate,
}: {
  role: Role;
  onNavigate?: () => void;
}) {
  return (
    <>
      <Brand onNavigate={onNavigate} />
      <nav aria-label="Workspace">
        <p className="nav-label">Workspace</p>
        <ul>
          {navigationFor(role).map((page) => (
            <li key={page.path}>
              <NavLink to={page.path} end onClick={onNavigate}>
                <Icon name={page.icon} />
                {page.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="sidebar-bottom">
        <NavLink
          className="design-link"
          to="/design-system"
          end
          onClick={onNavigate}
        >
          <Icon name="grid" />
          Design system
        </NavLink>
        <div className="support-card">
          <Icon name="users" />
          <strong>Need help?</strong>
          <p>
            Your sales contact will appear here when account data is connected.
          </p>
        </div>
        <Link className="exit-link" to="/login" onClick={onNavigate}>
          <Icon name="logout" />
          Exit preview
        </Link>
      </div>
    </>
  );
}

export function WorkspaceLayout({
  role,
  setRole,
  dark,
  setDark,
}: {
  role: Role;
  setRole: (role: Role) => void;
  dark: boolean;
  setDark: (dark: boolean) => void;
}) {
  const navigate = useNavigate();
  const drawer = useRef<HTMLDialogElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const profile = roleProfiles[role];
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 50.01rem)");
    const closeOnDesktop = () => {
      if (desktop.matches) drawer.current?.close();
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside className="sidebar desktop-sidebar">
        <SidebarContent role={role} />
      </aside>
      <div className="workspace">
        <header className="workspace-header">
          <Button
            className="menu-button"
            variant="secondary"
            aria-label="Workspace menu"
            aria-expanded={menuOpen}
            aria-controls="mobile-workspace"
            onClick={() => {
              drawer.current?.showModal();
              setMenuOpen(true);
            }}
          >
            <Icon name="menu" />
          </Button>
          <div className="context">
            <span className="avatar" aria-hidden="true">
              {role.startsWith("Customer") ? "EO" : "GP"}
            </span>
            <span>
              <strong>{profile.company}</strong>
              <small>{role === "Sales Staff" ? "Sales workspace" : role}</small>
            </span>
          </div>
          <div className="header-actions">
            <label className="role-picker">
              <span>Preview role</span>
              <select
                value={role}
                onChange={(event) => {
                  if (isRole(event.target.value)) {
                    setRole(event.target.value);
                    navigate("/dashboard");
                  }
                }}
              >
                {roles.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <Button
              className="icon-button"
              variant="secondary"
              aria-label="Dark theme"
              aria-pressed={dark}
              onClick={() => setDark(!dark)}
            >
              <Icon name={dark ? "sun" : "moon"} />
            </Button>
            <Link
              className="icon-button"
              to="/notifications"
              aria-label="Notifications"
            >
              <Icon name="bell" />
            </Link>
            {role.startsWith("Customer") && (
              <Link
                className="button button-secondary order-link"
                to="/catalog"
              >
                <Icon name="cart" />
                Order
              </Link>
            )}
            <div className="profile">
              <span className="avatar" aria-hidden="true">
                {profile.initials}
              </span>
              <span>
                <strong>{profile.name}</strong>
                <small>{profile.subtitle}</small>
              </span>
            </div>
          </div>
        </header>
        <div className="preview-notice">
          <Badge tone="warning">Shell preview</Badge>
          <span>
            Sample personas only. Sign-in and business data are not connected.
          </span>
        </div>
        <main id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      {typeof document !== "undefined" &&
        createPortal(
          <dialog
            ref={drawer}
            id="mobile-workspace"
            className="mobile-drawer"
            aria-labelledby="drawer-heading"
            onClose={() => setMenuOpen(false)}
          >
            <h2 id="drawer-heading" className="visually-hidden">
              Workspace menu
            </h2>
            <Button
              className="drawer-close"
              variant="secondary"
              aria-label="Close workspace menu"
              onClick={() => drawer.current?.close()}
            >
              <Icon name="close" />
            </Button>
            <div className="sidebar">
              <SidebarContent
                role={role}
                onNavigate={() => drawer.current?.close()}
              />
            </div>
          </dialog>,
          document.body,
        )}
    </div>
  );
}
