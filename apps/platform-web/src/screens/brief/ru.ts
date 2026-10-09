// Russian texts of the «Бриф» screen parts (V3-06, D48: plain words).
export const briefRu = {
  button: "Бриф",
  dialog: "Бриф системы",
  loading: "Загружаю бриф…",
  loadError: "Не получилось загрузить бриф. Попробуйте ещё раз.",
  retry: "Повторить",
  saved: (v: number) => `Сохранено — это версия ${v}.`,
  unchanged: "Изменений нет — новая версия не нужна.",
  updated: (v: number) => `Бриф обновлён — версия ${v}.`,
  conflict: "Бриф успели изменить — показываю свежую версию. Повторите правку, если она ещё нужна.",
  invalid: (m: string) => `Не получается сохранить: ${m}`,
} as const;
