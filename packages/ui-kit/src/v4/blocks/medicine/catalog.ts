// Catalog entries of «Чистая медицина» (V5-09), cut from the accepted bar site «Тридцать два». Text limits come from
// that site with room for a longer Russian word.
import { DIRECTIONS } from "../directions.js";
import type { Block, BlockSpec, SlotSpec } from "../types.js";
import * as B from "./blocks.js";

const D = "chistaya-medicina" as const;
const text = (max: number, hint: string, min = 1): SlotSpec => ({ kind: "text", max, min, hint });
const anchor: SlotSpec = { kind: "text", max: 24, min: 2, hint: "id раздела латиницей для якоря меню" };
const photo = (hint: string): SlotSpec => ({ kind: "photo", hint });
const href = (hint: string): SlotSpec => ({ kind: "href", hint });
const num = (hint: string): SlotSpec => ({ kind: "number", hint });
const list = (min: number, max: number, item: Record<string, SlotSpec>, hint: string): SlotSpec => ({
  kind: "list",
  min,
  max,
  item,
  hint,
});
const group = (slots: Record<string, SlotSpec>, hint: string): SlotSpec => ({ kind: "group", slots, hint });
const spec = (s: Omit<BlockSpec, "signature" | "direction">): BlockSpec => ({
  ...s,
  direction: D,
  signature: DIRECTIONS[D].signature.block === s.id,
});
const base = ["background", "foreground", "line", "primary", "primary-foreground", "ring"] as const;
const one = [{ id: "default", label: "Основной" }] as const;

