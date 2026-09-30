// Small platform-only primitives on --w-* tokens (ui-kit Button/Badge cover the rest).
import type { ReactNode } from "react";
import s from "./ui.module.css";

export type Tone = "neutral" | "accent" | "ok" | "warn" | "bad";

export function Pill({
  tone = "neutral",
  title,
  testId,
  children,
}: {
  tone?: Tone;
  title?: string;
  testId?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <span className={`${s.pill} ${s[tone]}`} title={title} data-testid={testId}>
      {children}
    </span>
  );
}

export function Alert({ children, testId }: { children: ReactNode; testId?: string }): ReactNode {
  return (
    <div role="alert" className={s.alert} data-testid={testId}>
      {children}
    </div>
  );
}

export function Note({ children, testId }: { children: ReactNode; testId?: string }): ReactNode {
  return (
    <div role="note" className={s.note} data-testid={testId}>
      <span aria-hidden="true" className={s.shield}>
        ⛨
      </span>
      <span>{children}</span>
    </div>
  );
}

export function Spinner({ label }: { label?: string }): ReactNode {
  return <span className={s.spinner} role="img" aria-label={label} />;
}

export function StatusIcon({ status }: { status: "queued" | "running" | "done" | "failed" }): ReactNode {
  if (status === "running") return <Spinner />;
  return (
    <span className={`${s.icon} ${s[`icon_${status}`]}`} aria-hidden="true">
      {status === "done" ? "✓" : status === "failed" ? "✗" : "·"}
    </span>
  );
}
