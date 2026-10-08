// Four design systems in the shape of C2 (builder-v3.md: designSystemCss → CSS variables + @theme) until V3-07 lands:
// contrasting archetypes for the pattern matrix — a strict serif (reestr), a fine high-contrast one (atelie), a loud
// wide poster (afisha) and a soft care look (zabota). Palettes after catalog E4, written in OKLCH like C2 asks.
import { fontFaceCss } from "@wizard/ui-kit/fonts";
import { contrast, hexToOklch } from "@wizard/ui-kit/themes";

type Colors = {
  background: string;
  foreground: string;
  card: string;
  "card-foreground": string;
  primary: string;
  "primary-foreground": string;
  muted: string;
  "muted-foreground": string;
  border: string;
  ring: string;
  inverse: string;
  "inverse-foreground": string;
  scrim: string;
  "scrim-foreground": string;
};

export interface DesignFixture {
  id: string;
  fonts: { display: string; text: string };
  motion: "still" | "calm" | "lively";
  light: Colors;
  dark: Colors;
  /** Opacity of the scrim over photos. */
  scrimAlpha: number;
  text: Record<"hero" | "h1" | "h2" | "h3" | "lead" | "body" | "small", string>;
  radius: Record<"sm" | "md" | "lg" | "control", string>;
  section: string;
}

const LEADING = { hero: 1.08, h1: 1.1, h2: 1.2, h3: 1.25, lead: 1.5, body: 1.55, small: 1.45 } as const;
const TRACKING = {
  hero: "-0.02em",
  h1: "-0.02em",
  h2: "-0.01em",
  h3: "-0.01em",
  lead: "0",
  body: "0",
  small: "0",
};
const BODY = {
  lead: "clamp(1.125rem, 1.08rem + 0.2vw, 1.25rem)",
  body: "clamp(1rem, 0.95rem + 0.22vw, 1.125rem)",
};

