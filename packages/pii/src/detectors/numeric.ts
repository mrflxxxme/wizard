// Numeric identifiers: card, account_ru, snils, inn_person, inn_org, passport_ru (data-boundary.yaml#detectors.kinds).
import { innOrgValid, innPersonValid, isCardNumber, snilsValid } from "../checksums.js";
import type { Finding } from "../types.js";
import { contextBefore, finding, NON_PERSONAL_NUMBER_CTX } from "../util.js";

// A run of digit groups separated by one space/nbsp (or two) or a hyphen; not part of a word, decimal or longer number.
const RUN_RE = /(?<![\dA-Za-z_]|\d[.,])\d+(?:(?:[  ]{1,2}|-)\d+)*(?![\dA-Za-z_]|[.,]\d)/gu;
const GROUP_RE = /\d+/g;

const SNILS_CTX = /снилс|snils|страхов\p{L}* номер/iu;
const INN_CTX = /(?<!\p{L})(?:инн|inn)(?!\p{L})/iu;
const PASSPORT_CTX = /паспорт|серия|серии|выдан|passport|удостоверени\p{L}* личност/iu;

// "серия 45 06 № 123456", "паспорт 4506 № 123456", "серия 4506 номер 123456".
const SERIES_NUMBER_RE =
  /(?<!\d)(\d{2}[  ]?\d{2})[  ]*(?:№|N|No\.?|номер)[  ]*(\d{6})(?!\d)/gu;

interface Group {
  start: number;
  end: number;
  digits: string;
}

/** Passport series: 2-digit region (OKATO, not 00) + 2-digit year of the blank (1997+). */
function plausibleSeries(series: string): boolean {
  if (series.startsWith("00")) return false;
  const yy = Number(series.slice(2, 4));
  const current = new Date().getFullYear() % 100;
  return yy >= 97 || yy <= current + 1;
}

function evaluate(text: string, groups: Group[], i: number, j: number): Finding | null {
  const first = groups[i];
  const last = groups[j];
  if (!first || !last) return null;
  const start = first.start;
  const end = last.end;
  const lens: number[] = [];
  let num = "";
  for (let k = i; k <= j; k++) {
    const g = groups[k] as Group;
    lens.push(g.digits.length);
    num += g.digits;
  }
  const n = num.length;
  const single = lens.length === 1;
  const shape = lens.join(",");

  if (n === 20 && /^(?:40817|40820|423)/.test(num)) return finding("account_ru", start, end, "high");

  if (n >= 13 && n <= 19) {
    const grouped = single || lens.every((l, k) => (k === lens.length - 1 ? l >= 1 && l <= 4 : l === 4));
    if (grouped && isCardNumber(num)) return finding("card", start, end, "high");
  }

  if (n === 11) {
    const formatted = shape === "3,3,3,2";
    if ((formatted || (single && contextBefore(text, start, SNILS_CTX))) && snilsValid(num)) {
      return finding("snils", start, end, "high");
    }
  }

  if (n === 12 && single && innPersonValid(num)) {
    return finding("inn_person", start, end, contextBefore(text, start, INN_CTX) ? "high" : "medium");
  }

  if (n === 10) {
    const passportCtx = contextBefore(text, start, PASSPORT_CTX, 40);
    if (single) {
      if (innOrgValid(num)) return finding("inn_org", start, end, contextBefore(text, start, INN_CTX) ? "high" : "medium");
      if (passportCtx && !num.startsWith("00")) return finding("passport_ru", start, end, "high");
      return null;
    }
    if (shape === "2,2,6" || shape === "4,6") {
      if (passportCtx) return finding("passport_ru", start, end, "high");
      if (contextBefore(text, start, NON_PERSONAL_NUMBER_CTX, 25)) return null;
      if (plausibleSeries(num.slice(0, 4))) return finding("passport_ru", start, end, "medium");
    }
  }
  return null;
}

export function detectNumericIds(text: string): Finding[] {
  const out: Finding[] = [];
  for (const m of text.matchAll(RUN_RE)) {
    const base = m.index;
    const groups: Group[] = [];
    for (const g of m[0].matchAll(GROUP_RE)) {
      groups.push({ start: base + g.index, end: base + g.index + g[0].length, digits: g[0] });
    }
    // Greedy left-to-right: the longest valid window of consecutive groups wins.
    for (let i = 0; i < groups.length; ) {
      let hit: Finding | null = null;
      let hitEnd = i;
      for (let j = Math.min(groups.length - 1, i + 5); j >= i && !hit; j--) {
        hit = evaluate(text, groups, i, j);
        if (hit) hitEnd = j;
      }
      if (hit) {
        out.push(hit);
        i = hitEnd + 1;
      } else i++;
    }
  }
  for (const m of text.matchAll(SERIES_NUMBER_RE)) {
    const series = (m[1] ?? "").replace(/\D/g, "");
    if (series.startsWith("00")) continue;
    const ctx = contextBefore(text, m.index, PASSPORT_CTX, 40);
    if (!ctx && !plausibleSeries(series)) continue;
    out.push(finding("passport_ru", m.index, m.index + m[0].length, ctx ? "high" : "medium"));
  }
  return out;
}
