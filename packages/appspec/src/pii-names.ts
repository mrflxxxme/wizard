// Personal-data-like field names (specs/security/abuse.yaml#patterns.pii_field_names, #normalize, #word_boundary) — the
// one criterion of G2-PII-02 (@wizard/gates) and of the pii marking of module extra fields (@wizard/modules, B2-46).
import { PII_NAMES_DATA } from "./pii-names.data.js";
import { USERS_ENTITY } from "./reserved.js";
import type { Entity, Field } from "./schema.js";

type PiiCategory = NonNullable<Field["pii"]>;
type PiiKind = NonNullable<Field["piiKind"]>;

const WORD = "[\\p{L}\\p{N}_]";
const NOT_WORD = "[^\\p{L}\\p{N}_]";
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

/**
 * Pattern of abuse.yaml → RegExp: `\b` is a Unicode word boundary, `\w`/`\W` are Unicode-aware, and every
 * alternative starts at a word start (patterns without `\b` are stems: abuse.yaml#patterns.word_boundary).
 */
export function unicodeRx(pattern: string, flags = "gu"): RegExp {
  const body = pattern.replace(/\\b/g, BOUNDARY).replace(/\\W/g, NOT_WORD).replace(/\\w/g, WORD);
  return new RegExp(`(?<!${WORD})(?:${body})`, flags.includes("u") ? flags : `${flags}u`);
}

const PAIRS = PII_NAMES_DATA.homoglyphs as [string, string][];
const CYR_TO_LAT = new Map(PAIRS.map(([c, l]) => [c, l]));
const LAT_TO_CYR = new Map(PAIRS.map(([c, l]) => [l, c]));
const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;

function fixMixedToken(t: string): string {
  const hasLat = /[a-z]/.test(t);
  const hasCyr = /[а-я]/.test(t);
  if (!hasLat || !hasCyr) return t;
  let lat = 0;
  let cyr = 0;
  for (const ch of t) {
    if (/[a-z]/.test(ch) && !LAT_TO_CYR.has(ch)) lat++;
    else if (/[а-я]/.test(ch) && !CYR_TO_LAT.has(ch)) cyr++;
  }
  const map = lat > cyr ? CYR_TO_LAT : LAT_TO_CYR;
  return [...t].map((ch) => map.get(ch) ?? ch).join("");
}

/** Lower case, ё→е, no invisible characters, mixed-script words folded to one script, single spaces. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(INVISIBLE, "")
    .replace(/\p{L}+/gu, fixMixedToken)
    .replace(/\s+/g, " ")
    .trim();
}

/** Identifier → words: holderPhone / holder_phone → "holder phone". */
export function splitIdent(name: string): string {
  return name
    .replace(/([a-zа-яё0-9])([A-ZА-ЯЁ])/gu, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim();
}

/** First match of `re` in normalized text (re must be global): index and matched text. */
export function firstMatch(re: RegExp, text: string): { index: number; text: string } | null {
  re.lastIndex = 0;
  const m = re.exec(text);
  return m ? { index: m.index, text: m[0] } : null;
}

/** abuse.yaml#patterns.pii_field_names: strong (any entity), weak (subject entities) and weak exceptions. */
export const PII_NAME_PATTERNS: Readonly<{ strong: string; weak: string; weakExceptions: string }> = {
  strong: PII_NAMES_DATA.strong,
  weak: PII_NAMES_DATA.weak,
  weakExceptions: PII_NAMES_DATA.weakExceptions,
};

const RE = {
  strong: unicodeRx(PII_NAME_PATTERNS.strong, "giu"),
  weak: unicodeRx(PII_NAME_PATTERNS.weak, "giu"),
  weakExc: unicodeRx(PII_NAME_PATTERNS.weakExceptions, "giu"),
};

/** PII category of a field: its `pii`, else basic for files (ops.yaml), else none. */
export function fieldPiiCategory(f: Pick<Field, "pii" | "type">): PiiCategory {
  if (f.pii) return f.pii;
  return f.type === "file" ? "basic" : "none";
}

const names = (f: Pick<Field, "name" | "label">) => [
  normalizeText(f.label),
  normalizeText(splitIdent(f.name)),
];

/** abuse.yaml#subject_entities: a pii≠none field, a ref to users, or a strong ПДн field name. */
export function isPiiSubject(e: Pick<Entity, "fields">): boolean {
  return e.fields.some(
    (f) =>
      fieldPiiCategory(f) !== "none" ||
      (f.type === "ref" && f.ref?.entity === USERS_ENTITY) ||
      names(f).some((n) => firstMatch(RE.strong, n)),
  );
}

/** Why a field looks like personal data (G2-PII-02), regardless of its own `pii`; null when it does not. */
export interface PiiNameReason {
  /** `тип email|phone`, `pii_field_names.strong` or `pii_field_names.weak`. */
  why: string;
  /** Matched word of the name or label (absent for the email/phone types). */
  match?: string;
}

/** G2-PII-02 criterion: email/phone type, a strong name, or (in a subject entity) a weak name not in the exceptions. */
export function piiNameReason(
  f: Pick<Field, "name" | "label" | "type">,
  subject: boolean,
): PiiNameReason | null {
  if (f.type === "email" || f.type === "phone") return { why: `тип ${f.type}` };
  const n = names(f);
  for (const x of n) {
    const m = firstMatch(RE.strong, x);
    if (m) return { why: "pii_field_names.strong", match: m.text };
  }
  if (subject)
    for (const x of n) {
      const m = firstMatch(RE.weak, x);
      if (m && !firstMatch(RE.weakExc, x)) return { why: "pii_field_names.weak", match: m.text };
    }
  return null;
}

const KIND_BY_WORD: [RegExp, PiiKind | null][] = [
  [/^(фио|фамили|отчеств|имя)/, "fio"],
  [/^(телефон|моб)/, "phone"],
  [/^(e-?mail|почта)/, "email"],
  [/^(дата|день) рождения/, "birthdate"],
  [/^адрес/, "address"],
  [/^(telegram|телеграм|whatsapp|контакт)/, "other"],
  // Government ids: the kind is left to G1 (name classifier) and G2-AF-03 (names), which stop them anyway.
  [/^(паспорт|снилс|инн)/, null],
];

/** piiKind of a field marked by piiNameReason: by type (email/phone), else by the matched word; undefined if unsure. */
export function piiKindFor(f: Pick<Field, "type">, reason: PiiNameReason): PiiKind | undefined {
  if (f.type === "email" || f.type === "phone") return f.type;
  const word = reason.match ?? "";
  for (const [re, kind] of KIND_BY_WORD) if (re.test(word)) return kind ?? undefined;
  return undefined;
}
