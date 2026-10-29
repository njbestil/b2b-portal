import { useEffect, useRef, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { Icon } from "../shared/Icon";
import { Badge, Button, Field } from "../shared/ui";
import { navigationFor, type Role, type WorkspacePage } from "./navigation";

export function Page({
  title,
  description,
  eyebrow = "Workspace",
  children,
}: {
  title: string;
  description: string;
  eyebrow?: string;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { key } = useLocation();
  useEffect(() => {
    document.title = `${title} · Gulf Provision`;
    heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [title, key]);
  return (
    <div className="page">
      <div className="welcome">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1 ref={heading} tabIndex={-1}>
            {title}
          </h1>
          <p>{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

export function Dashboard({ role }: { role: Role }) {
  const pages = navigationFor(role).filter(
    (page) => page.path !== "/dashboard",
  );
  const customer = role.startsWith("Customer");
  return (
    <Page
      title="Dashboard"
      eyebrow="Workspace overview"
      description={
        customer
          ? "Here’s what’s happening with your company account."
          : role === "Sales Staff"
            ? "Here’s the latest across your assigned accounts."
            : "Here’s today’s platform operations workspace."
      }
    >
      <div className="foundation-metrics">
        <article className="panel metric">
          <span className="symbol">
            <Icon name="shield" />
          </span>
          <div>
            <small>Preview role</small>
            <strong>{role}</strong>
            <small>Design-reference persona</small>
          </div>
        </article>
        <article className="panel metric">
          <span className="symbol symbol-info">
            <Icon name="grid" />
          </span>
          <div>
            <small>Workspace</small>
            <strong>{pages.length + 1} destinations</strong>
            <small>Role-aware navigation</small>
          </div>
        </article>
        <article className="panel metric">
          <span className="symbol symbol-warm">
            <Icon name="box" />
          </span>
          <div>
            <small>Implementation stage</small>
            <strong>Foundation</strong>
            <small>Business data not connected</small>
          </div>
        </article>
      </div>
      <div className="dashboard-grid">
        <section className="panel" aria-labelledby="workspace-heading">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Explore your workspace</p>
              <h2 id="workspace-heading">Workspace destinations</h2>
            </div>
            <Badge>Shell preview</Badge>
          </div>
          <ul className="destination-list">
            {pages.map((page) => (
              <li key={page.path}>
                <Link to={page.path}>
                  <span className="symbol">
                    <Icon name={page.icon} />
                  </span>
                  <span>
                    <strong>{page.label}</strong>
                    <small>{page.description}</small>
                  </span>
                  <Icon name="arrow" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <section
          className="panel foundation-card"
          aria-labelledby="foundation-heading"
        >
          <p className="eyebrow">Built on a shared foundation</p>
          <h2 id="foundation-heading">A consistent trade experience</h2>
          <p>
            Forest and sand tones, calm surfaces, and clear navigation from the
            supplied Gulf Provision design.
          </p>
          <ul>
            <li>Light and dark themes</li>
            <li>Responsive workspace layouts</li>
            <li>Keyboard-accessible components</li>
          </ul>
          <Link className="button button-secondary" to="/design-system">
            Explore design system <Icon name="arrow" />
          </Link>
        </section>
      </div>
    </Page>
  );
}

export function FeaturePlaceholder({ page }: { page: WorkspacePage }) {
  return (
    <Page title={page.title} description={page.description}>
      <section className="panel empty-state" aria-labelledby="feature-heading">
        <span className="symbol">
          <Icon name={page.icon} />
        </span>
        <Badge>Foundation preview</Badge>
        <h2 id="feature-heading">
          {page.label} workspace is ready for its feature
        </h2>
        <p>
          This route establishes the layout and navigation only. Business data
          and actions will be connected in their own issues.
        </p>
        <Link className="button button-secondary" to="/dashboard">
          Back to dashboard
        </Link>
      </section>
    </Page>
  );
}

export function UnavailablePage({ notFound = false }: { notFound?: boolean }) {
  return (
    <Page
      title={notFound ? "Page not found" : "Page unavailable for this role"}
      description={
        notFound
          ? "This address does not match a portal page."
          : "Choose a destination in your workspace, or change the preview role."
      }
    >
      <div className="panel empty-state">
        <Icon name="shield" />
        <p>
          {notFound
            ? "Check the address or return to your dashboard."
            : "This is a frontend preview restriction, not a substitute for server-side authorization."}
        </p>
        <Link className="button button-primary" to="/dashboard">
          Back to dashboard
        </Link>
      </div>
    </Page>
  );
}

export function DesignSystem() {
  return (
    <Page
      title="Gulf Provision design system"
      eyebrow="Foundations & components"
      description="Primitive and semantic tokens for a consistent, accessible B2B experience."
    >
      <div className="design-modes">
        {(["light", "dark"] as const).map((theme) => (
          <section
            key={theme}
            className="panel design-board"
            data-theme={theme}
            aria-labelledby={`${theme}-heading`}
          >
            <h2 id={`${theme}-heading`}>
              {theme === "light" ? "Light mode" : "Dark mode"}
            </h2>
            <p>Semantic surfaces and content</p>
            <div className="swatches" aria-label="Core palette">
              <span className="swatch forest-dark">Forest 900</span>
              <span className="swatch forest">Forest 700</span>
              <span className="swatch sand">Sand 500</span>
            </div>
            <div className="component-row">
              <Button>Primary action</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="danger">Destructive</Button>
              <Button variant="quiet">Quiet action</Button>
            </div>
            <Field
              label="Input field"
              placeholder="Enter business value"
              hint="Example component only; nothing is submitted."
            />
            <div className="component-row">
              <label className="check-row">
                <input type="checkbox" defaultChecked />
                Checkbox
              </label>
              <label className="check-row">
                <input type="radio" name={`${theme}-example`} defaultChecked />
                Radio
              </label>
            </div>
            <div className="component-row">
              <Badge tone="success">Success</Badge>
              <Badge tone="info">Information</Badge>
              <Badge tone="warning">Warning</Badge>
              <Badge tone="danger">Error</Badge>
              <Badge>Neutral</Badge>
            </div>
          </section>
        ))}
      </div>
      <section className="panel token-panel" aria-labelledby="tokens-heading">
        <h2 id="tokens-heading">Design foundations</h2>
        <dl>
          <div>
            <dt>Primitive tokens</dt>
            <dd>Forest, sand, neutral, and status palettes</dd>
          </div>
          <div>
            <dt>Semantic tokens</dt>
            <dd>Action · Surface · Content · Border · Status</dd>
          </div>
          <div>
            <dt>Typography</dt>
            <dd>
              Inter / system sans · Display 32/40 · Heading 20/28 · Body 14/21 ·
              Label 12/16
            </dd>
          </div>
          <div>
            <dt>Shape</dt>
            <dd>Rounded corners and subtle elevation</dd>
          </div>
        </dl>
      </section>
    </Page>
  );
}
