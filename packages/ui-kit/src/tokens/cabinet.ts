// Cabinet look of client systems v2 (B2-34, ui-kit.yaml#tokens.cabinet; grill-7 #6–#7): the warm neutral palette of the
// platform design system under the cabinets, accents in the owner's brand colour with the contrast of businessColors.
// Pure: themeToTokens adds the --w-cab-* values of a scheme; cabinet.css maps --w-* onto them under
// [data-wz-look="cabinet"], so the brand colour reaches the page only through CSS variables (no injected <style>).
import { businessColors, PLATFORM_COLORS } from "../v2/tokens.js";
import { accentStrong } from "./accent.js";
import { blend } from "./color.js";

type Scheme = "light" | "dark";

/** Attribute value marking a cabinet subtree (and <html> while a cabinet component is mounted). */
export const CABINET_LOOK = "cabinet";

/** --w-* tokens the cabinet look replaces: each one takes the value of --w-cab-<name> of the current scheme. */
export const CABINET_MAPPED = [
  "bg",
  "surface",
  "surface-alt",
  "ink",
  "muted",
  "line",
  "ok",
  "warn",
  "bad",
  "neutral-soft",
  "ok-soft",
  "warn-soft",
  "bad-soft",
  "accent",
  "accent-ink",
  "accent-text",
  "accent-soft",
  "accent-tint",
  "accent-strong",
  "accent-edge",
  "focus",
  "shadow-sm",
  "shadow-md",
] as const;

/** Cabinet-only tokens with no --w-* counterpart (used directly by cabinet components). */
export const CABINET_EXTRA = ["sunken", "line-strong", "skel", "radius-card"] as const;

type Name = (typeof CABINET_MAPPED)[number] | (typeof CABINET_EXTRA)[number];

/** Every --w-cab-* token name (themeToTokens adds them to V2_TOKENS: a v1 theme keeps its v1 tokens). */
export const CABINET_TOKENS = [...CABINET_MAPPED, ...CABINET_EXTRA].map((n) => `--w-cab-${n}` as const);

const TONE_SOFT = { light: 0.12, dark: 0.16 } as const;
/** v2 depth (--p-sh-1 / --p-sh-2 of the platform), on the warm ink. */
const SHADOW = {
  light: [
    "0 0 0 1px rgba(48, 40, 28, 0.05), 0 1px 2px rgba(48, 40, 28, 0.05)",
    "0 0 0 1px rgba(48, 40, 28, 0.045), 0 1px 2px rgba(48, 40, 28, 0.04), 0 10px 24px -10px rgba(48, 40, 28, 0.09)",
  ],
  dark: [
    "0 0 0 1px rgba(255, 255, 255, 0.045), 0 1px 2px rgba(0, 0, 0, 0.3)",
    "0 0 0 1px rgba(255, 255, 255, 0.05), 0 1px 2px rgba(0, 0, 0, 0.3), 0 10px 24px -10px rgba(0, 0, 0, 0.4)",
  ],
} as const;
const SKEL = { light: "rgba(60, 52, 40, 0.08)", dark: "rgba(238, 236, 231, 0.075)" } as const;

/**
 * Cabinet values of one scheme for a brand colour (#RRGGBB, already normalised by resolveTheme). Fill ≥ 3:1 to bg and
 * surface, text on it ≥ 4.5:1, coloured text ≥ 4.5:1 on bg, surface, sunken and the accent washes (businessColors).
 */
export function cabinetValues(accent: string, scheme: Scheme): Record<Name, string> {
  const p = PLATFORM_COLORS[scheme];
  const b = businessColors(accent, scheme);
  const soft = (c: string) => blend(c, p.surface, TONE_SOFT[scheme]);
  const [sm, md] = SHADOW[scheme];
  return {
    bg: p.bg,
    surface: p.surface,
    "surface-alt": p.sunken,
    ink: p.ink,
    muted: p.ink2,
    line: p.line,
    ok: p.ok,
    warn: p.warn,
    bad: p.bad,
    "neutral-soft": soft(p.ink2),
    "ok-soft": soft(p.ok),
    "warn-soft": soft(p.warn),
    "bad-soft": soft(p.bad),
    accent: b.biz,
    "accent-ink": b.bizInk,
    "accent-text": b.bizText,
    "accent-soft": b.bizSoftSolid,
    "accent-tint": b.bizWash,
    "accent-strong": accentStrong(b.biz),
    "accent-edge": b.biz,
    focus: b.bizText,
    "shadow-sm": sm,
    "shadow-md": md,
    sunken: p.sunken,
    "line-strong": p.line2,
    skel: SKEL[scheme],
    "radius-card": "18px",
  };
}

type CabTokens = Record<`--w-cab-${string}`, string>;
const memo = new Map<string, CabTokens>();
const MEMO_MAX = 256;

/** --w-cab-* tokens of one scheme (part of themeToTokens; memoised — the contrast search is the costly part). */
export function cabinetTokens(accent: string, scheme: Scheme): CabTokens {
  const key = `${accent}|${scheme}`;
  let t = memo.get(key);
  if (!t) {
    t = Object.fromEntries(
      Object.entries(cabinetValues(accent, scheme)).map(([k, v]) => [`--w-cab-${k}`, v]),
    ) as CabTokens;
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(key, t);
  }
  return { ...t };
}

/**
 * CSS of the look (src/tokens/cabinet.css is this output, checked by test): under [data-wz-look="cabinet"] every mapped
 * --w-* token reads its --w-cab-* value. The attribute is repeated so the rule (0,3,0) wins over the theme's own blocks
 * (:root, [data-wz-mode=dark], [data-wz-tokens="…"][data-wz-mode=dark]) on the same element. Fallbacks — light values
 * of the default accent (shadows: none), for a page whose tokens came without --w-cab-* (an older bundle).
 */
export function cabinetCss(): string {
  const fallback = cabinetValues("#2F46D8", "light");
  const sel = `[data-wz-look="${CABINET_LOOK}"][data-wz-look][data-wz-look]`;
  // Lower-case hex and no shadow fallbacks: the file stays as biome formats it.
  const fb = (n: (typeof CABINET_MAPPED)[number]) =>
    n.startsWith("shadow") ? "none" : fallback[n].toLowerCase();
  const lines = CABINET_MAPPED.map((n) => `  --w-${n}: var(--w-cab-${n}, ${fb(n)});`);
  return [
    "/* Generated from src/tokens/cabinet.ts (cabinetCss) — do not edit by hand; test/cabinet.test.ts checks it. */\n",
    `${sel} {\n${lines.join("\n")}\n  color: var(--w-ink);\n}\n`,
  ].join("\n");
}
