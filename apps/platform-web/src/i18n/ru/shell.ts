// Texts of the platform frame v2 and the start screen (B2-33): plain Russian, no jargon (specs «Тексты для людей»).

export const shell = {
  brand: "Born to Build",
  home: "Born to Build — на главную",
  navLabel: "Разделы",
  systems: "Системы",
  billing: "Тарифы",
  darkTheme: "Тёмная тема",
  toDark: "Включить тёмную тему",
  toLight: "Включить светлую тему",
  loading: "Загружаем…",
  /** Greeting of the start screen by the local hour (prototype E). */
  greeting(hour: number): string {
    if (hour < 5) return "Доброй ночи";
    if (hour < 12) return "Доброе утро";
    if (hour < 18) return "Добрый день";
    return "Добрый вечер";
  },
  start: {
    placeholder: "Расскажите о своём деле",
    lead: "Опишите своими словами, чем вы занимаетесь и что должна делать система. Остальное уточню кнопками.",
    send: "Начать",
    sendHint: "Enter — отправить, Shift+Enter — новая строка",
    examples: "Примеры",
  },
} as const;
