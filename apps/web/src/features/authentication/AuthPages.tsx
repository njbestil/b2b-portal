import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { Button, Field } from "../../shared/ui";
import { Brand } from "../../shell/WorkspaceLayout";
import { useAuth } from "./AuthContext";
import { AuthError } from "./session";

type Mode = "login" | "temporary" | "forgot" | "reset";
const copy = {
  login: {
    title: "Welcome back",
    intro: "Sign in to manage your company orders.",
    submit: "Sign in to portal",
  },
  temporary: {
    title: "Create a new password",
    intro: "For security, replace the temporary password before continuing.",
    submit: "Save password & continue",
  },
  forgot: {
    title: "Forgot your password?",
    intro:
      "Demo recovery uses a protected local operator handoff after identity verification. Email delivery is not available.",
    submit: "Request recovery",
  },
  reset: {
    title: "Reset your password",
    intro:
      "Enter the recovery proof supplied through the protected operator handoff. Choose a password you haven’t used before.",
    submit: "Reset password",
  },
};
function message(error: unknown) {
  if (!(error instanceof AuthError))
    return "Account access is unavailable. Please try again later.";
  switch (error.code) {
    case "credentials":
      return "The email or password could not be verified. Pending accounts require approval before sign-in.";
    case "rate":
      return "Too many attempts. Please wait before trying again.";
    case "invalid":
      return "Check the entered details and try again.";
    case "session":
      return "Your session could not be confirmed. Please sign in again.";
    case "restricted":
      return "Change your temporary password before continuing.";
    default:
      return "We couldn’t confirm the outcome. Please sign in again if you have already changed your password. Otherwise try again later.";
  }
}
export function AuthPage({ mode }: { mode: Mode }) {
  const { client, user, passwords, passwordFlowsConnected } = useAuth();
  const heading = useRef<HTMLHeadingElement>(null),
    summary = useRef<HTMLDivElement>(null),
    pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<{
      message: string;
      fields: Record<string, string>;
    } | null>(null),
    [received, setReceived] = useState(false);
  const navigate = useNavigate(),
    location = useLocation();
  const info = copy[mode];
  const title = received ? "Recovery request received" : info.title;
  useEffect(() => {
    document.title = `${title} · Gulf Provision`;
    heading.current?.focus({ preventScroll: true });
  }, [title]);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (error) summary.current?.focus();
  }, [error]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const form = event.currentTarget,
      data = new FormData(form),
      errors: Record<string, string> = {};
    const value = (key: string) => String(data.get(key) ?? "");
    for (const control of Array.from(form.elements)) {
      if (
        !(control instanceof HTMLInputElement) ||
        !control.name ||
        control.type === "checkbox"
      )
        continue;
      if (
        !control.value.length ||
        (control.type !== "password" && !control.value.trim())
      )
        errors[control.name] = "This field is required.";
      else if (control.validity.typeMismatch)
        errors[control.name] = "Enter a valid email address.";
      else if (
        control.type === "password" &&
        new TextEncoder().encode(control.value).length > 1024
      )
        errors[control.name] = "Choose a shorter password.";
    }
    if (mode === "temporary" || mode === "reset") {
      const next = value("newPassword");
      if (
        next.length < 8 ||
        !/[A-Z]/.test(next) ||
        !/[0-9]/.test(next) ||
        !/[^A-Za-z0-9\s]/.test(next)
      )
        errors.newPassword =
          "Use 8+ characters with an uppercase letter, number and symbol.";
      if (next !== value("confirmPassword"))
        errors.confirmPassword = "The new passwords must match.";
    }
    if (Object.keys(errors).length) {
      setError({ message: "Check the highlighted fields.", fields: errors });
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        const result = await client.login(
          value("email"),
          value("password"),
          controller.signal,
        );
        if (!controller.signal.aborted)
          navigate(result.mustChangePassword ? "/first-login" : "/dashboard", {
            replace: true,
          });
      } else if (mode === "forgot") {
        await passwords.requestRecovery(value("email"), controller.signal);
        if (!controller.signal.aborted) {
          setReceived(true);
          form.reset();
        }
      } else {
        if (mode === "temporary")
          await passwords.changeInitialPassword(
            value("currentPassword"),
            value("newPassword"),
            controller.signal,
          );
        else
          await passwords.redeemRecovery(
            value("proof"),
            value("newPassword"),
            controller.signal,
          );
        if (controller.signal.aborted) return;
        client.clear();
        if (!controller.signal.aborted)
          navigate("/login", {
            replace: true,
            state: { passwordChanged: true },
          });
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError({ message: message(failure), fields: {} });
    } finally {
      for (const control of Array.from(form.elements))
        if (
          control instanceof HTMLInputElement &&
          (control.type === "password" || control.name === "proof")
        )
          control.value = "";
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const field = (
    name: string,
    label: string,
    type: string,
    autoComplete: string,
    hint?: string,
  ) => (
    <Field
      name={name}
      label={label}
      type={type}
      autoComplete={autoComplete}
      required
      maxLength={name === "email" ? 254 : 1024}
      aria-invalid={error?.fields[name] ? true : undefined}
      hint={error?.fields[name] ?? hint}
    />
  );
  if (mode === "temporary" && (!user || !user.mustChangePassword))
    return <Navigate to="/login" replace />;
  return (
    <div className="auth-page">
      <div className="application-mobile-brand">
        <Brand />
      </div>
      <p className="eyebrow">
        {mode === "login"
          ? "Business customer portal"
          : "Secure account access"}
      </p>
      <h1 tabIndex={-1} ref={heading}>
        {received ? "Recovery request received" : info.title}
      </h1>
      <p className="auth-intro">
        {received
          ? "If the account is eligible, recovery follows the protected operator handoff after identity verification. This does not sign you in."
          : info.intro}
      </p>
      {mode === "login" && location.state?.passwordChanged === true && (
        <p className="auth-notice">
          Password changed. Sign in with your new password.
        </p>
      )}
      {mode !== "login" && !passwordFlowsConnected && (
        <p className="auth-notice">
          This password flow is awaiting its API connection. Submitting here
          cannot change your password or request a recovery proof yet.
        </p>
      )}
      <p role="status">{busy ? "Please wait…" : ""}</p>
      {!received && (
        <form
          noValidate
          onSubmit={submit}
          aria-busy={busy}
          className="auth-form"
        >
          {error && (
            <div className="application-error" ref={summary} tabIndex={-1}>
              <h2>We need your attention</h2>
              <p>{error.message}</p>
            </div>
          )}
          <fieldset disabled={busy}>
            <legend className="visually-hidden">{info.title}</legend>
            {(mode === "login" || mode === "forgot") &&
              field("email", "Business email", "email", "username")}
            {mode === "login" &&
              field("password", "Password", "password", "current-password")}
            {mode === "temporary" &&
              field(
                "currentPassword",
                "Temporary password",
                "password",
                "current-password",
              )}
            {mode === "reset" &&
              field(
                "proof",
                "Recovery proof",
                "password",
                "off",
                "Enter the proof directly; do not put it in a URL.",
              )}
            {(mode === "reset" || mode === "temporary") && (
              <>
                {field(
                  "newPassword",
                  "New password",
                  "password",
                  "new-password",
                  "Use 8+ characters with an uppercase letter, number and symbol.",
                )}
                {field(
                  "confirmPassword",
                  "Confirm new password",
                  "password",
                  "new-password",
                )}
              </>
            )}
          </fieldset>
          {mode === "login" && (
            <div className="auth-form-row">
              <span className="auth-memory-note">
                This session stays in this tab’s memory.
              </span>
              <Link to="/forgot-password">Forgot password?</Link>
            </div>
          )}
          <Button type="submit">{info.submit}</Button>
        </form>
      )}
      <nav className="auth-links" aria-label="Account access">
        {mode === "login" ? (
          <>
            <Link to="/login" state={{ temporaryHelp: true }}>
              First login with a temporary password?
            </Link>
            {location.state?.temporaryHelp === true && (
              <p>
                Sign in above with your temporary password. You’ll be asked to
                change it before continuing.
              </p>
            )}
            <p>
              New customer?{" "}
              <Link to="/apply">Apply for a business account</Link>
            </p>
          </>
        ) : (
          <Link to="/login">Back to login</Link>
        )}
        {mode === "forgot" && (
          <Link to="/reset-password">I have a recovery proof</Link>
        )}
      </nav>
    </div>
  );
}
