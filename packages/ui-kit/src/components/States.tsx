// Shared data states (ui-kit.yaml#states): loading skeleton, EmptyState, ErrorState.
import { type ReactNode, useEffect, useState } from "react";
import type { WzError } from "../data/types.js";
import { ru } from "../i18n/ru.js";
import { ButtonImpl } from "./Button.js";
import { part } from "./root.js";
import styles from "./States.module.css";

/** Skeleton of the same height, aria-busy; visible not earlier than after 150 ms. */
export function Loading({ lines = 3, delayMs = 150 }: { lines?: number; delayMs?: number }): ReactNode {
  const [visible, setVisible] = useState(delayMs === 0);
  useEffect(() => {
    if (delayMs === 0) return;
    const t = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);
  return (
    <div className={styles.skeleton} aria-busy="true" data-testid="wz-loading">
      <span className={styles.srOnly}>{ru.states.loading}</span>
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <div key={i} className={visible ? styles.bar : styles.barHidden} />
      ))}
    </div>
  );
}

export function EmptyState({ text, action }: { text?: string; action?: ReactNode }): ReactNode {
  return (
    <div className={styles.empty} data-testid="wz-empty">
      <p>{text ?? ru.states.empty}</p>
      {action}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  onLogin,
}: {
  error: WzError;
  onRetry?: () => void;
  onLogin?: () => void;
}): ReactNode {
  const auth = error.status === 401 || error.code === "UNAUTHENTICATED";
  const forbidden = error.status === 403 || error.code === "FORBIDDEN";
  const text = auth ? ru.states.unauthenticated : forbidden ? ru.states.forbidden : error.message;
  return (
    <div className={styles.error} role="alert" data-testid="wz-error" data-code={error.code}>
      <p>{text}</p>
      {auth && onLogin ? (
        <ButtonImpl root={part("wz-error-login")} variant="primary" onClick={onLogin}>
          {ru.states.login}
        </ButtonImpl>
      ) : (
        !forbidden &&
        onRetry && (
          <ButtonImpl root={part("wz-error-retry")} onClick={onRetry}>
            {ru.states.retry}
          </ButtonImpl>
        )
      )}
    </div>
  );
}

export function SrOnly({ children }: { children: ReactNode }): ReactNode {
  return <span className={styles.srOnly}>{children}</span>;
}