export const DESIGN_FIXTURES: readonly DesignFixture[] = [
  {
    id: "reestr",
    fonts: { display: "PT Serif", text: "Source Sans 3" },
    motion: "still",
    scrimAlpha: 0.78,
    light: {
      background: "#F4F6F8",
      foreground: "#121826",
      card: "#FFFFFF",
      "card-foreground": "#121826",
      primary: "#1D6A55",
      "primary-foreground": "#FFFFFF",
      muted: "#E7EBEF",
      "muted-foreground": "#4B5565",
      border: "#CBD2DA",
      ring: "#1D6A55",
      inverse: "#121826",
      "inverse-foreground": "#F4F6F8",
      scrim: "#0B0F14",
      "scrim-foreground": "#F4F6F8",
    },
    dark: {
      background: "#0F1318",
      foreground: "#E9EDF2",
      card: "#171C23",
      "card-foreground": "#E9EDF2",
      primary: "#5FC2A4",
      "primary-foreground": "#0F1318",
      muted: "#1D232B",
      "muted-foreground": "#A2ACBA",
      border: "#2E3640",
      ring: "#5FC2A4",
      inverse: "#E9EDF2",
      "inverse-foreground": "#0F1318",
      scrim: "#05080B",
      "scrim-foreground": "#E9EDF2",
    },
    text: {
      hero: "clamp(2.438rem, 2.046rem + 1.74vw, 3.438rem)",
      h1: "clamp(1.938rem, 1.62rem + 1.41vw, 2.75rem)",
      h2: "clamp(1.5625rem, 1.45rem + 0.5vw, 1.76rem)",
      h3: "clamp(1.25rem, 1.2rem + 0.25vw, 1.406rem)",
      ...BODY,
      small: "0.875rem",
    },
    radius: { sm: "2px", md: "4px", lg: "6px", control: "4px" },
    section: "clamp(3.5rem, 2.2rem + 5.6vw, 6rem)",
  },
  {
    id: "atelie",
    fonts: { display: "Cormorant Garamond", text: "Commissioner" },
    motion: "calm",
    scrimAlpha: 0.8,
    light: {
      background: "#F6F6F7",
      foreground: "#18191D",
      card: "#FFFFFF",
      "card-foreground": "#18191D",
      primary: "#5A1F3D",
      "primary-foreground": "#FFFFFF",
      muted: "#ECEDF0",
      "muted-foreground": "#555963",
      border: "#D7D9DE",
      ring: "#5A1F3D",
      inverse: "#1E1A1D",
      "inverse-foreground": "#F6F6F7",
      scrim: "#120E11",
      "scrim-foreground": "#F6F6F7",
    },
    dark: {
      background: "#141518",
      foreground: "#EEEBEE",
      card: "#1C1D21",
      "card-foreground": "#EEEBEE",
      primary: "#E3A9C2",
      "primary-foreground": "#141518",
      muted: "#232429",
      "muted-foreground": "#A7A3AC",
      border: "#34353B",
      ring: "#E3A9C2",
      inverse: "#EEEBEE",
      "inverse-foreground": "#141518",
      scrim: "#08080A",
      "scrim-foreground": "#EEEBEE",
    },
    text: {
      hero: "clamp(2.75rem, 2.065rem + 3.04vw, 4.5rem)",
      h1: "clamp(2.25rem, 1.736rem + 2.28vw, 3.562rem)",
      h2: "clamp(1.777rem, 1.6rem + 0.8vw, 2rem)",
      h3: "clamp(1.333rem, 1.27rem + 0.3vw, 1.5rem)",
      ...BODY,
      small: "0.875rem",
    },
    radius: { sm: "0px", md: "0px", lg: "0px", control: "0px" },
    section: "clamp(4.5rem, 2.9rem + 7vw, 8rem)",
  },
  {
    id: "afisha",
    fonts: { display: "Unbounded", text: "Onest" },
    motion: "lively",
    scrimAlpha: 0.8,
    light: {
      background: "#FFFFFF",
      foreground: "#17120F",
      card: "#F4F4F2",
      "card-foreground": "#17120F",
      primary: "#C2341C",
      "primary-foreground": "#FFFFFF",
      muted: "#EFEEEA",
      "muted-foreground": "#5B5450",
      border: "#D9D6D0",
      ring: "#17120F",
      inverse: "#17120F",
      "inverse-foreground": "#FFFFFF",
      scrim: "#0D0A08",
      "scrim-foreground": "#FFFFFF",
    },
    dark: {
      background: "#111216",
      foreground: "#F3F0E7",
      card: "#1A1C24",
      "card-foreground": "#F3F0E7",
      primary: "#E6DE4E",
      "primary-foreground": "#111216",
      muted: "#20222B",
      "muted-foreground": "#ABA79C",
      border: "#33353F",
      ring: "#E6DE4E",
      inverse: "#F3F0E7",
      "inverse-foreground": "#111216",
      scrim: "#050507",
      "scrim-foreground": "#F3F0E7",
    },
    text: {
      hero: "clamp(2.25rem, 1.7rem + 2.4vw, 3.75rem)",
      h1: "clamp(1.875rem, 1.5rem + 1.6vw, 2.75rem)",
      h2: "clamp(1.5rem, 1.35rem + 0.6vw, 1.875rem)",
      h3: "clamp(1.2rem, 1.15rem + 0.2vw, 1.35rem)",
      ...BODY,
      small: "0.875rem",
    },
    radius: { sm: "8px", md: "14px", lg: "24px", control: "999px" },
    section: "clamp(3.5rem, 2.2rem + 5.6vw, 6rem)",
  },
  {
    id: "zabota",
    fonts: { display: "Wix Madefor Display", text: "Wix Madefor Text" },
    motion: "calm",
    scrimAlpha: 0.78,
    light: {
      background: "#F1F6F5",
      foreground: "#10201E",
      card: "#FFFFFF",
      "card-foreground": "#10201E",
      primary: "#1C5F5A",
      "primary-foreground": "#FFFFFF",
      muted: "#E3EDEB",
      "muted-foreground": "#475A57",
      border: "#C9D8D5",
      ring: "#1C5F5A",
      inverse: "#10201E",
      "inverse-foreground": "#F1F6F5",
      scrim: "#081210",
      "scrim-foreground": "#F1F6F5",
    },
    dark: {
      background: "#0E1716",
      foreground: "#E6F0EE",
      card: "#152120",
      "card-foreground": "#E6F0EE",
      primary: "#6CC4BA",
      "primary-foreground": "#0E1716",
      muted: "#1A2827",
      "muted-foreground": "#9FB3AF",
      border: "#2A3A38",
      ring: "#6CC4BA",
      inverse: "#E6F0EE",
      "inverse-foreground": "#0E1716",
      scrim: "#040908",
      "scrim-foreground": "#E6F0EE",
    },
    text: {
      hero: "clamp(2rem, 1.7rem + 1.3vw, 2.75rem)",
      h1: "clamp(1.75rem, 1.55rem + 0.9vw, 2.25rem)",
      h2: "clamp(1.4rem, 1.33rem + 0.3vw, 1.6rem)",
      h3: "clamp(1.2rem, 1.17rem + 0.15vw, 1.3rem)",
      lead: "1.125rem",
      body: "clamp(1rem, 0.98rem + 0.1vw, 1.0625rem)",
      small: "0.875rem",
    },
    radius: { sm: "6px", md: "10px", lg: "16px", control: "10px" },
    section: "clamp(4.5rem, 2.9rem + 7vw, 8rem)",
  },
];

