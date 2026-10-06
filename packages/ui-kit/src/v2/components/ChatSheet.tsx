import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cx, type PBase, pRoot } from "../util.js";
import s from "./ChatSheet.module.css";
import { Glass } from "./controls.js";

/** Pixels of vertical drag on the handle that open (up) or close (down) the history. */
export const SHEET_DRAG_THRESHOLD = 14;

export interface ChatSheetProps extends PBase {
  /** History is shown. */
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The conversation (ChatMessage list); without it there is no handle. */
  history?: ReactNode;
  /** Always visible part: the current question card and/or Composer. */
  children?: ReactNode;
  /** fixed — floats bottom-centre over the canvas (default); inline — in the flow (demo, tests). */
  position?: "fixed" | "inline";
  label?: string;
}

/**
 * Floating chat over the canvas: a glass dock with the current question and the input row; the history unfolds upwards
 * by a tap on the handle or a drag up (a sheet on the phone), closes by a drag down, Esc or a tap outside.
 */
export function ChatSheet({
  open,
  onOpenChange,
  history,
  children,
  position = "fixed",
  label = "Разговор",
  className,
  testId,
}: ChatSheetProps): ReactNode {
  const histId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const grabRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ y: number; moved: boolean } | null>(null);
  const skipClick = useRef(false);
  const [dy, setDy] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onOpenChange(false);
      grabRef.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, onOpenChange]);

  const style = dy ? ({ "--p-drag": `${dy}px` } as CSSProperties) : undefined;
  return (
    <section
      ref={rootRef}
      {...pRoot("ChatSheet", testId, "p-sheet")}
      aria-label={label}
      data-open={open || undefined}
      style={style}
      className={cx(
        s.sheet,
        position === "inline" && s.inline,
        open && s.open,
        dy !== 0 && s.dragging,
        className,
      )}
    >
      {history !== undefined && (
        <div
          id={histId}
          className={s.hist}
          role="log"
          aria-label="Переписка"
          tabIndex={-1}
          data-testid="p-sheet-history"
        >
          {history}
        </div>
      )}
      <Glass className={s.dock} testId="p-sheet-dock">
        {history !== undefined && (
          <button
            ref={grabRef}
            type="button"
            className={s.grab}
            aria-expanded={open}
            aria-controls={histId}
            aria-label={open ? "Скрыть переписку" : "Показать переписку"}
            data-testid="p-sheet-grab"
            onPointerDown={(e) => {
              drag.current = { y: e.clientY, moved: false };
              e.currentTarget.setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const delta = e.clientY - d.y;
              // The dock follows the finger a little (damped), the history snaps at the threshold.
              setDy(Math.max(-24, Math.min(24, delta * 0.3)));
              if (!d.moved && Math.abs(delta) > SHEET_DRAG_THRESHOLD) {
                d.moved = true;
                skipClick.current = true;
                onOpenChange(delta < 0);
              }
            }}
            onPointerUp={() => {
              drag.current = null;
              setDy(0);
            }}
            onPointerCancel={() => {
              drag.current = null;
              setDy(0);
            }}
            onClick={() => {
              if (skipClick.current) {
                skipClick.current = false;
                return;
              }
              onOpenChange(!open);
            }}
          >
            <i />
          </button>
        )}
        {children}
      </Glass>
    </section>
  );
}

export interface ChatMessageProps extends PBase {
  /** me — the client; ai — the assistant; sys — a status line (amber dot), warn — a status needing attention. */
  from: "me" | "ai" | "sys";
  tone?: "warn";
  children: ReactNode;
}

/** One line of the conversation history. */
export function ChatMessage({ from, tone, className, testId, children }: ChatMessageProps): ReactNode {
  return (
    <div
      {...pRoot("ChatMessage", testId, "p-message")}
      data-from={from}
      className={cx(s.msg, s[from], tone === "warn" && s.warn, className)}
    >
      {children}
    </div>
  );
}
