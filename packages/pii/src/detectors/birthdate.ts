// birthdate (data-boundary.yaml#detectors.kinds.birthdate): a valid date with birth context within 30 characters.
import type { Finding } from "../types.js";
import { contextAround, finding } from "../util.js";

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

const NUMERIC_RE = /(?<![\d.\/-])(\d{1,2})([.\/-])(\d{1,2})\2(\d{4}|\d{2})(?![\d]|[.\/-]\d)(?:[ \xa0]?(?:г\.|года))?/gu;
const ISO_RE = /(?<![\d.\/-])(\d{4})-(\d{2})-(\d{2})(?![\d])/gu;
const WORDS_RE = new RegExp(
  `(?<![\\d\\p{L}])(\\d{1,2})[ \\xa0]+(${MONTHS.join("|")})[ \\xa0]+(\\d{4})(?:[ \\xa0]*(?:г\\.|года|г(?!\\p{L})))?`,
  "giu",
);

export const BIRTH_CTX =
  /родил|рожден|рождён|(?<!\p{L})(?:д\.?\s?р\.?|г\.\s?р\.?|др|д\/р|dob)(?!\p{L})|birth|день рожд|дата рожд/iu;

function valid(d: number, m: number, y: number): boolean {
  if (y < 1900 || y > new Date().getFullYear()) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function fullYear(y: string): number {
  if (y.length === 4) return Number(y);
  const n = Number(y);
  return n + (n <= new Date().getFullYear() % 100 ? 2000 : 1900);
}

export function detectBirthdates(text: string): Finding[] {
  const out: Finding[] = [];
  const push = (start: number, end: number) => {
    if (contextAround(text, start, end, BIRTH_CTX)) out.push(finding("birthdate", start, end, "high"));
  };
  for (const m of text.matchAll(NUMERIC_RE)) {
    if (valid(Number(m[1]), Number(m[3]), fullYear(m[4] ?? ""))) push(m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(ISO_RE)) {
    if (valid(Number(m[3]), Number(m[2]), Number(m[1]))) push(m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(WORDS_RE)) {
    const month = MONTHS.indexOf((m[2] ?? "").toLowerCase()) + 1;
    if (valid(Number(m[1]), month, Number(m[3]))) push(m.index, m.index + m[0].length);
  }
  return out;
}
