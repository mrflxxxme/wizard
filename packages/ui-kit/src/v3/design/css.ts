// designSystemCss (builder-v3.md#C2): the design system as CSS variables (--ds-*) for both schemes, reduced-motion
// overrides, keyframes and the Tailwind v4 `@theme inline` block that binds the utilities to those variables. The
// theme block is the same for every system (only var() references): one compiled Tailwind serves several design
// systems on one page (three directions, V3-09) — each scope sets its own --ds-* values. Default Tailwind colours,
// fonts, sizes, radii, shadows and animations are cleared: pages use the client's tokens only (stack v3, V3-12).
import { FONTS_BASE, fontFaceCss } from "../../tokens/fonts.js";
import { COLOR_ROLES, type ColorRole, type PaletteScheme, type SchemeName } from "./palette.js";
import { type DesignSystemV3, fluid, TYPE_STEPS, type TypeStep } from "./system.js";

export interface DesignCssOptions {
  /** Selector instead of :root (a preview container); the scheme attribute goes on the same element. */
  scope?: string;
  /** @font-face rules of the two families first (served by the runtime from /_wizard/fonts). */
  fonts?: boolean;
  fontBase?: string;
  /** The Tailwind `@theme inline` block (default true; false for extra scopes on a page that has it). */
  theme?: boolean;
}

