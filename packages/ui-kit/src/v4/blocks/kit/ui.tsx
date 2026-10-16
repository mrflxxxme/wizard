// Shared pieces of the blocks: the section frame, the buttons and the eyebrow line, on the theme tokens only.
import type { ReactNode } from "react";

export type Link = { label: string; href: string };
export type Image = { src: string; alt: string };

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
/** Main action: the primary colour, ≥ 44 px target. */
export const primaryBtn = `inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-primary px-6 text-body font-semibold text-primary-foreground transition-[background-color,transform] duration-200 hover:bg-primary/90 active:scale-[0.98] ${focus}`;
/** Second action: outlined. */
export const secondaryBtn = `inline-flex min-h-11 items-center justify-center gap-2 rounded-control border border-border px-6 text-body font-semibold text-foreground transition-colors duration-200 hover:bg-muted ${focus}`;
/** Action on the inverse band. */
export const inverseBtn = `inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-inverse-foreground px-6 text-body font-semibold text-inverse transition-opacity duration-200 hover:opacity-90 ${focus}`;
export const focusRing = focus;

/** Section frame: marks the block for the canvas (data-wz-component, data-wz-id) and sets the page column. */
export function Section({
  block,
  wzId,
  className,
  inner,
  backdrop,
  children,
}: {
  block: string;
  wzId?: string;
  className?: string;
  inner?: string;
  /** Full-bleed layers behind the column (gradients, canvas, grain). */
  backdrop?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-wz-component={block}
      data-wz-id={wzId}
      className={`relative overflow-hidden font-sans ${className ?? "bg-background text-foreground"}`}
    >
      {backdrop}
      <div className={`relative mx-auto w-full max-w-page px-gutter ${inner ?? "py-section"}`}>
        {children}
      </div>
    </section>
  );
}

/** Small line above a heading. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-small font-semibold tracking-wide uppercase ${className ?? "text-muted-foreground"}`}>
      {children}
    </p>
  );
}

/** Heading block of a section: eyebrow, title and lead. */
export function Heading({
  eyebrow,
  title,
  lead,
  center,
}: {
  eyebrow?: string;
  title: string;
  lead?: string;
  center?: boolean;
}) {
  return (
    <div className={center ? "mx-auto max-w-text text-center" : "max-w-text"}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h2 className="mt-3 font-display text-h2 font-bold text-balance">{title}</h2>
      {lead ? <p className="mt-4 text-lead text-pretty text-muted-foreground">{lead}</p> : null}
    </div>
  );
}

/** Grain overlay (SVG noise as a data URI): texture without photos (D80 (3)); static, no JS. */
export const GRAIN_URL =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

export function Grain({ opacity = 0.14 }: { opacity?: number }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 mix-blend-overlay"
      style={{ backgroundImage: GRAIN_URL, opacity }}
    />
  );
}
