// Platform button on the design system v2 (B2-33): ActionButton of @wizard/ui-kit/v2 with the props the platform
// screens used on ui-kit v1 — data-testid, loading (disabled + aria-busy + spinner) and a quiet «danger» variant.
import { ActionButton } from "@wizard/ui-kit/v2";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import s from "./Button.module.css";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  /** primary — graphite; secondary; create — amber, only where something is made; ghost; danger — irreversible. */
  variant?: "primary" | "secondary" | "create" | "ghost" | "danger";
  size?: "md" | "sm";
  loading?: boolean;
  icon?: ReactNode;
  className?: string;
  "data-testid"?: string;
}

/** Button v2 of the platform screens. */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className,
  disabled,
  children,
  "data-testid": testId,
  ...rest
}: ButtonProps): ReactNode {
  const danger = variant === "danger";
  const cls = [danger ? s.danger : "", loading ? s.loading : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <ActionButton
      {...rest}
      variant={danger ? "secondary" : variant}
      size={size}
      busy={loading}
      icon={icon}
      testId={testId}
      disabled={disabled || loading}
      className={cls || undefined}
    >
      {children}
      {loading && variant !== "create" && <span className={s.spinner} aria-hidden="true" />}
    </ActionButton>
  );
}
