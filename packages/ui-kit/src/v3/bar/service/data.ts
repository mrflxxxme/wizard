// Content of the car service bar site (grill-11 (4)): a fictional night-shift garage with prices, times and masters.

/** A unit on the car scheme: x/y in the 800×320 viewBox of CarScheme. */
export type Unit = {
  id: string;
  name: string;
  x: number;
  y: number;
  jobs: { name: string; price: number; time: string }[];
};

export const SERVICE = {
  name: "Бокс 14",
  phone: "+7 343 288-14-14",
  phoneHref: "tel:+73432881414",
  address: "Екатеринбург, Монтажников, 4, бокс 14",
  addressNote: "Въезд со стороны Монтажников через шлагбаум. Охраннику скажите «в четырнадцатый».",
  nav: [
    { label: "Цены", href: "#units" },
    { label: "Запись", href: "#booking" },
    { label: "Адрес", href: "#visit" },
  ],
  first: {
    title: "Ремонт после работы, до 23:00 каждый день",
    lead: "Два подъёмника, два мастера. Цену работы пишем в заказ-наряд до того, как машина поднимется.",
    action: { label: "Записаться на вечер", href: "#booking" },
    slot: "Свободно сегодня: 19:30 и 21:00",
    facts: [
      ["6 мес.", "гарантия на работу"],
      ["30 мин", "замена масла"],
      ["900 ₽", "диагностика ходовой"],
    ] as const,
    photo: "service-lift",
  },
  units: {
    title: "Наведите на узел, чтобы увидеть цену",
    titleStill: "Цены по узлам",
    note: "Цены за работу. Запчасти ваши или наши, наши без наценки к чеку поставщика.",
    list: [
      {
        id: "engine",
        name: "Двигатель",
        x: 150,
        y: 182,
        jobs: [
          { name: "Масло и фильтр", price: 1400, time: "30 мин" },
          { name: "Свечи зажигания", price: 1200, time: "40 мин" },
          { name: "Ремень ГРМ с роликами", price: 7800, time: "4 ч" },
        ],
      },
      {
        id: "front-brakes",
        name: "Передние тормоза",
        x: 190,
        y: 238,
        jobs: [
          { name: "Колодки, ось", price: 1800, time: "50 мин" },
          { name: "Диски и колодки, ось", price: 3200, time: "1,5 ч" },
        ],
      },
      {
        id: "suspension",
        name: "Подвеска",
        x: 610,
        y: 172,
        jobs: [
          { name: "Амортизаторы, пара", price: 4500, time: "2 ч" },
          { name: "Сайлентблоки рычага", price: 2600, time: "1,5 ч" },
        ],
      },
      {
        id: "alignment",
        name: "Развал-схождение",
        x: 610,
        y: 238,
        jobs: [{ name: "Регулировка на стенде", price: 2200, time: "40 мин" }],
      },
      {
        id: "diagnostics",
        name: "Диагностика",
        x: 410,
        y: 196,
        jobs: [
          { name: "Ходовая на подъёмнике", price: 900, time: "30 мин" },
          { name: "Чтение ошибок сканером", price: 700, time: "20 мин" },
        ],
      },
    ] satisfies Unit[],
  },
  work: {
    title: "Кто работает",
    people: [
      { name: "Руслан Галиев", role: "Ходовая и тормоза, 14 лет в сервисе", photo: "service-brakes" },
      {
        name: "Денис Коротков",
        role: "Двигатель и электрика, бывший дилерский мастер",
        photo: "service-engine",
      },
    ],
    photo: "service-under-car",
  },
  booking: {
    title: "Запись на время",
    days: ["Сегодня, пт", "Сб, 17 окт", "Вс, 18 окт"],
    slots: ["10:00", "11:30", "13:00", "14:30", "16:00", "17:30", "19:00", "19:30", "21:00", "22:00"],
    taken: [
      ["10:00", "11:30", "13:00", "14:30", "16:00", "17:30", "19:00", "22:00"],
      ["10:00", "13:00", "19:00"],
      ["11:30"],
    ],
    submit: "Записаться",
    done: (day: string, time: string) => `Записали: ${day}, ${time}. Напомним СМС за два часа.`,
  },
  visit: {
    title: "Адрес",
    hours: "Каждый день 10:00 – 23:00",
    photo: "service-tools",
  },
  legal: "ООО «Бокс 14». Сайт-пример, бизнес вымышленный.",
} as const;
