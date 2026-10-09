// G2 dictionaries (packages/gates/data/*.json, generated from specs/security/abuse.yaml#patterns) and the matching
// primitives of abuse.yaml#patterns.normalize / word_boundary: normalisation, Unicode word boundaries, brand search.
import { readFileSync } from "node:fs";
import { normalizeText as normalize } from "@wizard/appspec";

export interface AbuseData {
  homoglyphs: [string, string][];
  card: { names: string; autocomplete: string[] };
  credentials: { names: string };
  govIds: { names: string; fileDocs: string };
  brands: {
    shortLength: number;
    formsContext: string;
    formsWindow: number;
    ambiguous: string[];
    ambiguousContext: string;
    ambiguousWindow: number;
    connectorAllowlist: Record<string, string[]>;
    /** abuse.yaml#patterns.brands.match.identity_means: a brand named as a means of payment/delivery is no claim. */
    identityMeans: { categories: string[]; means: string; joiners: string; deny: string };
  };
  p2p: { words: string; window: number };
  crypto: { names: string; tokens: string[]; calls: string[]; strings: string[] };
  secrets: {
    regex: string[];
    entropy: { minLength: number; minBits: number; window: number; context: string };
  };
  piiNames: { strong: string; weak: string; weakExceptions: string };
  special: { names: string };
  scoring: { signals: Record<string, number>; urgentWords: string; threshold: number };
  /** abuse.yaml#messages_ru: neutral texts, no rule disclosure. */
  messages: Record<string, string>;
}

export interface Brand {
  id: string;
  names: string[];
  domains: string[];
  category: string;
  ambiguous?: boolean;
}

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../../data/${name}`, import.meta.url), "utf8")) as T;

export const ABUSE: AbuseData = load("abuse.json");
export const BRANDS: readonly Brand[] = load("brands.ru.json");

// abuse.yaml#patterns.normalize / word_boundary live in @wizard/appspec (B2-46): G2-PII-02 and the pii marking of
// module extra fields share them.
export { firstMatch, normalizeText as normalize, splitIdent, unicodeRx as rx } from "@wizard/appspec";

const CYR_TO_LAT = new Map(ABUSE.homoglyphs.map(([c, l]) => [c, l]));

/** Every Cyrillic homoglyph mapped to Latin: the comparison key of brand search. */
export function skeleton(s: string): string {
  return [...s].map((ch) => CYR_TO_LAT.get(ch) ?? ch).join("");
}

/** Levenshtein distance, early exit above `max`. */
export function levenshtein(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] as number;
}

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return digits.length >= 12 && sum % 10 === 0;
}

/** Shannon entropy, bits per character. */
export function shannon(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Is there a match of `re` within `window` characters around [start, end) of text? */
export function near(re: RegExp, text: string, start: number, end: number, window: number): boolean {
  const from = Math.max(0, start - window);
  const slice = text.slice(from, Math.min(text.length, end + window));
  re.lastIndex = 0;
  for (let m = re.exec(slice); m; m = re.exec(slice)) {
    const s = from + m.index;
    const e = s + m[0].length;
    if (e <= start || s >= end) return true;
    if (m[0].length === 0) re.lastIndex++;
  }
  return false;
}

// ------------------------------------------------------------------------------------------------ brands

const TRANSLIT: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

/** Cyrillic → Latin transliteration of a normalized string (slugs are Latin: gosuslugi = Госуслуги). */
export function translit(s: string): string {
  return [...s].map((ch) => TRANSLIT[ch] ?? ch).join("");
}

interface BrandName {
  brand: Brand;
  name: string;
  key: string;
  /** Transliterated key (slug zone). */
  tkey: string;
  tokens: number;
  short: boolean;
  ambiguous: boolean;
}

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

function tokens(text: string): { t: string; start: number; end: number }[] {
  const out: { t: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    out.push({ t: skeleton(m[0]), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const NAMES: readonly BrandName[] = BRANDS.flatMap((brand) =>
  brand.names.map((name) => {
    const t = tokens(normalize(name));
    const key = t.map((x) => x.t).join("");
    return {
      brand,
      name,
      key,
      tkey: translit(normalize(name)).replace(/[^\p{L}\p{N}]+/gu, ""),
      tokens: t.length,
      short: [...key].length < ABUSE.brands.shortLength,
      ambiguous: brand.ambiguous === true,
    };
  }),
);

export interface BrandHit {
  brand: Brand;
  name: string;
  /** 0 exact, 1–2 Levenshtein (names ≥ 5 characters only). */
  distance: number;
  short: boolean;
  ambiguous: boolean;
  /** Offsets in the normalized text. */
  start: number;
  end: number;
}

/** Brand names in a normalized text: adjacent tokens joined (Сбер-Банк = СберБанк), fuzzy up to distance 2. */
export function findBrands(normText: string, o: { translit?: boolean } = {}): BrandHit[] {
  const toks = tokens(normText);
  const hits: BrandHit[] = [];
  for (const n of NAMES) {
    let best: BrandHit | null = null;
    for (let i = 0; i < toks.length; i++) {
      for (let w = Math.max(1, n.tokens - 1); w <= n.tokens + 1 && i + w <= toks.length; w++) {
        const cand = toks
          .slice(i, i + w)
          .map((x) => x.t)
          .join("");
        let d: number;
        if (cand === n.key || (o.translit && cand === skeleton(n.tkey))) d = 0;
        else if (n.short || [...cand].length < ABUSE.brands.shortLength) continue;
        else
          d = Math.min(levenshtein(cand, n.key, 2), o.translit ? levenshtein(cand, skeleton(n.tkey), 2) : 3);
        if (d > 2) continue;
        if (!best || d < best.distance) {
          best = {
            brand: n.brand,
            name: n.name,
            distance: d,
            short: n.short,
            ambiguous: n.ambiguous,
            start: (toks[i] as { start: number }).start,
            end: (toks[i + w - 1] as { end: number }).end,
          };
        }
      }
    }
    if (best) hits.push(best);
  }
  return hits;
}
