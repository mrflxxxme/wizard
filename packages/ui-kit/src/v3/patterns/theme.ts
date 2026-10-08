// The theme patterns are written against (builder-v3.md C2, C3): Tailwind utilities over these theme variables only.
// designSystemCss (V3-07) defines each of them in @theme (light values) and redefines the colours on :root for the
// dark scheme; the default Tailwind palette, fonts and text sizes are reset (`--color-*: initial` and so on).

/** Theme keys by Tailwind namespace: `bg-primary` → --color-primary, `text-h2` → --text-h2, `max-w-page` → --container-page. */
export const PATTERN_THEME = {
  /** shadcn names (models know them): background/foreground pairs; inverse — the contrasting band; scrim — over photos. */
  color: [
    "background",
    "foreground",
    "card",
    "card-foreground",
    "primary",
    "primary-foreground",
    "muted",
    "muted-foreground",
    "border",
    "ring",
    "inverse",
    "inverse-foreground",
    "scrim",
    "scrim-foreground",
  ],
  /** display — headings, sans — text (pairs of the D64 catalog). */
  font: ["display", "sans"],
  /** Type scale with line height and tracking (catalog E1). */
  text: ["hero", "h1", "h2", "h3", "lead", "body", "small"],
  /** control — buttons and fields (pill or the theme radius). */
  radius: ["sm", "md", "lg", "control"],
  /** section — vertical padding of a section, gutter — page side padding (catalog E2). */
  spacing: ["section", "gutter"],
  /** page — content width, text — measure of running text. */
  container: ["page", "text"],
} as const;

/** Custom property with the motion profile of the design system on :root: still | calm | lively (catalog E3). */
export const MOTION_PROFILE_VAR = "--ds-motion";

/** Every CSS variable the patterns rely on: theme variables plus the motion profile. */
export function patternThemeVars(): string[] {
  return [
    ...Object.entries(PATTERN_THEME).flatMap(([ns, keys]) => keys.map((k) => `--${ns}-${k}`)),
    MOTION_PROFILE_VAR,
  ];
}
