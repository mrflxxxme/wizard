import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx, useWzRoot, type WzBase } from "../data/context.js";
import styles from "./Button.module.css";
import type { RootAttrs } from "./root.js";

export interface ButtonProps extends WzBase, Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  loading?: boolean;
  icon?: ReactNode;
  href?: string;
}

export function Button(props: ButtonProps): ReactNode {
  return <ButtonImpl {...props} root={useWzRoot("Button", "wz-button", props)} />;
}

export function ButtonImpl({
  root,
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  href,
  children,
  wzId: _wzId,
  testId: _testId,
  className,
  disabled,
  type = "button",
  ...rest
}: ButtonProps & { root: RootAttrs }): ReactNode {
  const cls = cx(
    styles.btn,
    styles[variant],
    size === "sm" && styles.sm,
    loading && styles.loading,
    className,
  );
  const content = (
    <>
      {icon !== undefined && <span className={styles.label}>{icon}</span>}
      {children !== undefined && <span className={styles.label}>{children}</span>}
      {loading && <span className={styles.spinner} aria-hidden="true" />}
    </>
  );
  if (href !== undefined && !disabled && !loading) {
    return (
      <a {...root} href={href} className={cls} aria-label={rest["aria-label"]}>
        {content}
      </a>
    );
  }
  return (
    <button
      {...root}
      {...rest}
      type={type}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {content}
    </button>
  );
}
