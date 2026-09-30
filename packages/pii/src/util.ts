// Shared helpers for detectors.
import type { Confidence, Finding, Kind } from "./types.js";
import { KIND_INFO } from "./types.js";

export function finding(kind: Kind, start: number, end: number, confidence: Confidence): Finding {
  const info = KIND_INFO[kind];
  return { kind, category: info.category, piiKind: info.piiKind, start, end, confidence };
}

/** Does `re` match within `width` characters before `start`? */
export function contextBefore(text: string, start: number, re: RegExp, width = 30): boolean {
  return re.test(text.slice(Math.max(0, start - width), start));
}

/** Does `re` match within `width` characters before `start` or after `end`? */
export function contextAround(text: string, start: number, end: number, re: RegExp, width = 30): boolean {
  return re.test(text.slice(Math.max(0, start - width), start)) || re.test(text.slice(end, end + width));
}

export function onlyDigits(s: string): string {
  return s.replace(/\D+/g, "");
}

/** Lowercase + ё→е, used for dictionary lookups and normalization keys. */
export function fold(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е");
}

/** Context that marks a number as a non-personal identifier (order, invoice, tracking…). */
export const NON_PERSONAL_NUMBER_CTX =
  /(?:№|#|(?<!\p{L})(?:заказ|order|артикул|арт\.|sku|счёт|счет|сч\.|трек|накладн|договор|id|огрн|кпп|бик|окпо|оквэд|р\/с|к\/с|инвойс|invoice|номер отправления|отправлени|партия|лот)\p{L}*)/iu;
