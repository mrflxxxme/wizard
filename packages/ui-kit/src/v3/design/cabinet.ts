// Staff cabinets in the client's style (V3-12; D77 (5): cabinets from the library in the client's style): the --w-cab-*
// tokens of the cabinet look (tokens/cabinet.ts) computed from the client's design system v3 — its surfaces, ink,
// lines, accent pairs, focus and card radius — instead of the platform's warm neutrals with the brand colour. The
// contrast pairs are the ones designLint keeps at AA (ink, muted and accent text on the backgrounds, the button
// label on the accent). Pure: the bundle's theme tokens take these values when a v3 system mounts its cabinets.
import type { CABINET_EXTRA, CABINET_MAPPED } from "../../tokens/cabinet.js";
import { blend, hexToRgb } from "../../tokens/color.js";
import { type SchemeName, schemeHex } from "./palette.js";
import type { DesignSystemV3 } from "./system.js";

export type CabinetTokenName = (typeof CABINET_MAPPED)[number] | (typeof CABINET_EXTRA)[number];

const SOFT = { light: 0.12, dark: 0.16 } as const;
const TINT = { light: 0.08, dark: 0.12 } as const;

const rgba = (hex: string, a: number) => {
  const [r, g, b] = hexToRgb(hex).map((x) => Math.round(x * 255));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

/** Cabinet values of one scheme from a design system v3 (hex colours, shadows by its depth, card radius). */
export function cabinetValuesV3(ds: DesignSystemV3, scheme: SchemeName): Record<CabinetTokenName, string> {
  const h = schemeHex(ds.palette[scheme]);
  const soft = (c: string) => blend(c, h.surface, SOFT[scheme]);
  const shadow =
    ds.depth === "soft"
      ? [
          `0 1px 2px ${rgba(h.ink, 0.06)}`,
          `0 1px 2px ${rgba(h.ink, 0.06)}, 0 8px 24px -12px ${rgba(h.ink, scheme === "dark" ? 0.4 : 0.18)}`,
        ]
      : ["none", "none"];
  return {
    bg: h.bg,
    surface: h.surface,
    "surface-alt": h.surfaceAlt,
    ink: h.ink,
    muted: h.muted,
    line: h.line,
    ok: h.ok,
    warn: h.warn,
    bad: h.bad,
    "neutral-soft": soft(h.muted),
    "ok-soft": soft(h.ok),
    "warn-soft": soft(h.warn),
    "bad-soft": soft(h.bad),
    accent: h.accent,
    "accent-ink": h.accentInk,
    "accent-text": h.accentText,
    "accent-soft": h.accentSoft,
    "accent-tint": blend(h.accent, h.surface, TINT[scheme]),
    "accent-strong": h.accentStrong,
    "accent-edge": h.accentEdge,
    focus: h.focus,
    "shadow-sm": shadow[0] as string,
    "shadow-md": shadow[1] as string,
    sunken: h.surfaceAlt,
    "line-strong": h.border,
    skel: blend(h.ink, h.surface, 0.08),
    "radius-card": `${ds.radius.lg}px`,
  };
}

/** --w-cab-* tokens of one scheme from a design system v3 (the same names tokens/cabinet.ts maps onto --w-*). */
export function cabinetTokensV3(ds: DesignSystemV3, scheme: SchemeName): Record<`--w-cab-${string}`, string> {
  return Object.fromEntries(
    Object.entries(cabinetValuesV3(ds, scheme)).map(([k, v]) => [`--w-cab-${k}`, v]),
  ) as Record<`--w-cab-${string}`, string>;
}
