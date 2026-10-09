// Logo and references → principles, by code (V3-09; GZ-03: principles, never copies). A logo or a screenshot is read
// as pixels (RGBA, decoded by the caller): dominant colours in OKLCH, their warmth, saturation and contrast, the share
// of the background (rhythm). A page is read by the research tool (no JS): colours and fonts of its inline CSS, the
// rhythm and photos of its text. Only the client's own logo gives an exact colour (the brand colour); a reference gives
// tendencies. Texts, logos and layouts of references are never kept — only the principle lines below.
// Assumption (V3-09): screenshots are not shown to a vision model — the image PII filter for T1 (D45, D62) is not
// ready, so the principles come from pixels only.
import { hexToOklch } from "@wizard/ui-kit/themes";
import { parseRefinement } from "./lexicon.js";
import { type DirectionTuning, mergeTuning, normalizeTuning } from "./tuning.js";

/** A dominant colour: hex, its share of the opaque pixels (0–1) and OKLCH (hue in degrees). */
export interface ColorShare {
  hex: string;
  share: number;
  l: number;
  c: number;
  h: number;
}

export type ReferenceKind = "logo" | "screenshot" | "page" | "words";

/** What a reference says about the design, without its content. */
export interface ReferencePrinciples {
  kind: ReferenceKind;
  /** Only from the client's logo: its main chromatic colour. */
  brandColor?: string;
  /** Up to five dominant colours (hex), for the owner to recognise the reference. */
  palette: string[];
  warmth?: -1 | 1;
  saturation?: -1 | 1;
  contrast?: -1 | 1;
  density?: -1 | 1;
  scheme?: "dark";
  /** Headings in a serif, a sans or a serif/sans contrast. */
  type?: "serif" | "sans" | "contrast";
  photos?: boolean;
  /** Columns of the page grid. */
  grid?: number;
}

const DEG = 180 / Math.PI;
const MAX_SAMPLES = 160_000;

function hex2(n: number): string {
  return Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}
const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

function shareOf(hex: string, share: number): ColorShare {
  const o = hexToOklch(hex);
  const c = o.c < 1e-4 ? 0 : o.c;
  return { hex, share, l: o.l, c, h: c === 0 ? 0 : (((o.h * DEG) % 360) + 360) % 360 };
}

function okDistance(a: ColorShare, b: ColorShare): number {
  const ax = a.c * Math.cos(a.h / DEG);
  const ay = a.c * Math.sin(a.h / DEG);
  const bx = b.c * Math.cos(b.h / DEG);
  const by = b.c * Math.sin(b.h / DEG);
  return Math.hypot(a.l - b.l, ax - bx, ay - by);
}

/** Merges near colours (OKLab distance < `eps`), largest share first. */
function mergeNear(colors: ColorShare[], eps: number, max: number): ColorShare[] {
  const out: ColorShare[] = [];
  for (const c of [...colors].sort((a, b) => b.share - a.share)) {
    const near = out.find((x) => okDistance(x, c) < eps);
    if (near) near.share += c.share;
    else out.push({ ...c });
  }
  return out
    .sort((a, b) => b.share - a.share)
    .slice(0, max)
    .map((c) => ({ ...c, share: Math.round(c.share * 1000) / 1000 }));
}

/**
 * Dominant colours of an RGBA image (pixels with alpha < 128 skipped; at most ~160 000 pixels sampled): 4-bit buckets
 * per channel, averaged, then merged in OKLab. Pure: the caller decodes PNG or JPEG into the buffer.
 */
export function dominantColors(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  max = 6,
): ColorShare[] {
  const total = width * height;
  if (!total || rgba.length < total * 4) return [];
  const step = Math.max(1, Math.floor(Math.sqrt(total / MAX_SAMPLES)));
  const buckets = new Map<number, [number, number, number, number]>();
  let opaque = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if ((rgba[i + 3] as number) < 128) continue;
      const r = rgba[i] as number;
      const g = rgba[i + 1] as number;
      const b = rgba[i + 2] as number;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const acc = buckets.get(key) ?? [0, 0, 0, 0];
      acc[0] += r;
      acc[1] += g;
      acc[2] += b;
      acc[3] += 1;
      buckets.set(key, acc);
      opaque++;
    }
  }
  if (!opaque) return [];
  const colors = [...buckets.values()]
    .filter((a) => a[3] / opaque >= 0.002)
    .map((a) => shareOf(rgbHex(a[0] / a[3], a[1] / a[3], a[2] / a[3]), a[3] / opaque));
  return mergeNear(colors, 0.06, max);
}

