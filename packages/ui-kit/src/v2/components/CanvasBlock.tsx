import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { MATERIALIZE_MS } from "../tokens.js";
import { cx, type PBase, pRoot, prefersReducedMotion } from "../util.js";
import s from "./CanvasBlock.module.css";

export type CanvasBlockState = "sketch" | "materializing" | "ready";

export interface CanvasBlockProps extends PBase {
  /** sketch — muted outline with skeleton text; materializing — outline → surface → content with the amber edge; ready. */
  state: CanvasBlockState;
  /** Called once the materialization finished (immediately when motion is off). */
  onMaterialized?(): void;
  /** Stagger of the materialization, ms. */
  delayMs?: number;
  /** Name of the block for «ткни и скажи» (accessible name when pickable). */
  label?: string;
  /** Pickable when ready: tap or Enter selects the block. */
  onSelect?(): void;
  /** B2-29: pickable in the sketch too (a plan awaiting approval); never while materializing. */
  pickSketch?: boolean;
  selected?: boolean;
  children?: ReactNode;
}

function motionOff(el: HTMLElement | null): boolean {
  return prefersReducedMotion() || !!el?.closest('[data-p-motion="off"]');
}

/** A block of the client system on the canvas: sketch, materialization, ready, selected. */
export function CanvasBlock({
  state,
  onMaterialized,
  delayMs = 0,
  label,
  onSelect,
  pickSketch = false,
  selected = false,
  className,
  testId,
  children,
}: CanvasBlockProps): ReactNode {
  const ref = useRef<HTMLElement>(null);
  const done = useRef(onMaterialized);
  done.current = onMaterialized;
  useEffect(() => {
    if (state !== "materializing") return;
    if (motionOff(ref.current)) {
      done.current?.();
      return;
    }
    const t = setTimeout(() => done.current?.(), MATERIALIZE_MS + delayMs);
    return () => clearTimeout(t);
  }, [state, delayMs]);

  const pickable = (state === "ready" || (pickSketch && state === "sketch")) && onSelect !== undefined;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect?.();
    }
  };
  return (
    <section
      ref={ref}
      {...pRoot("CanvasBlock", testId, "p-block")}
      data-state={state}
      data-selected={selected || undefined}
      aria-label={label}
      aria-busy={state === "materializing" || undefined}
      style={delayMs ? ({ "--p-dl": `${delayMs}ms` } as CSSProperties) : undefined}
      className={cx(s.block, pickable && s.pickable, className)}
      {...(pickable
        ? { role: "button", tabIndex: 0, "aria-pressed": selected, onClick: onSelect, onKeyDown: onKey }
        : {})}
    >
      <span className={s.surface} aria-hidden="true" />
      <span className={s.outline} aria-hidden="true" />
      <div className={s.content}>{children}</div>
      <span className={s.ring} aria-hidden="true" />
      <span className={s.edge} aria-hidden="true" data-testid="p-block-edge">
        <i />
        <i />
      </span>
    </section>
  );
}

export interface SketchTextProps {
  /** Several lines of text (paragraph skeleton) instead of one bar. */
  lines?: boolean;
  className?: string;
  children: ReactNode;
}

/** Text inside a CanvasBlock: a skeleton bar in the sketch, the real text once the block is materialized. */
export function SketchText({ lines = false, className, children }: SketchTextProps): ReactNode {
  return (
    <span className={cx(s.t, lines && s.lines, className)}>
      <span className={s.tx}>{children}</span>
    </span>
  );
}
