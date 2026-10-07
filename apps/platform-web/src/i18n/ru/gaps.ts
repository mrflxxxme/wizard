// /admin «Запросы на развитие» (D73, M2-59 mvp_scope).

export const gaps = {
  tab: "Запросы на развитие",
  lead: "Что клиенты просили сверх возможностей платформы. Агент честно ответил, предложил замену и записал запрос.",
  empty: "Запросов пока нет",
  categoriesTitle: "По категориям",
  colCategory: "Категория",
  col7: "За 7 дней",
  col30: "За 30 дней",
  colTotal: "Всего",
  colSystems: "Систем",
  latest: "Последние запросы",
  all: "Все категории",
  quote: "Просили",
  offered: "Предложили",
  noOffer: "замены не нашлось",
  noSystem: "система удалена",
  /** B2-26: a ready module covers the request. */
  done: "сделано",
  category: {
    payments: "Оплата",
    subscriptions: "Подписки и платный доступ",
    integration: "Интеграции",
    messaging: "Сообщения и рассылки",
    design: "Дизайн",
    domain: "Свой домен",
    media: "Фото, видео, карты",
    data: "Данные",
    mobile: "Мобильное приложение",
    ai: "ИИ-функции",
    other: "Другое",
  } as Record<string, string>,
};
