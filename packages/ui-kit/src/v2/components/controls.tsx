import {
  type ButtonHTMLAttributes,
  createElement,
  type HTMLAttributes,
  type ReactNode,
  useLayoutEffect,
  useRef,
} from "react";
import { applyPlatformTheme, type PlatformThemeMode } from "../tokens.js";
import { cx, type PBase, pRoot } from "../util.js";
import s from "./controls.module.css";

export interface ThemeRootProps extends PBase {
  /** auto — by prefers-color-scheme. */
  theme?: PlatformThemeMode;
  /** Client business colour #RRGGBB: the interface takes it over (grill-7 #7); null — platform graphite. */
  business?: string | null;
  /** false forces the solid glass fallback. */
  glass?: boolean;
  grain?: boolean;
  /** false switches motion off like prefers-reduced-motion (screenshots, weak devices). */
  motion?: boolean;
  children?: ReactNode;
}

/** Platform root on a container: tokens, theme, business colour, grain, glass and motion switches. */
export function ThemeRoot({
  theme = "auto",
  business = null,
  glass = true,
  grain = true,
  motion = true,
  className,
  testId,
  children,
}: ThemeRootProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) applyPlatformTheme(ref.current, { theme, business, glass, grain });
  }, [theme, business, glass, grain]);
  return (
    <div
      ref={ref}
      {...pRoot("ThemeRoot", testId, "p-root")}
      data-p-root=""
      data-p-motion={motion ? undefined : "off"}
      className={className}
    >
      {children}
    </div>
  );
}

export interface ActionButtonProps extends PBase, Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  /** primary — graphite (main action); secondary; create — amber, only where something is made; ghost. */
  variant?: "primary" | "secondary" | "create" | "ghost";
  size?: "md" | "sm";
  /** The amber spark pulses: something is being made right now. */
  busy?: boolean;
  icon?: ReactNode;
}

/** Button v2: graphite main action, secondary, amber «создать» with a spark, ghost. */
export function ActionButton({
  variant = "secondary",
  size = "md",
  busy = false,
  icon,
  className,
  testId,
  children,
  type = "button",
  ...rest
}: ActionButtonProps): ReactNode {
  return (
    <button
      {...rest}
      {...pRoot("ActionButton", testId, "p-button")}
      type={type}
      aria-busy={busy || undefined}
      className={cx(s.btn, s[variant], size === "sm" && s.sm, busy && s.busy, className)}
    >
      {variant === "create" && <span className={s.spark} aria-hidden="true" />}
      {icon}
      {children}
    </button>
  );
}

export interface ChipProps extends PBase, Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  /** Pressed state (aria-pressed); undefined — a plain action chip. */
  pressed?: boolean;
  /** Marks the recommended option with the word «советуем» (not by colour only). */
  recommended?: boolean;
  /** outline — quiet chip (examples, suggestions). */
  tone?: "solid" | "outline";
}

/** Chip: an answer option, a suggestion or an example. */
export function Chip({
  pressed,
  recommended = false,
  tone = "solid",
  className,
  testId,
  children,
  type = "button",
  ...rest
}: ChipProps): ReactNode {
  return (
    <button
      {...rest}
      {...pRoot("Chip", testId, "p-chip")}
      type={type}
      aria-pressed={pressed}
      data-recommended={recommended || undefined}
      className={cx(s.chip, tone === "outline" && s.outline, className)}
    >
      <span>{children}</span>
      {recommended && <span className={s.rec}>советуем</span>}
    </button>
  );
}

export interface TagProps extends PBase {
  /** goal — a goal of the system; out — «не входит» (struck through); plain. */
  kind?: "goal" | "out" | "plain";
  /** Small grey note after the label (e.g. «неявок меньше 5%»). */
  note?: ReactNode;
  children: ReactNode;
}

/** Label on the sketch: goals and what is not included. */
export function Tag({ kind = "plain", note, className, testId, children }: TagProps): ReactNode {
  return (
    <span
      {...pRoot("Tag", testId, "p-tag")}
      data-kind={kind}
      className={cx(s.tag, kind === "goal" && s.goal, kind === "out" && s.out, className)}
    >
      {kind === "out" ? <b>{children}</b> : children}
      {note !== undefined && (
        <>
          <span className={s.tagNote} aria-hidden="true">
            ·
          </span>
          <span className={s.tagNote}>{note}</span>
        </>
      )}
    </span>
  );
}

export interface SerifProps extends PBase {
  as?: "h1" | "h2" | "h3" | "p" | "span";
  size?: "xl" | "lg" | "md";
  children: ReactNode;
}

/** Serif text for «human» moments only: greeting, system name, «Система готова». */
export function Serif({ as = "p", size = "lg", className, testId, children }: SerifProps): ReactNode {
  const sizeClass = size === "xl" ? s.serifXl : size === "md" ? s.serifMd : s.serifLg;
  return createElement(
    as,
    { ...pRoot("Serif", testId, "p-serif"), className: cx(s.serif, sizeClass, className) },
    children,
  );
}

export interface GlassProps extends PBase, Omit<HTMLAttributes<HTMLDivElement>, "className"> {
  as?: "div" | "header" | "section" | "aside" | "nav";
}

/** Glass layer for floating panels: blur where supported, solid surface otherwise (or with data-p-glass="off"). */
export function Glass({ as = "div", className, testId, children, ...rest }: GlassProps): ReactNode {
  return createElement(
    as,
    { ...rest, ...pRoot("Glass", testId, "p-glass"), className: cx(s.glass, className) },
    children,
  );
}
