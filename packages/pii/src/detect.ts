// detect(): runs all detectors and resolves overlaps (data-boundary.yaml#detectors.interface).
import { detectAddresses } from "./detectors/address.js";
import { detectBirthdates } from "./detectors/birthdate.js";
import { detectEmails } from "./detectors/email.js";
import { detectCarPlates, detectHandles, type HandleOptions } from "./detectors/handles.js";
import { detectNames } from "./detectors/names.js";
import { detectNumericIds } from "./detectors/numeric.js";
import { detectPhones } from "./detectors/phone.js";
import { detectSpecialContext } from "./detectors/special.js";
import type { Finding, Kind } from "./types.js";

export interface DetectOptions extends HandleOptions {
  /** Also return findings of category "none" (inn_org). Default false: detect() returns personal data only. */
  includeNonPii?: boolean;
}

// Lower number wins an overlap; within one priority the longer span wins.
const PRIORITY: Record<Kind, number> = {
  email: 0,
  social_handle: 1,
  card: 1,
  account_ru: 1,
  ogrnip: 2,
  snils: 2,
  inn_person: 3,
  passport_ru: 4,
  phone_ru: 5,
  phone_intl: 6,
  inn_org: 7,
  birthdate: 7,
  car_plate_ru: 8,
  address: 8,
  person_name: 9,
  person_name_latin: 9,
  special_context: 10,
  biometric_context: 10,
};

function resolve(candidates: Finding[]): Finding[] {
  const sorted = [...candidates].sort(
    (a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  // Accepted spans are kept sorted by start and never overlap, so only the neighbours need checking.
  const taken: Finding[] = [];
  for (const f of sorted) {
    let lo = 0;
    let hi = taken.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((taken[mid] as Finding).start < f.start) lo = mid + 1;
      else hi = mid;
    }
    const prev = taken[lo - 1];
    const next = taken[lo];
    if ((prev && prev.end > f.start) || (next && next.start < f.end)) continue;
    taken.splice(lo, 0, f);
  }
  return taken;
}

export function detect(text: string, options: DetectOptions = {}): Finding[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const base = resolve([
    ...detectEmails(text),
    ...detectHandles(text, options),
    ...detectCarPlates(text),
    ...detectNumericIds(text),
    ...detectPhones(text),
    ...detectBirthdates(text),
    ...detectAddresses(text),
    ...detectNames(text),
  ]);
  const special = detectSpecialContext(text, base);
  const all = special.length ? [...base, ...special].sort((a, b) => a.start - b.start) : base;
  return options.includeNonPii ? all : all.filter((f) => f.category !== "none");
}
