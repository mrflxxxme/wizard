// «На пилоте бесплатно» and what is left of the pilot limit in words (D70, M2-56 mvp_scope); no credits in the cabinet.

const plural = (n: number, one: string, few: string, many: string): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

export const pricing = {
  free: "На пилоте бесплатно",
  /** «ещё 2 сборки», «сборки закончились». */
  buildsLeft: (n: number) =>
    n > 0 ? `ещё ${n} ${plural(n, "сборка", "сборки", "сборок")}` : "сборки закончились",
  editsLeft: (n: number) =>
    n > 0 ? `ещё ${n} ${plural(n, "правка", "правки", "правок")}` : "правки закончились",
  /** Pill of S1: «На пилоте бесплатно · ещё 2 сборки · ещё 15 правок». */
  pill: (builds: number, edits: number) =>
    `На пилоте бесплатно · ${pricing.buildsLeft(builds)} · ${pricing.editsLeft(edits)}`,
  pillTitle: "Сколько сборок и правок осталось на пилоте",
  window: (builds: number, edits: number) =>
    `На пилоте можно запустить ${builds} ${plural(builds, "сборку", "сборки", "сборок")} и сделать ${edits} ${plural(edits, "правку", "правки", "правок")} за 30 дней. Сборка — это новая система или полная пересборка по карточке, правка — изменение готовой системы.`,
  next: (date: string) => `Следующая освободится ${date}.`,
  more: "Нужно больше? Напишите команде, и мы поднимем лимит.",
  title: "Тариф",
  plan: (name: string) => `Тариф «${name}»`,
  /** Error codes after which the cabinet offers «Написать команде» instead of buying anything. */
  teamCodes: [
    "BUILDS_LIMIT",
    "EDITS_LIMIT",
    "INSUFFICIENT_CREDITS",
    "LLM_BUDGET_EXHAUSTED",
    "PLAN_LIMIT",
  ] as const,
};

export const ruDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });
