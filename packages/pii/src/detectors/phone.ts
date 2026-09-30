// phone_ru (data-boundary.yaml#detectors.kinds.phone_ru): +7/8 followed by 10 digits, or 10 digits starting with 9 in context.
// phone_intl (#detectors.kinds.phone_intl): "+<country ≠ 7>" and 8–15 digits; without "+" only in phone context.
import type { Finding } from "../types.js";
import { contextAround, contextBefore, finding, NON_PERSONAL_NUMBER_CTX, onlyDigits } from "../util.js";

const SEP = "[ \\u00a0\\-()]";
// Prefix, then exactly 10 digits, each preceded by up to 3 separator characters; not inside a longer number.
const PHONE_RE = new RegExp(`(?<![\\d\\p{L}+])(\\+[ \\u00a0]?7|8|7)((?:${SEP}{0,3}\\d){10})(?!\\d)`, "gu");
// 10 digits starting with 9 (mobile code without a country prefix): only with phone context.
const BARE_MOBILE_RE = /(?<![\d\p{L}+])(?:\(9\d\d\)|9\d\d)[ \xa0-]?\d{3}[ \xa0-]?\d{2}[ \xa0-]?\d{2}(?!\d)/gu;

// "+" and 8–15 digits in total (country code 1–3 digits), separators as for phone_ru.
const INTL_PLUS_RE = new RegExp(`(?<![\\d\\p{L}+])\\+[ \\xa0]?[1-689]\\d?\\d?(?:${SEP}{0,3}\\d){5,13}(?!\\d)`, "gu");
// Without "+": CIS country codes only, and only in phone context.
const INTL_BARE_RE = new RegExp(
  `(?<![\\d\\p{L}+])(?:375|380|998|996|992|993|994|995|374|373|371|372|370)(?:${SEP}{0,3}\\d){8,9}(?!\\d)`,
  "gu",
);

export const PHONE_CTX = /(?<!\p{L})(?:тел|моб|сот|whatsapp|ватсап|вотсап|вацап|viber|вайбер|telegram|телеграм|звон|позвон|phone|tel|mobile|номер)\p{L}*/iu;
const MONEY_AFTER = /^[ \xa0]*(?:руб|р\.|₽|тыс|млн|млрд|\$|€|usd|rub|eur)/iu;

/** Normalizes a Russian phone number to E.164 (+7XXXXXXXXXX), or null. */
export function normalizePhoneRu(s: string): string | null {
  const d = onlyDigits(s);
  if (d.length === 10 && d.startsWith("9")) return `+7${d}`;
  if (d.length === 11 && (d.startsWith("7") || d.startsWith("8"))) return `+7${d.slice(1)}`;
  return null;
}

export function detectPhones(text: string): Finding[] {
  const out: Finding[] = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const prefix = (m[1] ?? "").replace(/\s/g, "");
    const rest = m[2] ?? "";
    const digits = onlyDigits(rest);
    const first = digits[0] ?? "";
    const start = m.index;
    const end = start + m[0].length;
    // A phone has at most one pair of parentheses around the area code.
    if ((rest.match(/\(/g)?.length ?? 0) > 1 || (rest.match(/\)/g)?.length ?? 0) > 1) continue;
    if (MONEY_AFTER.test(text.slice(end, end + 8))) continue;
    const ctx = contextAround(text, start, end, PHONE_CTX);
    if (prefix === "+7") {
      if (first < "3") continue;
      out.push(finding("phone_ru", start, end, "high"));
      continue;
    }
    if (!ctx && contextBefore(text, start, NON_PERSONAL_NUMBER_CTX, 25)) continue;
    if (prefix === "8") {
      if (!"3489".includes(first)) continue;
      const styled = /[()-]/.test(rest) || /^\s?\d{3}\s\d{3}\s\d{2}\s\d{2}$/.test(rest);
      out.push(finding("phone_ru", start, end, ctx || styled ? "high" : "medium"));
    } else {
      // Bare "7": only 79XXXXXXXXX or 7(9XX)…, otherwise too close to prices and counters.
      if (first !== "9" || !/^\(?9/.test(rest)) continue;
      out.push(finding("phone_ru", start, end, ctx ? "high" : "medium"));
    }
  }
  for (const m of text.matchAll(INTL_PLUS_RE)) {
    const digits = onlyDigits(m[0]);
    const end = m.index + m[0].length;
    if (digits.length < 8 || digits.length > 15 || MONEY_AFTER.test(text.slice(end, end + 8))) continue;
    if ((m[0].match(/\(/g)?.length ?? 0) > 1) continue;
    out.push(finding("phone_intl", m.index, end, "high"));
  }
  for (const m of text.matchAll(INTL_BARE_RE)) {
    const end = m.index + m[0].length;
    if (!contextAround(text, m.index, end, PHONE_CTX)) continue;
    out.push(finding("phone_intl", m.index, end, "medium"));
  }
  for (const m of text.matchAll(BARE_MOBILE_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (!contextAround(text, start, end, PHONE_CTX)) continue;
    out.push(finding("phone_ru", start, end, "medium"));
  }
  return out;
}
