// S1_dlp and pii_notice (orchestrator.yaml#pii_notice): categories as words, never the values.
import { detect, type PiiKind } from "@wizard/pii";

const WORDS: Record<PiiKind, string> = {
  fio: "ФИО",
  phone: "телефон",
  email: "email",
  address: "адрес",
  birthdate: "дата рождения",
  passport: "паспорт",
  snils: "СНИЛС",
  inn: "ИНН",
  card: "номер карты",
  free_text: "другие данные",
  other: "другие данные",
};

/** piiKind categories of personal data found in text (inn_org and other category=none findings are ignored). */
export function piiCategories(text: string): PiiKind[] {
  const out: PiiKind[] = [];
  for (const f of detect(text)) {
    if (f.category === "none" || out.includes(f.piiKind)) continue;
    out.push(f.piiKind);
  }
  return out;
}

export function piiNoticeText(categories: readonly PiiKind[]): string {
  const words = [...new Set(categories.map((c) => WORDS[c]))].join(", ");
  return (
    `В описании есть персональные данные (${words}). Для сборки они не нужны: мы обработаем ваш текст ` +
    "в российском контуре, а во внешние модели передадим его без этих данных. Реальные данные клиентов лучше " +
    "вносить уже в готовую систему."
  );
}

/** Paths of strings in a JSON value where the detector finds personal data (DLP over Analysis/card). */
export function piiPaths(value: unknown, path = ""): string[] {
  if (typeof value === "string") return piiCategories(value).length > 0 ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => piiPaths(v, path ? `${path}.${i}` : String(i)));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => piiPaths(v, path ? `${path}.${k}` : k));
  }
  return [];
}