const HEX_RE = /#([0-9a-f]{3}|[0-9a-f]{6})(?![0-9a-z])/gi;
const RGB_RE = /rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)/gi;

function longHex(h: string): string {
  const x = h.replace("#", "");
  return `#${(x.length === 3 ? x.replace(/./g, (c) => c + c) : x).toUpperCase()}`;
}

/** Colours written in a text (CSS, SVG): hex and rgb(), shares by how often each appears. */
export function colorsInText(text: string, max = 6): ColorShare[] {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(HEX_RE)) {
    const hex = longHex(m[0]);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  for (const m of text.matchAll(RGB_RE)) {
    const alpha = m[4] === undefined ? 1 : Number.parseFloat(m[4]) / (m[4].endsWith("%") ? 100 : 1);
    if (alpha < 0.5) continue;
    const hex = rgbHex(Number(m[1]), Number(m[2]), Number(m[3]));
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((s, n) => s + n, 0);
  if (!total) return [];
  return mergeNear(
    [...counts].map(([hex, n]) => shareOf(hex, n / total)),
    0.04,
    max,
  );
}

/** A colour that carries hue: not grey, not near black or white. */
const chromatic = (c: ColorShare) => c.c >= 0.05 && c.l > 0.18 && c.l < 0.94;

/** Warmth, saturation and contrast of a set of colours (the shared part of every principle). */
function colorTendencies(
  colors: readonly ColorShare[],
): Pick<ReferencePrinciples, "warmth" | "saturation" | "contrast"> {
  const out: Pick<ReferencePrinciples, "warmth" | "saturation" | "contrast"> = {};
  const hue = colors.filter(chromatic);
  const weight = hue.reduce((s, c) => s + c.share, 0);
  if (weight > 0) {
    const warm = hue.filter((c) => c.h >= 15 && c.h <= 105).reduce((s, c) => s + c.share, 0);
    const cool = hue.filter((c) => c.h >= 160 && c.h <= 300).reduce((s, c) => s + c.share, 0);
    if (warm / weight >= 0.6) out.warmth = 1;
    else if (cool / weight >= 0.6) out.warmth = -1;
    const chroma = hue.reduce((s, c) => s + c.c * c.share, 0) / weight;
    if (chroma >= 0.14) out.saturation = 1;
    else if (chroma <= 0.07) out.saturation = -1;
  } else if (colors.length) out.saturation = -1;
  const significant = colors.filter((c) => c.share >= 0.02);
  if (significant.length >= 2) {
    const ls = significant.map((c) => c.l);
    const spread = Math.max(...ls) - Math.min(...ls);
    if (spread >= 0.7) out.contrast = 1;
    else if (spread <= 0.35) out.contrast = -1;
  }
  return out;
}

/** Principles of a logo: the brand colour is its main chromatic colour (≥ 3 % of the logo), else none. */
export function logoPrinciples(colors: readonly ColorShare[]): ReferencePrinciples {
  const brand = colors.filter(chromatic).find((c) => c.share >= 0.03);
  return {
    kind: "logo",
    ...(brand ? { brandColor: brand.hex } : {}),
    palette: colors.slice(0, 5).map((c) => c.hex),
    ...colorTendencies(colors),
  };
}

/** Principles of a screenshot: colour tendencies, a dark page, the share of the background as the rhythm. */
export function screenshotPrinciples(colors: readonly ColorShare[]): ReferencePrinciples {
  const bg = colors[0];
  return {
    kind: "screenshot",
    palette: colors.slice(0, 5).map((c) => c.hex),
    ...colorTendencies(colors),
    ...(bg && bg.l < 0.35 ? { scheme: "dark" as const } : {}),
    ...(bg && bg.share >= 0.6
      ? { density: 1 as const }
      : bg && bg.share <= 0.35
        ? { density: -1 as const }
        : {}),
  };
}

const SERIF_FONTS =
  /\b(?:serif|georgia|times|garamond|playfair|merriweather|lora|literata|alegreya|cormorant|pt serif|noto serif|source serif|spectral|piazzolla|prata|ibm plex serif|libre baskerville|crimson|bodoni|didot|baskerville)\b/;
const SANS_FONTS =
  /\b(?:sans|inter|roboto|montserrat|onest|golos|manrope|arial|helvetica|open sans|commissioner|unbounded|rubik|nunito|raleway|ubuntu|exo|verdana|tahoma|system-ui)\b/;

/** font-family lists of a CSS text, lower case, with whether they sit in a heading rule. */
function fontFamilies(css: string): { family: string; heading: boolean }[] {
  const out: { family: string; heading: boolean }[] = [];
  const rules = css.matchAll(/([^{}]*)\{([^{}]*)\}/g);
  for (const m of rules) {
    const selector = (m[1] ?? "").toLowerCase();
    const heading = /\bh[1-3]\b|title|heading|display|hero/.test(selector);
    for (const f of (m[2] ?? "").matchAll(/font-family\s*:\s*([^;]+)/gi))
      out.push({ family: (f[1] ?? "").toLowerCase(), heading });
  }
  for (const f of css.matchAll(/(?:^|[;"'\s])font-family\s*:\s*([^;"']+)/gi))
    if (!out.some((x) => x.family === (f[1] ?? "").toLowerCase()))
      out.push({ family: (f[1] ?? "").toLowerCase(), heading: false });
  return out;
}

const isSerif = (family: string) =>
  SERIF_FONTS.test(family.replace(/sans-serif/g, "")) && !/\bsans\b/.test(family.split(",")[0] ?? "");

/**
 * Principles of a page from its HTML (inline <style> blocks, style attributes, theme-color) and its readable text
 * (markdown of the research tool). Linked stylesheets are not fetched (only what read_page itself loaded).
 */
export function pagePrinciples(html: string | null, markdown: string): ReferencePrinciples {
  const css = html
    ? [
        ...[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? ""),
        ...[...html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map((m) => `x{${m[1] ?? ""}}`),
        ...[...html.matchAll(/<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']+)["']/gi)].map(
          (m) => `x{color:${m[1] ?? ""}}`,
        ),
      ].join("\n")
    : "";
  const colors = colorsInText(css);
  const out: ReferencePrinciples = {
    kind: "page",
    palette: colors.slice(0, 5).map((c) => c.hex),
    ...colorTendencies(colors),
  };
  const fonts = fontFamilies(css);
  const head = fonts.filter((f) => f.heading);
  const serifHead = head.some((f) => isSerif(f.family));
  const anySerif = fonts.some((f) => isSerif(f.family));
  const anySans = fonts.some((f) => SANS_FONTS.test(f.family) && !isSerif(f.family));
  if (serifHead && anySans) out.type = "contrast";
  else if (serifHead || (anySerif && !anySans)) out.type = "serif";
  else if (anySans) out.type = "sans";
  const cols = /grid-template-columns\s*:\s*repeat\(\s*(\d{1,2})/i.exec(css);
  if (cols) out.grid = Number(cols[1]);
  else if (html && /\bcol-(?:sm|md|lg|xl)-\d{1,2}\b/.test(html)) out.grid = 12;
  const images = (markdown.match(/!\[[^\]]*\]\([^)]+\)/g) ?? []).length;
  if (images >= 3) out.photos = true;
  else if (images === 0 && markdown.length > 400) out.photos = false;
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#") && !p.startsWith("!["));
  const avg = paragraphs.length ? paragraphs.reduce((s, p) => s + p.length, 0) / paragraphs.length : 0;
  const headings = (markdown.match(/^#{1,3} /gm) ?? []).length;
  if (avg >= 380) out.density = -1;
  else if (paragraphs.length >= 3 && avg <= 160 && headings >= 2) out.density = 1;
  return out;
}

/** Principles of a reference as one Russian line for brief.design.references (≤ 500 characters). */
export function referenceLine(p: ReferencePrinciples, source: string): string {
  const parts: string[] = [];
  const palette = [
    p.warmth === 1 ? "тёплая" : p.warmth === -1 ? "холодная" : "",
    p.saturation === 1 ? "насыщенная" : p.saturation === -1 ? "приглушённая" : "",
  ].filter(Boolean);
  if (p.kind === "logo") {
    parts.push(
      p.brandColor
        ? `фирменный цвет ${p.brandColor}`
        : "монохромный, фирменного цвета нет — акцент подберёт направление",
    );
  } else if (p.palette.length) parts.push(`цвета ${p.palette.slice(0, 4).join(", ")}`);
  if (palette.length) parts.push(`палитра ${palette.join(", ")}`);
  if (p.contrast) parts.push(p.contrast === 1 ? "контраст высокий" : "контраст мягкий");
  if (p.scheme === "dark") parts.push("тёмный фон");
  if (p.type)
    parts.push(
      p.type === "contrast"
        ? "шрифты: антиква в заголовках, гротеск в тексте"
        : p.type === "serif"
          ? "шрифты: антиква"
          : "шрифты: гротеск",
    );
  if (p.density) parts.push(p.density === 1 ? "ритм просторный" : "ритм плотный");
  if (p.photos !== undefined) parts.push(p.photos ? "много фото" : "почти без фото");
  if (p.grid) parts.push(`сетка ${p.grid} колонок`);
  const head = p.kind === "logo" ? "Логотип" : source;
  const tail = p.kind === "logo" ? "" : " Принципы, без копирования текстов, логотипов и раскладки.";
  const body = parts.length ? parts.join("; ") : "явных принципов не нашлось — оформление подберёт система";
  return `${head}: ${body}.${tail}`.slice(0, 500);
}

/** The owner's words as a reference line (refinements the chosen direction keeps). */
export function wordsLine(words: readonly string[]): string {
  return `${WORDS_HEAD} ${words.join("; ")}.`.slice(0, 500);
}
export const WORDS_HEAD = "Пожелания словами:";
export const LOGO_HEAD = "Логотип:";

/** What the references of a brief give the directions: the brand colour, tuning hints and the type preference. */
export interface ReferenceHints {
  brandColor?: string;
  tuning: DirectionTuning;
  /** Headings the references prefer. */
  type?: "serif" | "sans" | "contrast";
  /** References that gave principles (logo, screenshots, pages, words). */
  used: number;
}

const BRAND_RE = /^Логотип: фирменный цвет (#[0-9A-F]{6})/i;

/** Reads brief.design.references (lines of referenceLine / wordsLine, or the owner's plain text) back into hints. */
export function referenceHints(refs: readonly string[]): ReferenceHints {
  const out: ReferenceHints = { tuning: {}, used: 0 };
  let hint: DirectionTuning = {};
  let words: DirectionTuning = {};
  for (const raw of refs) {
    const line = raw.trim();
    if (line.startsWith(LOGO_HEAD)) {
      // The logo gives the brand colour only: its own contrast or warmth say nothing about the site.
      const brand = BRAND_RE.exec(line);
      if (brand) out.brandColor = (brand[1] as string).toUpperCase();
      out.used++;
      continue;
    }
    if (line.startsWith(WORDS_HEAD)) {
      words = mergeTuning(words, parseRefinement(line.slice(WORDS_HEAD.length)).tuning);
      out.used++;
      continue;
    }
    const l = line.toLowerCase().replace(/ё/g, "е");
    const t: DirectionTuning = {};
    if (/палитра[^;.]*тепл/.test(l)) t.warmth = 1;
    if (/палитра[^;.]*холодн/.test(l)) t.warmth = -1;
    if (/палитра[^;.]*насыщенн/.test(l)) t.saturation = 1;
    if (/палитра[^;.]*приглушенн/.test(l)) t.saturation = -1;
    if (/контраст высокий/.test(l)) t.contrast = 1;
    if (/контраст мягкий/.test(l)) t.contrast = -1;
    if (/ритм просторный/.test(l)) t.density = 1;
    if (/ритм плотный/.test(l)) t.density = -1;
    if (/темный фон/.test(l)) t.scheme = "dark";
    if (/почти без фото/.test(l)) t.photos = false;
    else if (/много фото/.test(l)) t.photos = true;
    if (/антиква в заголовках/.test(l)) out.type = "contrast";
    else if (/шрифты: антиква/.test(l)) out.type ??= "serif";
    else if (/шрифты: гротеск/.test(l)) out.type ??= "sans";
    if (Object.keys(t).length) out.used++;
    hint = mergeTuning(hint, t);
  }
  // References are hints (one step at most); the owner's words keep their full strength.
  const capped: DirectionTuning = { ...hint };
  for (const [k, v] of Object.entries(hint))
    if (typeof v === "number") (capped as Record<string, number>)[k] = Math.sign(v);
  out.tuning = normalizeTuning(mergeTuning(capped, words));
  return out;
}