/** Variable name of a colour role: surfaceAlt → --ds-color-surface-alt. */
export const colorVar = (role: ColorRole): string =>
  `--ds-color-${role.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
const twColor = (role: ColorRole) => colorVar(role).replace("--ds-color-", "--color-");

const decl = (vars: Record<string, string | number>) =>
  Object.entries(vars)
    .map(([k, v]) => `${k}:${v};`)
    .join("");

function colorDecls(p: PaletteScheme, scheme: SchemeName): string {
  const vars: Record<string, string> = { "color-scheme": scheme };
  for (const role of COLOR_ROLES) vars[colorVar(role)] = p[role];
  return decl(vars);
}

const SHADOWS: Record<DesignSystemV3["depth"], [string, string]> = {
  flat: ["none", "none"],
  outline: ["none", "none"],
  soft: [
    "0 1px 2px color-mix(in oklch, var(--ds-color-ink) 6%, transparent)",
    "0 1px 2px color-mix(in oklch, var(--ds-color-ink) 6%, transparent), 0 8px 24px -12px color-mix(in oklch, var(--ds-color-ink) 18%, transparent)",
  ],
};

const anim = (name: string, ms: number, easing = "var(--ds-ease-out)") =>
  ms > 0 ? `wz-${name} ${ms}ms ${easing} both` : "none";

/** Scheme-independent variables: fonts, type scale, spacing, grid, radius, depth, motion, imagery. */
export function designSystemVars(ds: DesignSystemV3): Record<string, string | number> {
  const t = ds.type.steps;
  const m = ds.motion;
  const vars: Record<string, string | number> = {
    "font-synthesis": "none",
    "--ds-font-display": ds.fonts.display.stack,
    "--ds-font-text": ds.fonts.text.stack,
    "--ds-font-display-weight": ds.fonts.display.weight,
    "--ds-heading-case": ds.type.upper ? "uppercase" : "none",
  };
  for (const s of TYPE_STEPS) {
    vars[`--ds-text-${s}`] = t[s].size;
    vars[`--ds-leading-${s}`] = t[s].lineHeight;
    vars[`--ds-tracking-${s}`] = t[s].tracking;
  }
  const g = ds.grid;
  Object.assign(vars, {
    "--ds-space-section": fluid(g.rhythm.section.mobile, g.rhythm.section.desktop),
    "--ds-gutter": fluid(g.gutter.mobile, g.gutter.desktop),
    "--ds-container": `${g.maxWidth}px`,
    "--ds-measure": `${g.measure}ch`,
    "--ds-columns": g.columns,
    "--ds-radius-sm": `${ds.radius.sm}px`,
    "--ds-radius-md": `${ds.radius.md}px`,
    "--ds-radius-lg": `${ds.radius.lg}px`,
    "--ds-radius-control": `${ds.radius.control}px`,
    "--ds-border-width": ds.depth === "outline" && ds.radius.md === 0 ? "2px" : "1px",
    "--ds-shadow-sm": SHADOWS[ds.depth][0],
    "--ds-shadow-md": SHADOWS[ds.depth][1],
    "--ds-ease-out": m.easing.out,
    "--ds-ease-move": m.easing.move,
    "--ds-duration-state": `${m.durations.state}ms`,
    "--ds-duration-element": `${m.durations.element}ms`,
    "--ds-duration-overlay": `${m.durations.overlay}ms`,
    "--ds-stagger": `${m.durations.stagger}ms`,
    "--ds-press": m.press,
    "--ds-anim-hero": anim(m.entrance, m.durations.hero),
    "--ds-anim-reveal": anim("rise", m.durations.reveal),
    "--ds-image-filter": ds.imagery.filter,
    "--ds-image-ratio": ds.imagery.ratio.replace(":", " / "),
    // The motion profile the patterns read (patterns/theme.ts MOTION_PROFILE_VAR): still | calm | lively.
    "--ds-motion": m.profile,
  });
  return vars;
}

const KEYFRAMES = [
  "@keyframes wz-fade{from{opacity:0}to{opacity:1}}",
  "@keyframes wz-rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}",
  "@keyframes wz-clip{from{clip-path:inset(0 0 100% 0)}to{clip-path:inset(0 0 0 0)}}",
  "@keyframes wz-spin{to{transform:rotate(360deg)}}",
].join("\n");

/** Colour names of the pattern contract (patterns/theme.ts PATTERN_THEME.color) → the role that fills them. */
export const PATTERN_COLOR_ROLES: Readonly<Record<string, ColorRole>> = {
  background: "bg",
  foreground: "ink",
  card: "surface",
  "card-foreground": "ink",
  primary: "accent",
  "primary-foreground": "accentInk",
  muted: "surfaceAlt",
  "muted-foreground": "muted",
  ring: "focus",
  inverse: "ink",
  "inverse-foreground": "bg",
  scrim: "overlay",
  "scrim-foreground": "overlayInk",
};

/** Type names of the pattern contract (patterns/theme.ts PATTERN_THEME.text) → the step of the scale. */
export const PATTERN_TEXT_STEPS: Readonly<Record<string, TypeStep>> = {
  hero: "display",
  h1: "3xl",
  h2: "2xl",
  h3: "xl",
  lead: "lg",
  body: "base",
  small: "sm",
};

/** Tailwind v4 theme bound to the --ds-* variables (the same for every design system). */
export const DESIGN_THEME_CSS: string = (() => {
  const lines = [
    "--color-*: initial;",
    "--font-*: initial;",
    "--text-*: initial;",
    "--radius-*: initial;",
    "--shadow-*: initial;",
    "--animate-*: initial;",
    ...COLOR_ROLES.filter((r) => r !== "muted").map((r) => `${twColor(r)}: var(${colorVar(r)});`),
    // The names the section patterns are written against (patterns/theme.ts PATTERN_THEME, shadcn-style pairs):
    // muted is a quiet background there, its text is the role muted; inverse — the contrasting band, scrim — over photos.
    ...Object.entries(PATTERN_COLOR_ROLES).map(([name, role]) => `--color-${name}: var(${colorVar(role)});`),
    "--font-display: var(--ds-font-display);",
    "--font-text: var(--ds-font-text);",
    "--font-sans: var(--ds-font-text);",
    '--font-mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;',
    "--font-weight-heading: var(--ds-font-display-weight);",
    ...TYPE_STEPS.flatMap((s) => [
      `--text-${s}: var(--ds-text-${s});`,
      `--text-${s}--line-height: var(--ds-leading-${s});`,
      `--text-${s}--letter-spacing: var(--ds-tracking-${s});`,
    ]),
    ...Object.entries(PATTERN_TEXT_STEPS).flatMap(([name, step]) => [
      `--text-${name}: var(--ds-text-${step});`,
      `--text-${name}--line-height: var(--ds-leading-${step});`,
      `--text-${name}--letter-spacing: var(--ds-tracking-${step});`,
    ]),
    "--spacing: 0.25rem;",
    "--spacing-section: var(--ds-space-section);",
    "--spacing-gutter: var(--ds-gutter);",
    "--container-content: var(--ds-container);",
    "--container-measure: var(--ds-measure);",
    "--container-page: var(--ds-container);",
    "--container-text: var(--ds-measure);",
    "--radius-sm: var(--ds-radius-sm);",
    "--radius-md: var(--ds-radius-md);",
    "--radius-lg: var(--ds-radius-lg);",
    "--radius-control: var(--ds-radius-control);",
    "--shadow-sm: var(--ds-shadow-sm);",
    "--shadow-md: var(--ds-shadow-md);",
    "--ease-out: var(--ds-ease-out);",
    "--ease-move: var(--ds-ease-move);",
    "--animate-hero: var(--ds-anim-hero);",
    "--animate-reveal: var(--ds-anim-reveal);",
    "--animate-spin: wz-spin 1s linear infinite;",
  ];
  return `@theme inline {\n${lines.map((l) => `  ${l}`).join("\n")}\n}`;
})();

/**
 * CSS of a design system: variables of the starting scheme on :root (or `scope`), the other scheme under
 * [data-scheme=light|dark] and for data-scheme=auto by prefers-color-scheme, reduced motion (opacity only, content
 * visible), keyframes and the Tailwind theme.
 */
export function designSystemCss(ds: DesignSystemV3, opts: DesignCssOptions = {}): string {
  const root = opts.scope ?? ":root";
  const on = (mode: string) => `${opts.scope ?? ":root"}[data-scheme=${mode}]`;
  const first = ds.palette.scheme;
  const other: SchemeName = first === "light" ? "dark" : "light";
  const colors = (s: SchemeName) => colorDecls(ds.palette[s], s);
  const reduced = decl({
    "--ds-anim-hero": ds.motion.durations.hero > 0 ? `wz-fade ${ds.motion.reduced}ms linear both` : "none",
    "--ds-anim-reveal": "none",
    "--ds-press": 1,
  });
  const faces = opts.fonts
    ? fontFaceCss([ds.fonts.display.family, ds.fonts.text.family], opts.fontBase ?? FONTS_BASE)
    : "";
  return [
    faces,
    `${root}{${decl(designSystemVars(ds))}${colors(first)}}`,
    `${on(first)}{${colors(first)}}`,
    `${on(other)}{${colors(other)}}`,
    `@media (prefers-color-scheme: ${other}){${on("auto")}{${colors(other)}}}`,
    `@media (prefers-reduced-motion: reduce){${root}{${reduced}}}`,
    KEYFRAMES,
    opts.theme === false ? "" : DESIGN_THEME_CSS,
  ]
    .filter(Boolean)
    .join("\n");
}
