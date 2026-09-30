// Kinds, categories and scrub placeholders: specs/security/data-boundary.yaml#detectors, #scrub.

export const KINDS = [
  "phone_ru",
  "email",
  "card",
  "passport_ru",
  "snils",
  "inn_person",
  "inn_org",
  "account_ru",
  "birthdate",
  "address",
  "person_name",
  "special_context",
  "biometric_context",
] as const;
export type Kind = (typeof KINDS)[number];

/** appspec.schema.json#/$defs/pii */
export type Category = "none" | "basic" | "special" | "biometric";
/** appspec.schema.json#/$defs/piiKind */
export type PiiKind =
  | "fio"
  | "phone"
  | "email"
  | "address"
  | "birthdate"
  | "passport"
  | "snils"
  | "inn"
  | "card"
  | "free_text"
  | "other";
export type Confidence = "high" | "medium";

export interface Finding {
  kind: Kind;
  category: Category;
  /** The matching AppSpec piiKind (for G2 rules and llm_calls counters). */
  piiKind: PiiKind;
  /** UTF-16 offsets, end exclusive. */
  start: number;
  end: number;
  confidence: Confidence;
}

export interface KindInfo {
  category: Category;
  piiKind: PiiKind;
  /** Strong identifiers force T0 (data-boundary.yaml#routing.constraints). */
  strong: boolean;
  /** Placeholder stem for scrub; null — the kind is not replaced. */
  placeholder: string | null;
}

export const KIND_INFO: Readonly<Record<Kind, KindInfo>> = {
  phone_ru: { category: "basic", piiKind: "phone", strong: false, placeholder: "ТЕЛЕФОН" },
  email: { category: "basic", piiKind: "email", strong: false, placeholder: "EMAIL" },
  card: { category: "basic", piiKind: "card", strong: true, placeholder: "КАРТА" },
  passport_ru: { category: "basic", piiKind: "passport", strong: true, placeholder: "ПАСПОРТ" },
  snils: { category: "basic", piiKind: "snils", strong: true, placeholder: "СНИЛС" },
  inn_person: { category: "basic", piiKind: "inn", strong: true, placeholder: "ИНН" },
  inn_org: { category: "none", piiKind: "inn", strong: false, placeholder: null },
  account_ru: { category: "basic", piiKind: "other", strong: true, placeholder: "СЧЁТ" },
  birthdate: { category: "basic", piiKind: "birthdate", strong: false, placeholder: "ДАТА_РОЖДЕНИЯ" },
  address: { category: "basic", piiKind: "address", strong: false, placeholder: "АДРЕС" },
  person_name: { category: "basic", piiKind: "fio", strong: false, placeholder: "ФИО" },
  special_context: { category: "special", piiKind: "other", strong: false, placeholder: null },
  biometric_context: { category: "biometric", piiKind: "other", strong: false, placeholder: null },
};

export const STRONG_KINDS: readonly Kind[] = KINDS.filter((k) => KIND_INFO[k].strong);

const CATEGORY_RANK: Record<Category, number> = { none: 0, basic: 1, special: 2, biometric: 3 };

export function maxCategory(a: Category, b: Category): Category {
  return CATEGORY_RANK[a] >= CATEGORY_RANK[b] ? a : b;
}

export function toPiiKind(kind: Kind): PiiKind {
  return KIND_INFO[kind].piiKind;
}

/** Any scrub placeholder, e.g. `[ФИО_1]`, `[EMAIL_2]` (data-boundary.yaml#scrub.semantics). */
export const PLACEHOLDER_RE = /\[(?:[А-ЯЁ_]+|EMAIL)_\d+\]/gu;

export function isPlaceholder(s: string): boolean {
  return /^\[(?:[А-ЯЁ_]+|EMAIL)_\d+\]$/u.test(s);
}
