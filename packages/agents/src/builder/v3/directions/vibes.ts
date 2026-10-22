// V5-04 (D80 (5)): the style step of the interview — 8 vibes with a live hero preview on the client's headline, a
// screenshot/link reference read by a vision model into tokens, and the merge where the brand colour wins.
import { z } from "zod";

export const FONT_KINDS = ["sans", "serif", "display", "mono"] as const;
export type FontKind = (typeof FONT_KINDS)[number];
export const DENSITIES = ["airy", "balanced", "dense"] as const;
export type Density = (typeof DENSITIES)[number];

/** Style tokens the director receives: palette, contrast, density, font kind (D80 (5)). */
export interface StyleTokens {
  background: string;
  text: string;
  accent: string;
  /** WCAG contrast of text on background, computed by code. */
  contrast: number;
  density: Density;
  fontKind: FontKind;
  /** Where the tokens come from, strongest last: vibe → reference → brand. */
  sources: ("vibe" | "reference" | "brand")[];
}

export interface Vibe {
  id: string;
  label: string;
  /** One line for the button. */
  hint: string;
  background: string;
  text: string;
  accent: string;
  density: Density;
  fontKind: FontKind;
}

export const VIBES: readonly Vibe[] = [
  {
    id: "workshop",
    label: "Мастерская",
    hint: "тёплая бумага, живые детали",
    background: "#f6f1e7",
    text: "#2a2118",
    accent: "#b4532a",
    density: "balanced",
    fontKind: "serif",
  },
  {
    id: "night",
    label: "Ночной продукт",
    hint: "тёмный фон, электрический акцент",
    background: "#0e1117",
    text: "#e8ecf4",
    accent: "#4f7cff",
    density: "balanced",
    fontKind: "sans",
  },
  {
    id: "clinic",
    label: "Чистая медицина",
    hint: "белый, воздух, спокойный зелёный",
    background: "#ffffff",
    text: "#12302b",
    accent: "#1f8a70",
    density: "airy",
    fontKind: "sans",
  },
  {
    id: "editorial",
    label: "Редакция",
    hint: "крупная антиква, журнальная сетка",
    background: "#faf8f4",
    text: "#111111",
    accent: "#c8102e",
    density: "airy",
    fontKind: "serif",
  },
  {
    id: "grid",
    label: "Инженерная сетка",
    hint: "моно, тонкие линии, плотно",
    background: "#f4f6f8",
    text: "#10151c",
    accent: "#0b6bcb",
    density: "dense",
    fontKind: "mono",
  },
  {
    id: "bold",
    label: "Плакат",
    hint: "крупный кегль, яркий блок",
    background: "#fff4d6",
    text: "#1a1a1a",
    accent: "#e8420f",
    density: "balanced",
    fontKind: "display",
  },
  {
    id: "soft",
    label: "Мягкий свет",
    hint: "пастель, скруглённые формы",
    background: "#fdf3f3",
    text: "#3a2a33",
    accent: "#c2587a",
    density: "airy",
    fontKind: "sans",
  },
  {
    id: "forest",
    label: "Природа",
    hint: "глубокий зелёный, натуральные тона",
    background: "#eef2ea",
    text: "#1d2a1f",
    accent: "#2f6b3a",
    density: "balanced",
    fontKind: "serif",
  },
];

export const vibeById = (id: string): Vibe | undefined => VIBES.find((v) => v.id === id);

const FONT_STACK: Record<FontKind, string> = {
  sans: "system-ui, 'Segoe UI', Roboto, sans-serif",
  serif: "Georgia, 'PT Serif', serif",
  display: "'Arial Black', Impact, sans-serif",
  mono: "ui-monospace, 'JetBrains Mono', Menlo, monospace",
};
const PAD: Record<Density, string> = { airy: "72px 40px", balanced: "48px 32px", dense: "28px 24px" };

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

/** Static hero of a vibe on the client's headline: a self-contained HTML fragment for the preview card. */
export function vibeHeroHtml(
  v: Pick<Vibe, "background" | "text" | "accent" | "density" | "fontKind">,
  headline: string,
  cta = "Оставить заявку",
): string {
  return (
    `<section style="background:${v.background};color:${v.text};padding:${PAD[v.density]};font-family:${FONT_STACK[v.fontKind]}">` +
    `<h1 style="margin:0 0 16px;font-size:${v.fontKind === "display" ? 44 : 36}px;line-height:1.1">${esc(headline)}</h1>` +
    `<a style="display:inline-block;padding:12px 22px;border-radius:8px;background:${v.accent};color:${onColor(v.accent)}">${esc(cta)}</a>` +
    `</section>`
  );
}

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
const rgb = (hex: string): [number, number, number] => {
  const h = hex.length === 4 ? `${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex.slice(1);
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const luminance = (hex: string): number => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** WCAG 2 contrast ratio of two #rgb / #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}
/** Text colour for a filled accent: black or white, whichever reads better. */
export const onColor = (bg: string): string =>
  contrastRatio(bg, "#ffffff") >= contrastRatio(bg, "#111111") ? "#ffffff" : "#111111";

const HEX = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);

/** What the vision model returns for a reference screenshot. */
export const referenceReadSchema = z.object({
  background: HEX,
  text: HEX,
  accent: HEX,
  density: z.enum(DENSITIES),
  fontKind: z.enum(FONT_KINDS),
});
export type ReferenceRead = z.output<typeof referenceReadSchema>;

/** Vision port: an image (data URL or address) in, the raw reading out. The host wires a model; tests a fixture. */
export type ReferenceReader = (image: { dataUrl: string } | { url: string }) => Promise<unknown>;

const BRAND = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);

function withContrast(t: Omit<StyleTokens, "contrast">): StyleTokens {
  let text = t.text;
  // Text below 4.5:1 is replaced by black or white: a reference never ships an unreadable page.
  if (contrastRatio(text, t.background) < 4.5) text = onColor(t.background);
  return { ...t, text, contrast: contrastRatio(text, t.background) };
}

export function vibeTokens(v: Vibe): StyleTokens {
  return withContrast({
    background: v.background,
    text: v.text,
    accent: v.accent,
    density: v.density,
    fontKind: v.fontKind,
    sources: ["vibe"],
  });
}

/** Reads a reference through the port; null when the reading is unusable (the style then comes from the vibes). */
export async function readReference(
  reader: ReferenceReader,
  image: { dataUrl: string } | { url: string },
): Promise<ReferenceRead | null> {
  try {
    const r = referenceReadSchema.safeParse(await reader(image));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * Tokens of the style step. The first chosen vibe is the base, the second one gives its accent only; a reference
 * overrides palette, density and font kind; the brand colour (logo or picked) always wins the accent.
 */
export function mergeStyleTokens(input: {
  vibes: readonly string[];
  reference?: ReferenceRead | null;
  brandColor?: string | null;
}): StyleTokens {
  const chosen = input.vibes.map(vibeById).filter((v): v is Vibe => !!v);
  const base = chosen[0] ?? (VIBES[0] as Vibe);
  let t = vibeTokens(base);
  if (chosen[1]) t = { ...t, accent: chosen[1].accent };
  if (input.reference) {
    const r = input.reference;
    t = {
      ...t,
      background: r.background,
      text: r.text,
      accent: r.accent,
      density: r.density,
      fontKind: r.fontKind,
      sources: [...t.sources, "reference"],
    };
  }
  const brand = BRAND.safeParse(input.brandColor ?? undefined);
  if (brand.success) t = { ...t, accent: brand.data, sources: [...t.sources, "brand"] };
  return withContrast(t);
}