/** OKLCH of a hex colour, as C2 writes palettes. */
export function oklch(hex: string, alpha?: number): string {
  const { l, c, h } = hexToOklch(hex);
  const deg = ((((h * 180) / Math.PI) % 360) + 360) % 360;
  const a = alpha === undefined ? "" : ` / ${alpha}`;
  return `oklch(${(l * 100).toFixed(2)}% ${c.toFixed(4)} ${deg.toFixed(2)}${a})`;
}

function colorVars(c: Colors, scrimAlpha: number): string[] {
  return Object.entries(c).map(
    ([k, v]) => `--color-${k}: ${k === "scrim" ? oklch(v, scrimAlpha) : oklch(v)};`,
  );
}

const stack = (family: string, serif: boolean) =>
  `"${family}", ${serif ? 'Georgia, "Times New Roman", serif' : 'system-ui, "Segoe UI", sans-serif'}`;
const SERIF = new Set(["PT Serif", "Cormorant Garamond", "Literata", "Lora", "Piazzolla", "Alegreya"]);

/** ui/design.css of a fixture: @font-face, @theme (defaults reset, light values), :root motion, dark colours. */
export function designCss(f: DesignFixture): string {
  const text = Object.entries(f.text).flatMap(([k, v]) => [
    `--text-${k}: ${v};`,
    `--text-${k}--line-height: ${LEADING[k as keyof typeof LEADING]};`,
    `--text-${k}--letter-spacing: ${TRACKING[k as keyof typeof TRACKING]};`,
  ]);
  return [
    `/* design system «${f.id}» (test fixture after C2) */`,
    fontFaceCss([f.fonts.display, f.fonts.text]),
    "@theme {",
    "  --color-*: initial;",
    "  --font-*: initial;",
    "  --text-*: initial;",
    "  --radius-*: initial;",
    ...colorVars(f.light, f.scrimAlpha).map((l) => `  ${l}`),
    `  --font-display: ${stack(f.fonts.display, SERIF.has(f.fonts.display))};`,
    `  --font-sans: ${stack(f.fonts.text, SERIF.has(f.fonts.text))};`,
    ...text.map((l) => `  ${l}`),
    ...Object.entries(f.radius).map(([k, v]) => `  --radius-${k}: ${v};`),
    `  --spacing-section: ${f.section};`,
    "  --spacing-gutter: clamp(1rem, 0.4rem + 2.6vw, 2.5rem);",
    "  --container-page: 75rem;",
    "  --container-text: 38rem;",
    "  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);",
    "}",
    `:root { --ds-motion: ${f.motion}; color-scheme: light dark; }`,
    // Document colours and face belong to the design system (above the ui-kit document rules of layer «wizard»).
    "html { background-color: var(--color-background); color: var(--color-foreground); font-family: var(--font-sans); }",
    "@media (prefers-color-scheme: dark) {",
    "  :root {",
    ...colorVars(f.dark, f.scrimAlpha).map((l) => `    ${l}`),
    "  }",
    "}",
    "",
  ].join("\n");
}

/** Text pairs of a fixture with their WCAG contrast (the scrim over white and over black: photos behind it). */
export function fixtureContrasts(f: DesignFixture): { pair: string; ratio: number }[] {
  const out: { pair: string; ratio: number }[] = [];
  for (const [mode, c] of [
    ["light", f.light],
    ["dark", f.dark],
  ] as const) {
    const pairs: [string, string, string][] = [
      ["foreground/background", c.foreground, c.background],
      ["foreground/muted", c.foreground, c.muted],
      ["card-foreground/card", c["card-foreground"], c.card],
      ["muted-foreground/background", c["muted-foreground"], c.background],
      ["muted-foreground/card", c["muted-foreground"], c.card],
      ["muted-foreground/muted", c["muted-foreground"], c.muted],
      ["primary-foreground/primary", c["primary-foreground"], c.primary],
      ["inverse-foreground/inverse", c["inverse-foreground"], c.inverse],
    ];
    for (const [pair, fg, bg] of pairs)
      out.push({ pair: `${f.id} ${mode} ${pair}`, ratio: contrast(fg, bg) });
    for (const under of ["#FFFFFF", "#000000"]) {
      const bg = mix(c.scrim, under, f.scrimAlpha);
      out.push({
        pair: `${f.id} ${mode} scrim-foreground/scrim over ${under}`,
        ratio: contrast(c["scrim-foreground"], bg),
      });
    }
  }
  return out;
}

function mix(top: string, bottom: string, alpha: number): string {
  const ch = (h: string, i: number) => Number.parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
  const v = [0, 1, 2].map((i) => Math.round(ch(top, i) * alpha + ch(bottom, i) * (1 - alpha)));
  return `#${v.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