/** Blocks of «Чистая медицина» in page order. */
export function medicineCatalog(): readonly Block<never>[] {
  const header = {
    name: text(28, "название клиники"),
    logo: { kind: "mark", optional: true, hint: "знак клиники SVG в currentColor" } as SlotSpec,
    nav: list(2, 6, { id: anchor, label: text(16, "пункт меню") }, "якоря разделов страницы"),
    phone: text(20, "телефон +7 …"),
    phoneHref: href("tel:+7…"),
    hours: text(40, "часы: «Пн–пт 8:00–22:00, сб–вс 9:00–21:00»"),
  };
  const slot = {
    time: text(5, "время 16:40"),
    doctor: text(48, "врач и кабинет; пусто у занятого окна", 0),
  };
  const fact = { value: text(8, "цифра: «4,9», «17 лет»"), label: text(32, "что за цифрой, с источником") };
  return [
    {
      spec: spec({
        id: `${D}.header`,
        section: "header",
        title: "Шапка-бланк",
        use: "Над первым экраном клиники: знак, разделы, телефон и часы на одной линии.",
        slots: header,
        variants: one,
        tokens: [...base, "accent-text", "muted-foreground"],
        motion: "none",
      }),
      Component: B.MedHeader,
    },
    {
      spec: spec({
        id: `${D}.hero`,
        section: "hero",
        title: "Запись на время",
        use: "Первый экран клиники с записью: предложение с ценой приёма, свободные окна по дням, телефон, цифры доверия.",
        slots: {
          anchor,
          header: group(header, "шапка"),
          photo: photo("врач за работой с пациентом в светлом кабинете"),
          photoNote: text(56, "подпись на фото: кабинет и оборудование"),
          place: text(40, "город и адрес строкой"),
          title: text(48, "предложение с ценой: «Осмотр, снимок и план лечения за 900 ₽»", 12),
          days: list(
            1,
            4,
            {
              id: text(8, "id дня"),
              label: text(14, "«Сегодня», «Пт, 23 окт»"),
              slots: list(3, 8, slot, "окна"),
            },
            "дни с окнами",
          ),
          phoneLabel: text(32, "подпись поля телефона"),
          cta: text(28, "кнопка с {time}: «Записаться на {time}»"),
          note: text(130, "что будет после заявки, с цифрой"),
          facts: list(3, 3, fact, "три цифры доверия"),
          footnote: text(160, "условие цены мелким шрифтом"),
        },
        variants: one,
        tokens: [...base, "accent", "accent-ink", "accent-text", "muted-foreground", "card", "border"],
        motion: "micro",
      }),
      Component: B.MedHero,
    },
    {
      spec: spec({
        id: `${D}.prices`,
        section: "prices",
        title: "Цены без «от»",
        use: "Прайс услуг группами: что входит и одна твёрдая цена в строке; 2–6 групп.",
        slots: {
          anchor,
          title: text(24, "заголовок: «Цены без «от»»"),
          lead: text(140, "что уже входит в каждую цену", 30),
          cta: text(22, "действие: «Выбрать время»"),
          ctaHref: href("#zapis"),
          groups: list(
            2,
            6,
            {
              title: text(16, "группа: «Лечение»"),
              rows: list(
                1,
                5,
                { name: text(34, "услуга"), what: text(64, "что входит"), price: num("цена в рублях") },
                "строки",
              ),
            },
            "группы услуг",
          ),
        },
        variants: one,
        tokens: [...base, "muted-foreground"],
        motion: "none",
      }),
      Component: B.MedPrices,
    },
    {
      spec: spec({
        id: `${D}.plan`,
        section: "moment",
        title: "План с ценой",
        use: "Фирменный момент клиники: план лечения по зубам и работам складывается в итог, штамп фиксирует цену.",
        slots: {
          anchor,
          title: text(36, "заголовок про цену плана"),
          lead: text(150, "как появляется план и почему сумма не меняется", 40),
          points: list(2, 4, { point: text(72, "гарантия плана с цифрой или пунктом договора") }, "гарантии"),
          sheet: group(
            {
              head: text(28, "«План лечения № 2417»"),
              patient: text(44, "пациент инициалами и врач"),
              lines: list(
                2,
                6,
                { tooth: text(4, "номер зуба или «все»"), item: text(40, "работа"), price: num("цена") },
                "строки плана",
              ),
              totalLabel: text(18, "«Итого по плану»"),
              stamp: text(22, "текст штампа"),
            },
            "бланк плана",
          ),
        },
        variants: one,
        tokens: [...base, "surface-alt", "card", "accent", "accent-text", "muted-foreground"],
        motion: "signature",
      }),
      Component: B.MedPlan,
    },
    {
      spec: spec({
        id: `${D}.doctors`,
        section: "team",
        title: "Врачи и их окна",
        use: "Врачи портретами 4:5: специальность, стаж цифрой, факт работы и ближайшее окно со ссылкой на запись.",
        slots: {
          anchor,
          title: text(24, "заголовок"),
          lead: text(90, "условие записи к врачу"),
          cta: text(14, "«Записаться»"),
          ctaHref: href("#zapis"),
          doctors: list(
            2,
            4,
            {
              name: text(24, "имя и фамилия"),
              role: text(24, "специальность"),
              years: text(8, "стаж: «14 лет»"),
              fact: text(44, "факт с цифрой"),
              next: text(22, "ближайшее окно"),
              photo: photo("портрет врача в форме"),
            },
            "врачи",
          ),
        },
        variants: one,
        tokens: [...base, "accent-text", "muted-foreground"],
        motion: "none",
      }),
      Component: B.MedDoctors,
    },
    {
      spec: spec({
        id: `${D}.reviews`,
        section: "reviews",
        title: "Отзывы с врачом и лечением",
        use: "Рейтинги внешних сервисов крупными цифрами и датированные отзывы с врачом и видом лечения.",
        slots: {
          anchor,
          title: text(16, "«Отзывы»"),
          ratings: list(
            1,
            3,
            { value: text(4, "4,9"), source: text(32, "сервис и число оценок") },
            "рейтинги",
          ),
          items: list(
            2,
            4,
            {
              name: text(20, "имя и инициал"),
              date: text(16, "месяц и год"),
              doctor: text(44, "врач и лечение"),
              text: text(180, "отзыв с фактом: время, цена, срок", 40),
            },
            "отзывы",
          ),
        },
        variants: one,
        tokens: [...base, "muted-foreground"],
        motion: "none",
      }),
      Component: B.MedReviews,
    },
    {
      spec: spec({
        id: `${D}.contacts`,
        section: "contacts",
        title: "Как добраться",
        use: "Адрес, путь от остановки и парковка, часы таблицей, запись и телефон, фото кабинета.",
        slots: {
          anchor,
          title: text(20, "заголовок"),
          address: text(44, "город, улица, дом"),
          way: list(1, 4, { line: text(64, "остановка, парковка, вход") }, "как добраться"),
          hours: list(1, 4, { days: text(24, "дни"), time: text(14, "часы") }, "часы"),
          phone: text(20, "телефон"),
          phoneHref: href("tel:+7…"),
          cta: text(22, "«Записаться онлайн»"),
          ctaHref: href("#zapis"),
          photo: photo("пустой кабинет или кресло"),
        },
        variants: one,
        tokens: [...base, "surface-alt"],
        motion: "none",
      }),
      Component: B.MedContacts,
    },
    {
      spec: spec({
        id: `${D}.footer`,
        section: "footer",
        title: "Подвал с лицензией",
        use: "Юрлицо, лицензия с номером и датой, обязательное предупреждение о противопоказаниях, авторы фото.",
        slots: {
          name: text(28, "название"),
          logo: { kind: "mark", optional: true, hint: "знак клиники" } as SlotSpec,
          warning: text(72, "«Имеются противопоказания. Необходима консультация специалиста»"),
          legal: list(1, 4, { line: text(150, "юрлицо, ИНН, лицензия, адрес") }, "строки реквизитов"),
          credits: list(1, 12, { credit: text(48, "автор / Pexels") }, "авторы фото"),
        },
        variants: one,
        tokens: [...base, "muted-foreground"],
        motion: "none",
      }),
      Component: B.MedFooter,
    },
  ] as unknown as readonly Block<never>[];
}
