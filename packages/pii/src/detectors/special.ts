// special_context / biometric_context (data-boundary.yaml#detectors.kinds): special-category stems near a data subject.
// detectSpecialTerms: subject-free keyword scan for field names/labels/enums (abuse.yaml#patterns.special_categories, G2-PII-03).
import type { Finding, Kind } from "../types.js";
import { finding } from "../util.js";

const SPECIAL_STEMS =
  "диагноз|болезн|заболеван|инвалид|беремен|вич(?![\\p{L}])|онколог|психиатр|наркол|вероисповед|религи|партийн|национальност|судим|сексуальн|аллерги|интимн";
const SPECIAL_RE = new RegExp(`(?<![\\p{L}])(?:${SPECIAL_STEMS})\\p{L}*`, "giu");
const BIOMETRIC_RE =
  /(?<![\p{L}])(?:биометр\p{L}*|отпечат(?:ок|ки|ков|ка|кам|ками|ках)(?:[ \xa0]+пальц\p{L}*)?|распознаван\p{L}*[ \xa0]+лиц\p{L}*|образ(?:ец|цы|цов|ца)[ \xa0]+голоса|скан\p{L}*[ \xa0]+лиц\p{L}*|фото[ \xa0]+лица(?:[ \xa0]+для[ \xa0]+прохода)?)/giu;

/** Kinds that identify a data subject for the special/biometric context rule. */
const SUBJECT_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  "person_name",
  "person_name_latin",
  "phone_ru",
  "phone_intl",
  "email",
  "social_handle",
  "passport_ru",
]);
const WINDOW = 100;

export function detectSpecialContext(text: string, base: readonly Finding[]): Finding[] {
  // `base` is sorted by start and non-overlapping, so subjects are sorted by both start and end.
  const subjects = base.filter((f) => SUBJECT_KINDS.has(f.kind));
  if (subjects.length === 0) return [];
  const near = (s: number, e: number): boolean => {
    // First subject whose end is ≥ s − WINDOW; it or the next one decides.
    let lo = 0;
    let hi = subjects.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((subjects[mid] as Finding).end < s - WINDOW) lo = mid + 1;
      else hi = mid;
    }
    const f = subjects[lo];
    return f !== undefined && f.start - e <= WINDOW;
  };
  const out: Finding[] = [];
  for (const m of text.matchAll(SPECIAL_RE)) {
    const e = m.index + m[0].length;
    if (near(m.index, e)) out.push(finding("special_context", m.index, e, "medium"));
  }
  for (const m of text.matchAll(BIOMETRIC_RE)) {
    const e = m.index + m[0].length;
    if (near(m.index, e)) out.push(finding("biometric_context", m.index, e, "medium"));
  }
  return out;
}

// abuse.yaml#patterns.special_categories (+ English identifiers for field names).
const TERM_SPECIAL_RE =
  /(?<![\p{L}])(?:здоровь|диагноз|болезн|заболеван|инвалид|беремен|аллерги|медицин|анализы?[ \xa0]+крови|вероисповед|религи|политич|партийн|национальност|рас(?:а|ы|е|у|ой|ов\p{L}*)(?!\p{L})|судим|интимн|сексуальн|health|diagnos|disease|disabilit|pregnan|allerg|medical|religio|politic(?!y)|ethnic|nationality|criminal|convict|sexual)/iu;
const TERM_BIOMETRIC_RE =
  /(?<![\p{L}])(?:биометр|отпечат|распознаван\p{L}*[ \xa0]+лиц|образ\p{L}*[ \xa0]+голос|скан\p{L}*[ \xa0]+лиц|фото[ \xa0]+лица|biometr|fingerprint|face[ \xa0_-]?id|face[ \xa0_-]?scan|voice[ \xa0_-]?print)/iu;

/** Special category signalled by a field name/label/enum text alone, without a data subject (G2-PII-03). */
export function detectSpecialTerms(text: string): "special" | "biometric" | null {
  if (TERM_BIOMETRIC_RE.test(text)) return "biometric";
  if (TERM_SPECIAL_RE.test(text)) return "special";
  return null;
}
