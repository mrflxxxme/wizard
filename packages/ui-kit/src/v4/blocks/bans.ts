// Bans of grill-11 (8), for ever: the template first screen, AI palettes without an explicit brand choice, AI text.
// The anti-AI editor (V5-03) and the catalog tests run the same checks.
import { contrast, hexToOklch } from "../../tokens/color.js";
import type { DesignSystemV3 } from "../../v3/design/index.js";
import { isCream, schemeHex } from "../../v3/design/index.js";

const L = "\\p{L}";
/** Phrases of AI copy (Russian), each with a reason the editor shows. */
export const AI_PHRASES: readonly { re: RegExp; why: string }[] = [
  { re: /\s—\s/u, why: "тире-вставка" },
  { re: new RegExp(`(^|[^${L}])не\\s[^,.!?]+,\\s*а\\s`, "iu"), why: "«не X, а Y»" },
  { re: new RegExp(`(^|[^${L}])не просто\\s`, "iu"), why: "«не просто»" },
  { re: /мы заботимся|с заботой о|с любовью/iu, why: "забота без факта" },
  {
    re: /индивидуальн\p{L}* подход|команда профессионалов|опытн\p{L}* специалист|лучш\p{L}* специалист/iu,
    why: "штамп про команду",
  },
  { re: /широк\p{L}* (спектр|ассортимент)|высок\p{L}* качеств|качественн/iu, why: "качество без цифры" },
  { re: /доступн\p{L}* цен|приятн\p{L}* цен|выгодн\p{L}* цен/iu, why: "цена без цифры" },
  { re: /в кратчайшие сроки|быстро и качественно|оперативно/iu, why: "срок без цифры" },
  {
    re: /уникальн|незабываем|идеальн|безупречн|инновацион|премиальн/iu,
    why: "превосходная степень без факта",
  },
  {
    re: /погрузитесь|откройте для себя|окунитесь|в самое сердце|атмосфер\p{L}* уюта/iu,
    why: "рекламный зачин",
  },
  { re: /ваш(е|его)? (комфорт|удовольствие)|для вас и ваших близких/iu, why: "обещание без цифры" },
  {
    re: new RegExp(
      `[${L}]+(ый|ий|ой|ая|яя|ое|ее|ые|ие),\\s+[${L}]+(ый|ий|ой|ая|яя|ое|ее|ые|ие),?\\s+(и\\s+)?[${L}]+(ый|ий|ой|ая|яя|ое|ее|ые|ие)(?![${L}])`,
      "iu",
    ),
    why: "тройка прилагательных",
  },
];

/** Reasons a Russian string reads as AI copy (empty when clean). */
export const aiTextErrors = (s: string): string[] => AI_PHRASES.filter((p) => p.re.test(s)).map((p) => p.why);

/** Every string inside a content value (for running aiTextErrors over a whole page). */
export const contentStrings = (v: unknown): string[] =>
  typeof v === "string"
    ? [v]
    : Array.isArray(v) || (v && typeof v === "object" && !("$$typeof" in v))
      ? Object.values(v).flatMap(contentStrings)
      : [];

const SERIF =
  /serif|garamond|playfair|lora|literata|alegreya$|piazzolla|merriweather|cormorant|pt serif|spectral/i;
/** OKLCH of a hex colour with the hue in degrees 0–360. */
const hue = (hex: string) => {
  const o = hexToOklch(hex);
  return { ...o, h: ((o.h * 180) / Math.PI + 360) % 360 };
};

/** Palette bans of grill-11 (8); `brandChoice` is the written reason for the brand colour and fonts. */
export function paletteBanErrors(ds: DesignSystemV3, brandChoice: string): string[] {
  const out: string[] = [];
  if (brandChoice.trim().length < 40) out.push("нет явного выбора бренда: цвет и шрифты без причины");
  const light = schemeHex(ds.palette.light);
  const dark = schemeHex(ds.palette.dark);
  const used = ds.palette.scheme === "dark" ? dark : light;
  const acc = hue(used.accent);
  // Cream ground, serif headings, terracotta accent (hue ≈ 25–60°, warm and earthy).
  if (isCream(light.bg) && SERIF.test(ds.fonts.display.family) && acc.h >= 20 && acc.h <= 60 && acc.c > 0.08)
    out.push("крем, засечки и терракота");
  // Violet-blue: accent and second accent both in 240–320°, the gradient pair of AI landings.
  const a2 = hue(used.accent2);
  if (acc.h >= 250 && acc.h <= 320 && a2.h >= 240 && a2.h <= 320 && acc.c > 0.1 && a2.c > 0.1)
    out.push("фиолетово-синяя пара для градиента");
  // Black with an acid accent: near-black ground, a loud yellow-green or green accent.
  if (hue(used.bg).l < 0.22 && acc.c > 0.17 && acc.h >= 95 && acc.h <= 160)
    out.push("чёрный с кислотным акцентом");
  return out;
}

/** WCAG contrast of the text pairs the blocks paint (scheme in use); each must be ≥ 4.5. */
export function blockContrastPairs(ds: DesignSystemV3): { pair: string; ratio: number }[] {
  const h = schemeHex(ds.palette[ds.palette.scheme === "dark" ? "dark" : "light"]);
  const overlay = h.overlay.slice(0, 7);
  return [
    ["текст на фоне", h.ink, h.bg],
    ["текст на второй подложке", h.ink, h.surfaceAlt],
    ["приглушённый текст на фоне", h.muted, h.bg],
    ["приглушённый текст на второй подложке", h.muted, h.surfaceAlt],
    ["кнопка", h.accentInk, h.accent],
    ["акцентный текст на фоне", h.accentText, h.bg],
    ["акцентный текст на второй подложке", h.accentText, h.surfaceAlt],
    ["текст на вуали фото", h.overlayInk, overlay],
  ].map(([pair, fg, bg]) => ({ pair: pair as string, ratio: contrast(fg as string, bg as string) }));
}

/**
 * Template first screen and its relatives in rendered markup (grill-11 (8)): a centred hero with a kicker plaque and
 * two buttons, an icon in a coloured square, a row of three feature cards.
 */
export function templateMarkupErrors(html: string): string[] {
  const out: string[] = [];
  const hero = html.match(/<section[\s\S]*?<\/section>/)?.[0] ?? "";
  const actions = (hero.match(/<(a|button)\b[^>]*class="[^"]*(bg-primary|border-primary)[^"]*"/g) ?? [])
    .length;
  if (/<h1/.test(hero) && /text-center/.test(hero) && actions >= 2)
    out.push("первый экран по центру с двумя кнопками");
  if (/class="[^"]*rounded-full[^"]*bg-[^"]*"[^>]*>[^<]{1,40}<\/(span|p|div)>[\s\S]{0,200}<h1/.test(hero))
    out.push("плашка-надзаголовок");
  if (/<(div|span)[^>]*class="[^"]*(rounded[^"]*\bbg-|\bbg-[^"]*rounded)[^"]*"[^>]*>\s*<svg/.test(html))
    out.push("иконка в цветном квадрате");
  if (/grid-cols-3[^"]*"[^>]*>(\s*<(li|div)[^>]*>\s*<(div|span)[^>]*>\s*<svg[\s\S]*?<h3){3}/.test(html))
    out.push("три карточки преимуществ в ряд");
  return out;
}
