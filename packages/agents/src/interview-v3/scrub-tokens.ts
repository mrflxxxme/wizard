// Scrub placeholders in the system brief (V3-18, checkpoint 2026-10-09: «…ссылку на [КОНТАКТ_1] для иностранцев» in a
// stored brief and from there in the site texts). The T1 interview sees the owner's words scrubbed (@wizard/pii:
// `[ВИД_n]` one-way placeholders, data-boundary.yaml#scrub) and may copy a placeholder into the brief; the code's own
// scrub of a brief patch makes one of any personal data the model wrote (merge.ts). The build and the site read the
// brief, so it holds plain words: the brief update tool refuses placeholders (the model rephrases), and what is left is
// replaced here by the neutral word of its kind before the brief is saved or built.

/** Kinds of placeholders a model writes without a number (`[КОНТАКТ]`): the stems of @wizard/pii and their kin. */
const STEMS =
  "ТЕЛЕФОН|EMAIL|E-MAIL|КОНТАКТ|ФИО|ИМЯ|ФАМИЛИЯ|АДРЕС|ДАТА_РОЖДЕНИЯ|КАРТА|ПАСПОРТ|СНИЛС|ИНН|ОГРНИП|ГОСНОМЕР|СЧ[ЁЕ]Т|PHONE|NAME";

/**
 * A scrub placeholder as the model writes it: `[КОНТАКТ_1]`, `[ТЕЛЕФОН_2]`, `[EMAIL_1]` (@wizard/pii PLACEHOLDER_RE),
 * and the variants a model makes of them — `[ИМЯ_1]`, `[ТЕЛЕФОН 1]`, `[КОНТАКТ]`: any upper-case Cyrillic word with a
 * number in brackets, a known kind without one.
 */
export const SCRUB_TOKEN_RE = new RegExp(
  `\\[\\s*(?:(?:[А-ЯЁ][А-ЯЁ_]*|EMAIL|E-MAIL|PHONE|NAME)[_\\s-]?\\d+|(?:${STEMS}))\\s*\\]`,
  "gu",
);

/**
 * Kinds of placeholders (stems of @wizard/pii KIND_INFO and what models make of them): the stem, the neutral word, and
 * the words that already name it — «по телефону [ТЕЛЕФОН_1]» keeps «по телефону» alone.
 */
const KINDS: readonly { stem: RegExp; word: string; said: RegExp }[] = [
  { stem: /^(?:ТЕЛЕФОН|PHONE|НОМЕР)/u, word: "телефон", said: /^(?:телефон|номер|тел\.?$)/u },
  { stem: /^(?:EMAIL|E-MAIL|ПОЧТА|ЭЛ)/u, word: "e-mail", said: /^(?:почт|e-?mail|имейл|email)/u },
  {
    stem: /^(?:КОНТАКТ|ССЫЛКА|АККАУНТ|НИК)/u,
    word: "контакт",
    said: /^(?:контакт|аккаунт|профил|телеграм|whatsapp|vk|вк$|инстаграм|мессенджер)/u,
  },
  { stem: /^(?:ФИО|ИМЯ|NAME|ФАМИЛИЯ|КЛИЕНТ|ВЛАДЕЛЕЦ)/u, word: "имя", said: /^(?:имя|имени|фио|фамили)/u },
  { stem: /^АДРЕС/u, word: "адрес", said: /^адрес/u },
  { stem: /^ДАТА_РОЖДЕНИЯ/u, word: "дата рождения", said: /^рождени/u },
  { stem: /^КАРТА/u, word: "карта", said: /^карт/u },
  { stem: /^ПАСПОРТ/u, word: "паспорт", said: /^паспорт/u },
  { stem: /^СНИЛС/u, word: "СНИЛС", said: /^снилс/u },
  { stem: /^ИНН/u, word: "ИНН", said: /^инн/u },
  { stem: /^ОГРНИП/u, word: "ОГРНИП", said: /^огрнип/u },
  { stem: /^ГОСНОМЕР/u, word: "госномер", said: /^(?:госномер|номер)/u },
  { stem: /^СЧ[ЁЕ]Т/u, word: "счёт", said: /^сч[её]т/u },
];

const has = (s: string): boolean => new RegExp(SCRUB_TOKEN_RE.source, "u").test(s);

/** The neutral word of one placeholder after `before` (the text up to it): empty when the word before names it. */
function wordOf(token: string, before: string): string {
  const stem = token.replace(/^\[\s*|\s*\]$/g, "").replace(/[_\s-]?\d+$/, "");
  const kind = KINDS.find((k) => k.stem.test(stem));
  if (!kind) return "данные";
  const prev = /([\p{L}\d.-]+)[\s:—-]*$/u.exec(before)?.[1]?.toLowerCase() ?? "";
  return prev && kind.said.test(prev) ? "" : kind.word;
}

/** A text with every placeholder replaced by the neutral word of its kind (spaces tidied). */
export function stripScrubTokensText(text: string): string {
  if (!has(text)) return text;
  return text
    .replace(SCRUB_TOKEN_RE, (t, at: number, all: string) => wordOf(t, all.slice(0, at)))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/:\s*([,.;]|$)/g, "$1")
    .trim();
}

/** Every string of a JSON value with its placeholders replaced (stripScrubTokensText); the value is not changed. */
export function stripScrubTokens<T>(value: T): T {
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") return stripScrubTokensText(v);
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, visit(x)]));
    return v;
  };
  return visit(value) as T;
}

/** A place of a JSON value whose string holds a placeholder: the JSON path and the placeholder. */
export interface ScrubTokenPlace {
  path: string;
  token: string;
}

/** Placeholders of every string of a JSON value, with their paths (at most `max`). */
export function scrubTokenPlaces(value: unknown, max = 10): ScrubTokenPlace[] {
  const out: ScrubTokenPlace[] = [];
  const visit = (v: unknown, path: string): void => {
    if (out.length >= max) return;
    if (typeof v === "string") {
      const m = v.match(SCRUB_TOKEN_RE);
      if (m?.[0]) out.push({ path, token: m[0] });
    } else if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) visit(x, `${path}/${i}`);
    } else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, `${path}/${k}`);
  };
  visit(value, "");
  return out;
}
