// Texts of «Сначала показать» (V4-08): plain Russian (D48).

export const firstRu = {
  label: "Три первых экрана вашего сайта",
  carousel: "карусель",
  frame: (name: string) => `Первый экран в стиле «${name}»`,
  count: (i: number, n: number) => `Вариант ${i} из ${n}`,
  prev: "Предыдущий вариант",
  next: "Следующий вариант",
  build: "Собрать в этом стиле",
  building: "Запускаю сборку…",
  reroll: "Другие варианты",
  loadingTitle: "Рисую три первых экрана",
  loading: (sec: number) =>
    sec < 5 ? "Беру то, что вы рассказали, и подбираю стиль." : `Уже ${sec} с — обычно до полутора минут.`,
  waiting: "Экраны появятся, как только я пойму, чем вы занимаетесь.",
  failedTitle: "Экраны не получились",
  failed: "Не получилось нарисовать экраны. Попробуйте ещё раз.",
  retry: "Попробовать ещё раз",
  buildFailed: "Сборка не запустилась. Попробуйте ещё раз.",
  /** A question of the interview deferred to the build: asked in the chat, the build goes on with the default. */
  buildQuestion: "Вопрос по ходу сборки",
  buildDefault: (label: string) => `Пока собираю так: ${label}`,
  buildAnswerLater: "Ответить можно в чате после сборки — поправлю.",
} as const;
