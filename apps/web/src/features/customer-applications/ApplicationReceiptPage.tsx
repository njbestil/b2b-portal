import { useEffect, useRef } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { Badge } from "../../shared/ui";
import { Icon } from "../../shared/Icon";
import { isReceiptReference } from "./api";

export function ApplicationReceiptPage() {
  const { state }: { state: unknown } = useLocation(),
    heading = useRef<HTMLHeadingElement>(null);
  const reference =
    state && typeof state === "object" && "reference" in state
      ? state.reference
      : null;
  useEffect(() => {
    document.title = "Application received · Gulf Provision";
    heading.current?.focus({ preventScroll: true });
  }, []);
  if (!isReceiptReference(reference)) return <Navigate to="/apply" replace />;
  return (
    <main id="main-content" className="application-receipt-layout">
      <section
        className="application-receipt-card"
        aria-labelledby="application-receipt-heading"
      >
        <span className="application-success-icon">
          <Icon name="check" />
        </span>
        <Badge tone="success">Application received</Badge>
        <h1 id="application-receipt-heading" tabIndex={-1} ref={heading}>
          Thank you for applying
        </h1>
        <p>
          Business account access requires review and approval. Keep this
          receipt reference for your records.
        </p>
        <dl className="application-reference">
          <dt>Receipt reference</dt>
          <dd>{reference}</dd>
        </dl>
        <Link className="button button-secondary" to="/login">
          Back to login
        </Link>
      </section>
    </main>
  );
}
