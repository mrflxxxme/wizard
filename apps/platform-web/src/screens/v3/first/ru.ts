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
  /** V4-17: what is being drawn right now. */
  stage: {
    design: "Подбираю палитру и шрифты…",
    texts: "Пишу заголовок и кнопку…",
    screens: "Собираю первый экран…",
  },
  seconds: (sec: number) => (sec < 3 ? "" : `${sec} с`),
  readyMore: (ready: number, total: number) =>
    ready >= total ? "Все варианты готовы." : `Готово ${ready} из ${total}, дорисовываю остальные…`,
  tooLong: "Экраны рисуются дольше обычного. Попробуйте ещё раз — начну заново.",
  fallback:
    "Модель не ответила вовремя — тексты взяты из ваших ответов. «Другие варианты» попробуют ещё раз.",
  failedTitle: "Экраны не получились",
  failed: "Не получилось нарисовать экраны. Попробуйте ещё раз.",
  retry: "Попробовать ещё раз",
  buildFailed: "Сборка не запустилась. Попробуйте ещё раз.",
  /** A question of the interview deferred to the build: asked in the chat, the build goes on with the default. */
  buildQuestion: "Вопрос по ходу сборки",
  buildDefault: (label: string) => `Пока собираю так: ${label}`,
  buildAnswerLater: "Ответить можно в чате после сборки — поправлю.",
} as const;
