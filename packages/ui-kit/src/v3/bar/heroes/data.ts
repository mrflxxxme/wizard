// Copy of the round-3 first screens (grill-11, «Круг 3»): what a visitor does on the best sites of the niche.
// Bakery: shelf of the day, one signature loaf, a pre-order. Car service: pick by car, describe the problem,
// plate and the offer of the month.

export const TEREKHOV = {
  name: "Булочная Терехова",
  short: "Терехова",
  address: "Ильинская, 64",
  city: "Нижний Новгород",
  hours: "ежедневно 7:30–20:00",
  phone: "+7 831 214-07-40",
  phoneHref: "tel:+78312140740",
  rating: { value: "4,9", count: "1 214 оценок", source: "Яндекс Карты" },
  nav: ["Хлеб", "Выпечка", "Предзаказ", "Как найти"],
  points: [
    { address: "Ильинская, 64", hours: "7:30–20:00", note: "печь и полка" },
    { address: "Большая Покровская, 12", hours: "8:00–21:00", note: "полка, кофе" },
  ],
  shelf: {
    title: "Хлеб на закваске. Каждое утро с\u00a07:40",
    cta: "Как найти",
    updated: "Полка на 9:40",
    items: [
      { name: "Пшеничный на закваске", price: 290, left: 7, of: 12, unit: "буханок" },
      { name: "Ржаной с кориандром", price: 260, left: 5, of: 8, unit: "буханок" },
      { name: "Чиабатта", price: 180, left: 11, of: 16, unit: "штук" },
      { name: "Булочка с кардамоном", price: 120, left: 2, of: 24, unit: "штуки" },
      { name: "Круассан", price: 150, left: 0, of: 40, unit: "штук", next: "Будет в 12:30" },
    ],
  },
  loaf: {
    kicker: "Фирменный хлеб",
    name: "Пшеничный на закваске",
    proof: "36 часов брожения",
    price: 290,
    weight: "900 г",
    cta: "Заказать к утру",
    lead: "Надрез «Т» делаем на каждой буханке перед печью. Закажите до 21:00, утром заберёте тёплый.",
  },
  order: {
    season: "Куличи к Пасхе принимаем до 30 апреля",
    seasonCta: "Заказать кулич",
    title: "Предзаказ на утро",
    items: [
      { id: "wheat", name: "Пшеничный на закваске", weight: "900 г", price: 290 },
      { id: "rye", name: "Ржаной с кориандром", weight: "700 г", price: 260 },
      { id: "ciabatta", name: "Чиабатта", weight: "300 г", price: 180 },
      { id: "kulich", name: "Кулич с изюмом", weight: "800 г", price: 690 },
    ],
    days: ["Завтра", "Пт, 17", "Сб, 18"],
    slots: ["7:40", "8:30", "9:30", "12:30"],
    note: "Платите при получении. Отменить можно до 21:00 накануне.",
  },
} as const;

export type CarModel = { id: string; label: string; prices: readonly number[] };

export const BOX14 = {
  name: "Бокс 14",
  address: "Екатеринбург, Монтажников, 4",
  hours: "ежедневно 9:00–23:00",
  phone: "+7 343 288-14-14",
  phoneHref: "tel:+73432881414",
  rating: { value: "4,8", source: "2ГИС" },
  repairs: "9 400",
  warranty: "гарантия 1 год",
  nav: ["Цены", "Запись", "Статус ремонта", "Контакты"],
  brands: ["Kia", "Hyundai", "Toyota", "Haval", "Volkswagen"],
  /** Prices «от» per job in the order of `jobs`. */
  models: [
    { id: "k5", label: "Kia K5", prices: [7800, 4900, 2400, 6200, 1200] },
    { id: "rio", label: "Kia Rio", prices: [5900, 3900, 2400, 4800, 1200] },
    { id: "sportage", label: "Kia Sportage", prices: [8200, 5200, 2400, 6900, 1200] },
  ] satisfies CarModel[],
  jobs: [
    "ТО по регламенту",
    "Колодки передние",
    "Диагностика подвески",
    "Сход-развал и подвеска",
    "Замена масла",
  ],
  book: {
    title: "Запись на сервис",
    cta: "Записаться",
    slot: "Ближайшее окно сегодня в 15:30",
  },
  ask: {
    title: "Что с машиной?",
    placeholder: "Kia K5 2021, стучит спереди справа",
    cta: "Получить расчёт",
    lead: "Мастер ответит в чате за 15 минут: что проверить и сколько это стоит.",
    steps: [
      { n: "1", title: "Опишите", text: "Марка, год и что слышно или видно." },
      { n: "2", title: "Расчёт", text: "Мастер называет работы и цену до записи." },
      { n: "3", title: "Бокс", text: "Приезжаете в выбранное время, фото деталей в чат." },
      { n: "4", title: "Оплата", text: "Платите после ремонта, гарантия год." },
    ],
    prices: [
      { job: "Диагностика подвески", from: 1500 },
      { job: "Замена стоек стабилизатора", from: 1800 },
      { job: "Колодки передние", from: 2400 },
      { job: "ТО по регламенту", from: 5900 },
    ],
  },
  promo: {
    kicker: "Октябрь",
    title: "Диагностика подвески 0 ₽",
    terms: "при онлайн-записи до 31 октября",
    old: 1500,
    cta: "Записаться бесплатно",
  },
  need: {
    title: "Что нужно?",
    plateLabel: "Госномер",
    plate: "А 714 КМ",
    region: "196",
    cta: "Найти машину",
    categories: [
      { label: "ТО", from: 5900 },
      { label: "Шины", from: 1600 },
      { label: "Тормоза", from: 2400 },
      { label: "Подвеска", from: 1500 },
      { label: "Масло", from: 1200 },
      { label: "Диагностика", from: 0 },
    ],
  },
} as const;
