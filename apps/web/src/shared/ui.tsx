import { useId, type ComponentProps, type ReactNode } from "react";

export function Button({
  variant = "primary",
  className = "",
  type = "button",
  unavailable = false,
  onClick,
  ...props
}: Omit<ComponentProps<"button">, "disabled"> & {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  unavailable?: boolean;
}) {
  return (
    <button
      {...props}
      type={type}
      className={`button button-${variant} ${className}`}
      aria-disabled={unavailable || undefined}
      onClick={(event) => {
        if (unavailable) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    />
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "info" | "warning" | "danger";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Field({
  label,
  hint,
  "aria-describedby": describedBy,
  ...props
}: Omit<ComponentProps<"input">, "id"> & {
  label: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        {...props}
        id={id}
        aria-describedby={
          [describedBy, hint ? `${id}-hint` : undefined]
            .filter(Boolean)
            .join(" ") || undefined
        }
      />
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
