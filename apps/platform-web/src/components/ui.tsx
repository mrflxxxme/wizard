// Small platform-only primitives on the design system v2 (--p-*, B2-33); buttons — components/v2/Button.
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

/**
 * D28/D48: technical details (check ids, levels G0–G2, file:line, error codes) stay out of the main view — only under
 * this «Подробнее для специалиста» disclosure (closed by default).
 */
export function Specialist({
  children,
  testId = "specialist",
}: {
  children: ReactNode;
  testId?: string;
}): ReactNode {
  return (
    <details className={s.specialist} data-testid={testId}>
      <summary>Подробнее для специалиста</summary>
      <div className={s.specialistBody}>{children}</div>
    </details>
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
