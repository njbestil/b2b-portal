import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Field, Button } from "../../shared/ui";
import { Brand } from "../../shell/WorkspaceLayout";
import {
  submitApplication,
  ApplicationSubmissionError,
  type ApplicationInput,
} from "./api";

const fields = [
  {
    key: "companyName",
    label: "Legal / trade name",
    placeholder: "Company LLC",
    type: "text",
    limit: 200,
    autoComplete: "organization",
  },
  {
    key: "tradeLicenseReference",
    label: "Trade licence no.",
    placeholder: "CN-0000000",
    type: "text",
    limit: 100,
    autoComplete: "off",
  },
  {
    key: "businessEmail",
    label: "Business email",
    placeholder: "orders@company.ae",
    type: "email",
    limit: 254,
    autoComplete: "section-company email",
  },
  {
    key: "phone",
    label: "Phone",
    placeholder: "+971 4 000 0000",
    type: "tel",
    limit: 40,
    autoComplete: "section-company tel",
  },
  {
    key: "billingAddress",
    label: "Billing address",
    placeholder: "Building, street, emirate",
    type: "text",
    limit: 500,
    autoComplete: "section-billing street-address",
  },
  {
    key: "deliveryAddress",
    label: "Delivery address",
    placeholder: "Warehouse, street, emirate",
    type: "text",
    limit: 500,
    autoComplete: "section-delivery street-address",
  },
  {
    key: "administratorName",
    label: "Full name",
    placeholder: "Administrator name",
    type: "text",
    limit: 160,
    autoComplete: "section-administrator name",
  },
  {
    key: "administratorEmail",
    label: "Email",
    placeholder: "admin@company.ae",
    type: "email",
    limit: 254,
    autoComplete: "section-administrator username",
  },
  {
    key: "administratorMobile",
    label: "Mobile number",
    placeholder: "+971 50 000 0000",
    type: "tel",
    limit: 40,
    autoComplete: "section-administrator tel",
  },
  {
    key: "password",
    label: "Password",
    placeholder: "Choose an initial password",
    type: "password",
    limit: 1024,
    autoComplete: "section-administrator new-password",
  },
] as const;
type FieldKey = keyof ApplicationInput;
type FormError = { message: string; fields: Partial<Record<FieldKey, string>> };
function unsafeText(value: string) {
  return Array.from(value).some((c) => {
    const n = c.codePointAt(0)!;
    return n < 32 || n === 127 || (n >= 0xd800 && n <= 0xdfff);
  });
}
export function validateApplication(
  form: HTMLFormElement,
  input: ApplicationInput,
): FormError["fields"] {
  const errors: FormError["fields"] = {};
  for (const field of fields) {
    const value = input[field.key],
      control = form.elements.namedItem(field.key) as HTMLInputElement;
    if (!(field.key === "password" ? value : value.trim()))
      errors[field.key] = "This field is required.";
    else if (field.key === "password") {
      if (
        new TextEncoder().encode(value).byteLength > 1024 ||
        Array.from(value).some((c) => {
          const n = c.codePointAt(0)!;
          return n >= 0xd800 && n <= 0xdfff;
        })
      )
        errors[field.key] = "Choose a shorter password.";
    } else if (value.length > field.limit || unsafeText(value))
      errors[field.key] = "Enter a shorter value without control characters.";
    else if (control.validity.typeMismatch)
      errors[field.key] = "Enter a valid email address.";
  }
  return errors;
}
function failureMessage(error: unknown) {
  if (error instanceof ApplicationSubmissionError) {
    if (error.code === "invalid")
      return "Check your business and administrator details, then try again.";
    if (error.code === "size")
      return "Your application is too large. Shorten the details and try again.";
    if (error.code === "media")
      return "Your application could not be sent. Please try again.";
    if (error.code === "rate")
      return error.retryAfter
        ? `Too many attempts. Wait ${error.retryAfter} seconds before trying again.`
        : "Too many attempts. Please wait before trying again.";
  }
  return "We couldn’t confirm receipt. Please retry using the same details and initial password. Retrying will not change an application already received.";
}
export function ApplicationPage() {
  const heading = useRef<HTMLHeadingElement>(null),
    summary = useRef<HTMLDivElement>(null),
    request = useRef<AbortController | null>(null);
  const [error, setError] = useState<FormError | null>(null),
    [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    document.title = "Apply for an account · Gulf Provision";
    heading.current?.focus({ preventScroll: true });
    return () => request.current?.abort();
  }, []);
  useEffect(() => {
    if (error) summary.current?.focus();
  }, [error]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    const form = event.currentTarget,
      data = new FormData(form);
    const input = Object.fromEntries(
      fields.map((f) => [f.key, String(data.get(f.key) ?? "")]),
    ) as unknown as ApplicationInput;
    const invalid = validateApplication(form, input);
    if (Object.keys(invalid).length) {
      setError({ message: "Check the highlighted fields.", fields: invalid });
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const reference = await submitApplication(input, controller.signal);
      if (!controller.signal.aborted)
        navigate("/apply/received", { replace: true, state: { reference } });
    } catch (failure) {
      if (!controller.signal.aborted)
        setError({ message: failureMessage(failure), fields: {} });
    } finally {
      (form.elements.namedItem("password") as HTMLInputElement).value = "";
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="application-page">
      <div className="application-mobile-brand">
        <Brand />
      </div>
      <p className="eyebrow">New business account</p>
      <h1 ref={heading} tabIndex={-1}>
        Apply for an account
      </h1>
      <p className="application-intro">
        Tell us about your business. Approval is required before access.
      </p>
      <p role="status" className="application-status">
        {busy ? "Sending your application…" : ""}
      </p>
      <form
        className="application-form"
        noValidate
        onSubmit={submit}
        aria-busy={busy}
      >
        {error && (
          <div className="application-error" ref={summary} tabIndex={-1}>
            <h2>We need your attention</h2>
            <p>{error.message}</p>
          </div>
        )}
        {[
          { legend: "Company information", items: fields.slice(0, 6) },
          { legend: "Account administrator", items: fields.slice(6) },
        ].map((group) => (
          <fieldset disabled={busy} key={group.legend}>
            <legend>{group.legend}</legend>
            <div className="application-grid">
              {group.items.map((field) => (
                <Field
                  key={field.key}
                  name={field.key}
                  label={field.label}
                  type={field.type}
                  placeholder={field.placeholder}
                  autoComplete={field.autoComplete}
                  required
                  maxLength={field.limit}
                  aria-invalid={error?.fields[field.key] ? true : undefined}
                  hint={
                    error?.fields[field.key] ??
                    (field.key === "password"
                      ? "You’ll need to change this initial password after your account is approved."
                      : undefined)
                  }
                />
              ))}
            </div>
          </fieldset>
        ))}
        <Button type="submit">Submit application</Button>
      </form>
      <p className="application-switch">
        Already applied? <Link to="/login">Back to login</Link>
      </p>
    </div>
  );
}
