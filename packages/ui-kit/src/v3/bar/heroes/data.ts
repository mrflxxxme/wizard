// Copy of the round-2 first screens (grill-11, «Круг 2»): the same two fictional businesses, now with a voice,
// a rating with a number and one strong offer per screen.

export const TEREKHOV = {
  name: "Булочная Терехова",
  short: "Терехова",
  address: "Ильинская, 64",
  city: "Нижний Новгород",
  hours: "7:30–20:00",
  phone: "+7 831 214-07-40",
  phoneHref: "tel:+78312140740",
  rating: { value: "4,9", count: "1 214 оценок", source: "Яндекс Карты" },
  review: {
    text: "Прихожу к 7:40 ради первой буханки. Корка трещит ещё по дороге домой.",
    author: "Ольга, соседний дом",
  },
  nav: ["Хлеб", "Выпечка", "Подписка", "Как найти"],
  bakes: [
    { time: "7:40", name: "Пшеничный на закваске", left: "12 буханок" },
    { time: "8:30", name: "Ржаной с кориандром", left: "8 буханок" },
    { time: "9:15", name: "Булочки с кардамоном", left: "2 противня" },
    { time: "10:00", name: "Круассаны", left: "40 штук" },
  ],
  hold: {
    title: "Хлеб вышел в 7:40",
    lead: "Пока он тёплый, отложим буханку на ваше имя. Заберёте до 9:00, платить на месте.",
    cta: "Отложить буханку",
    price: 290,
  },
  clock: {
    kicker: "Первая буханка из печи",
    lead: "Двенадцать пшеничных на закваске уходят к девяти. Напишите вечером, утром ваша будет ждать на полке с бумажной биркой.",
    cta: "Заказать на утро",
  },
  sign: {
    since: "Печём на Ильинской с 2011 года",
    lead: "Три буханки в неделю за 790 ₽ вместо 870. Вы выбираете дни, мы печём на ваше имя.",
    cta: "Оформить подписку",
    perks: [
      { value: "790 ₽", label: "три буханки в неделю" },
      { value: "−80 ₽", label: "к цене на полке" },
      { value: "0 ₽", label: "пропустить неделю" },
    ],
  },
} as const;

export type CarModel = { id: string; label: string; to: number; brakes: number; hours: string };

export const BOX14 = {
  name: "Бокс 14",
  address: "Екатеринбург, Монтажников, 4",
  hours: "ежедневно 9:00–23:00",
  phone: "+7 343 288-14-14",
  phoneHref: "tel:+73432881414",
  rating: { value: "4,8", count: "936 отзывов", source: "2ГИС" },
  nav: ["Цены", "Запись", "Статус ремонта", "Контакты"],
  models: [
    { id: "k5", label: "Kia K5", to: 7800, brakes: 9600, hours: "2 ч 10 мин" },
    { id: "camry", label: "Toyota Camry", to: 8400, brakes: 10400, hours: "2 ч 20 мин" },
    { id: "tucson", label: "Hyundai Tucson", to: 7600, brakes: 9900, hours: "2 ч" },
    { id: "jolion", label: "Haval Jolion", to: 6900, brakes: 8700, hours: "1 ч 50 мин" },
    { id: "tiguan", label: "Volkswagen Tiguan", to: 9200, brakes: 11800, hours: "2 ч 30 мин" },
  ] satisfies CarModel[],
  services: ["ТО по регламенту", "Тормоза", "Подвеска", "Диагностика"],
  slots: ["15:30", "17:00", "18:30", "20:00"],
  booking: {
    title: "Бокс свободен сегодня в 15:30",
    lead: "Выберите машину, цена посчитается сразу. Пока она на подъёмнике, мастер присылает фото в чат.",
  },
  status: [
    { step: "Приняли", time: "10:05", done: true },
    { step: "Диагностика", time: "10:40", done: true },
    { step: "Ждём ваше «да»", time: "11:12", done: false },
    { step: "Готово", time: "≈ 14:00", done: false },
  ],
  chat: {
    title: "Мастер пишет в чат, пока машина на подъёмнике",
    lead: "Фото каждой снятой детали и цена до начала работ. Ничего не меняем без вашего «да».",
    master: "Денис, мастер",
    car: "Kia K5 · А 714 КМ 196",
    messages: [
      "Сняли передние колёса. Колодки стёрлись до 2 мм, на диске бортик.",
      "Колодки и диски с работой: 9 600 ₽, к 14:00 успеем. Согласуете?",
    ],
    reply: "Да, меняйте",
  },
  plate: {
    label: "Госномер",
    number: "А 714 КМ",
    region: "196",
    title: "Номер машины, и мы уже знаем, что ей нужно",
    car: "Kia K5, 2021, 2,5 л",
    history: "Последнее ТО у нас в марте: 52 400 км",
    due: "Через 7 600 км очередное ТО-60",
    cta: "Записаться на ТО-60",
  },
} as const;
