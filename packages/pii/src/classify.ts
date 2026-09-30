// classifyFieldName(): G2-PII-02/03 heuristics over a field's name and label (abuse.yaml#patterns.pii_field_names,
// #patterns.special_categories).
import { detectSpecialTerms } from "./detectors/special.js";
import type { PiiKind } from "./types.js";

export interface FieldClassification {
  pii: "basic" | "special" | "biometric";
  piiKind: PiiKind;
}

/** "birthDate", "phone_number", "e-mail" → "birth date", "phone number", "e-mail". */
function normalizeIdent(name: string): string {
  return name
    .replace(/([a-zа-яё0-9])([A-ZА-ЯЁ])/gu, "$1 $2")
    .replace(/[_.]+/g, " ")
    .toLowerCase()
    .replace(/ё/g, "е");
}

const B = "(?<![\\p{L}])";
const E = "(?![\\p{L}])";
const re = (s: string) => new RegExp(s, "iu");

// Order matters: the first matching rule wins (email before address: «адрес электронной почты»).
const RULES: Array<[PiiKind, RegExp, RegExp?]> = [
  [
    "email",
    re(`${B}(?:e-?mail|email|эл\\.? ?почт|электронн\\p{L}* почт|почт[аыеуой]{0,2}${E}|мейл|имейл|емейл)`),
    re(`почт\\p{L}* росси|почтов\\p{L}* (?:индекс|отделени)`),
  ],
  ["birthdate", re(`(?:дат\\p{L}* рожд|день рожд|${B}д\\.? ?р\\.${E}|birth|${B}dob${E}|data rozhd|${B}bday${E})`)],
  [
    "fio",
    re(
      `(?:${B}(?:фио|ф\\.и\\.о|фамили|отчеств|имя|имени)|full ?name|first ?name|last ?name|middle ?name|given ?name|family ?name|surname|patronymic|${B}fio${E}|familiya|otchestvo|${B}imya${E})`,
    ),
    re(
      `(?:имя|имени) (?:файл|проект|компани|организаци|товар|продукт|событи|мероприяти|команд|групп|домен|хост|сайт|раздел|категори|пол[яе]|переменн|таблиц|бренд|магазин|канал|бот|шаблон|тариф)`,
    ),
  ],
  [
    "phone",
    re(
      `(?:телефон|${B}тел\\.?${E}|${B}моб|${B}phone|${B}mobile|${B}tel${E}|${B}msisdn|whats ?app|вотсап|ватсап|вацап|${B}telefon)`,
    ),
  ],
  [
    "address",
    re(`(?:адрес|${B}address|${B}addr${E}|${B}street|${B}улиц|${B}adres|место жительства|прописк|регистраци\\p{L}* по месту)`),
    re(`(?:${B}ip|url|${B}web|сайт|ссылк|${B}mac|${B}ссылк)[ -]?(?:адрес|address)|адрес\\p{L}* (?:сайт|страниц|ссылк)|${B}url${E}`),
  ],
  ["passport", re(`(?:паспорт|${B}passport|${B}pasport)`)],
  ["snils", re(`(?:снилс|${B}snils)`)],
  [
    "inn",
    re(`(?:${B}инн${E}|${B}inn${E})`),
    re(`(?:организаци|юр\\p{L}*\\.? ?лиц|компани|${B}ооо${E}|поставщик|контрагент|${B}company|${B}org${E}|банк)`),
  ],
  ["card", re(`(?:номер\\p{L}* карт|банковск\\p{L}* карт|card ?number|${B}cc ?(?:number|num)|${B}pan${E})`)],
  ["other", re(`(?:telegram|телеграм|${B}tg${E}|контакт|${B}contact|вконтакте|${B}vk${E}|соцсет|social)`)],
];

/**
 * G2-PII-02: does a field look like personal data by its name/label (or declared type)?
 * Returns null when nothing matches. Special categories and biometrics win over basic (G2-PII-03).
 */
export function classifyFieldName(name: string, label?: string | null, type?: string | null): FieldClassification | null {
  const text = `${normalizeIdent(name ?? "")} ${(label ?? "").toLowerCase().replace(/ё/g, "е")}`;
  const special = detectSpecialTerms(text);
  if (special) return { pii: special, piiKind: "other" };
  if (type === "email") return { pii: "basic", piiKind: "email" };
  if (type === "phone") return { pii: "basic", piiKind: "phone" };
  for (const [piiKind, match, exclude] of RULES) {
    if (match.test(text) && !(exclude?.test(text) ?? false)) return { pii: "basic", piiKind };
  }
  return null;
}
