// Content of the bakery bar site (grill-11 (4)): a fictional business with concrete names, sorts, prices and hours.
// Photo fields name a slot of photos.ts; the build fills them with stock copies and credits.

export type BakeItem = { time: string; name: string; note: string };
export type MenuItem = { name: string; weight?: string; price: number; note?: string };
export type MenuGroup = { title: string; items: MenuItem[] };
export type PreorderItem = { id: string; name: string; price: number };

export const BAKERY = {
  name: "Булочная Терехова",
  short: "Терехов",
  phone: "+7 831 214-07-40",
  phoneHref: "tel:+78312140740",
  address: "Нижний Новгород, Ильинская, 64",
  addressNote: "Вход со двора через арку, синяя дверь. От Сенной площади пять минут пешком.",
  nav: [
    { label: "Печь", href: "#oven" },
    { label: "Меню", href: "#menu" },
    { label: "Предзаказ", href: "#preorder" },
    { label: "Адрес", href: "#visit" },
  ],
  first: {
    title: "Первый хлеб выходит из печи в 7:40",
    lead: "Пшеничный на закваске, ржаной с кориандром и булочки с кардамоном. Закваске Тамаре девять лет, кормим её дважды в день.",
    action: { label: "Отложить хлеб на завтра", href: "#preorder" },
    more: { label: "Меню и цены", href: "#menu" },
    today: "Сегодня открыто с 7:30 до 20:00",
    photo: "bakery-loaves",
    stamp: ["Ильинская", "64"],
  },
  oven: {
    title: "Что сейчас на витрине",
    note: "Печём весь день небольшими партиями. Время на шкале показывает, когда сорт выходит из печи.",
    closed: "Печь остыла. Завтра первый хлеб в 7:40.",
    open: "07:00",
    close: "20:00",
    bakes: [
      { time: "07:40", name: "Пшеничный на закваске", note: "12 буханок" },
      { time: "08:30", name: "Ржаной с кориандром", note: "8 буханок" },
      { time: "09:15", name: "Булочки с кардамоном", note: "2 противня" },
      { time: "10:00", name: "Круассаны", note: "40 штук" },
      { time: "12:30", name: "Чиабатта", note: "16 штук" },
      { time: "16:00", name: "Багет к ужину", note: "20 штук" },
    ] satisfies BakeItem[],
    photo: "bakery-oven",
  },
  menu: {
    title: "Меню",
    note: "Цены на октябрь 2026. Хлеб нарежем при вас, если попросите.",
    groups: [
      {
        title: "Хлеб",
        items: [
          {
            name: "Пшеничный на закваске",
            weight: "750 г",
            price: 290,
            note: "36 часов холодной ферментации",
          },
          { name: "Ржаной с кориандром", weight: "600 г", price: 240, note: "Заварной, с красным солодом" },
          { name: "Деревенский цельнозерновой", weight: "800 г", price: 320 },
          { name: "Чиабатта", weight: "300 г", price: 160 },
          { name: "Багет на пулише", weight: "250 г", price: 140 },
        ],
      },
      {
        title: "К чаю",
        items: [
          { name: "Булочка с кардамоном", price: 120 },
          { name: "Круассан на масле 82,5 %", price: 160 },
          { name: "Бриошь с апельсиновой цедрой", price: 210 },
          { name: "Медовик, кусок 150 г", price: 260 },
        ],
      },
    ] satisfies MenuGroup[],
    photos: ["bakery-shelves", "bakery-buns"],
  },
  story: {
    title: "Тамара живёт у нас с 2017 года",
    text: [
      "Закваску Олег Терехов привёз из Петербурга в стеклянной банке. Её кормят ржаной обдирной мукой в 6 утра и в 6 вечера.",
      "Муку берём на мельнице под Арзамасом, соль серая из Белого моря. Дрожжей в хлебе нет.",
    ],
    photo: "bakery-hands",
  },
  preorder: {
    title: "Предзаказ",
    rules: [
      "Принимаем до 20:00 накануне.",
      "Забрать можно с 7:40 до 13:00, потом хлеб уходит на витрину.",
      "Оплата на кассе картой или наличными.",
    ],
    days: ["Завтра", "Послезавтра"],
    items: [
      { id: "wheat", name: "Пшеничный на закваске", price: 290 },
      { id: "rye", name: "Ржаной с кориандром", price: 240 },
      { id: "grain", name: "Деревенский цельнозерновой", price: 320 },
      { id: "cardamom", name: "Булочка с кардамоном", price: 120 },
    ] satisfies PreorderItem[],
    submit: "Отложить",
    done: "Отложили. Номер заказа 0417, назовите его на кассе.",
    photo: "bakery-baskets",
  },
  visit: {
    title: "Как нас найти",
    hours: [
      ["Вторник – пятница", "7:30 – 20:00"],
      ["Суббота, воскресенье", "8:00 – 18:00"],
      ["Понедельник", "выходной"],
    ] as const,
  },
  legal: "ИП Терехов О. В. Сайт-пример, бизнес вымышленный.",
} as const;
