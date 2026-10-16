// Texts of the canvas v4 (V4-11, D79_v4 (8)): the command bar and its «приборка» (V5-07).

export const islandRu = {
  label: "Панель управления системой",
  chat: "Чат",
  build: "Ход сборки",
  buildLeft: (left: string) => `Ход сборки — ${left}`,
  buildFailed: "Сборка не получилась — откройте, что делать",
  brief: "Бриф",
  device: { desktop: "Компьютер", phone: "Телефон", label: "Как показать систему", title: "Устройство" },
  edit: "Правка",
  publish: "Публикация",
  open: "Открыть в новой вкладке",
  openFailed: "Не получилось открыть систему в новой вкладке — попробуйте ещё раз.",
  more: "Ещё",
  home: "К списку систем",
  settings: "Настройки системы",
  support: "Написать команде",
  tiles: "Приборка",
  placeholder: "Что изменить?",
  stop: "Стоп",
  chipRemove: "Убрать элемент",
  close: "Закрыть",
  attention: "Нужен ваш ответ",
} as const;

export const stageRu = {
  frame: "Ваша система",
  loading: "Загружаю систему…",
  pending: "Каркас страниц появится здесь через пару минут — сразу после подбора стиля.",
  v2Empty: "Расскажите о своём деле в чате — здесь появится система.",
  buildPanel: "Ход сборки",
  publishPanel: "Публикация",
  done: "готово",
  noBuild: "Сборки ещё не было. Когда она начнётся, здесь будет видно, что готово и сколько осталось.",
} as const;
