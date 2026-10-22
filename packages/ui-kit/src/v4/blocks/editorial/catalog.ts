// Catalog entries of «Редакция» (V5-09), cut from the accepted bar site «Бюро Лаптевой». Text limits come from that
// site with room for a longer Russian word.
import { DIRECTIONS } from "../directions.js";
import type { Block, BlockSpec, SlotSpec } from "../types.js";
import * as B from "./blocks.js";

const D = "redaktsiya" as const;
const text = (max: number, hint: string, min = 1): SlotSpec => ({ kind: "text", max, min, hint });
const opt = (s: SlotSpec): SlotSpec => ({ ...s, optional: true }) as SlotSpec;
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

/** Blocks of «Редакция» in page order. */
export function editorialCatalog(): readonly Block<never>[] {
  const header = {
    name: text(28, "название бюро или имя эксперта"),
    logo: { kind: "mark", optional: true, hint: "знак SVG в currentColor" } as SlotSpec,
    dateline: list(1, 3, { line: text(44, "город и адрес, часы") }, "строки над названием"),
    motto: text(90, "чем занимается и с какого года"),
    nav: list(2, 7, { id: anchor, label: text(22, "пункт меню") }, "якоря разделов страницы"),
    phone: text(20, "телефон +7 …"),
    phoneHref: href("tel:+7…"),
  };
  const fact = { value: text(8, "цифра: «38 412», «4,9»"), label: text(32, "что за цифрой") };
  return [
    {
      spec: spec({
        id: `${D}.header`,
        section: "header",
        title: "Шапка-нейплейт",
        use: "Над первым экраном эксперта или студии: строка адреса и часов, название крупно над двойной линейкой.",
        slots: header,
        variants: one,
        tokens: [...base, "accent-text"],
        motion: "none",
      }),
      Component: B.EdHeader,
    },
    {
      spec: spec({
        id: `${D}.hero`,
        section: "hero",
        title: "Первая полоса",
        use: "Первый экран услуги: заголовок с ценой, абзац с буквицей и сроком, одно действие, прайс оглавлением, четыре цифры.",
        slots: {
          header: group(header, "шапка"),
          kicker: text(28, "над заголовком: главное удобство"),
          title: text(48, "предложение с ценой", 12),
          lead: text(220, "что прислать и когда получить, с часом", 60),
          cta: text(28, "одно действие: «Прислать фото в Telegram»"),
          ctaHref: href("#kak или https://t.me/…"),
          alt: text(48, "второй путь текстовой ссылкой"),
          altHref: href("mailto:… или https://"),
          tocTitle: text(32, "заголовок оглавления цен"),
          toc: list(
            3,
            6,
            {
              name: text(40, "услуга"),
              price: num("цена в рублях"),
              plus: opt(text(28, "доплата: «госпошлина 2 500 ₽»")),
              term: text(24, "срок"),
            },
            "услуги с ценой и сроком",
          ),
          tocNote: text(110, "к каким условиям относятся цены"),
          photo: photo("руки с ручкой над бумагами, работа с текстом"),
          caption: text(90, "подпись к фото курсивом"),
          facts: list(4, 4, fact, "четыре цифры доверия"),
        },
        variants: one,
        tokens: [...base, "accent-text", "muted-foreground"],
        motion: "none",
      }),
      Component: B.EdHero,
    },
    {
      spec: spec({
        id: `${D}.proof`,
        section: "moment",
        title: "Вторая читка",
        use: "Фирменный момент экспертной услуги: на странице работы красный карандаш исправляет ошибки и объясняет каждую на полях.",
        slots: {
          anchor,
          kicker: text(20, "надзаголовок"),
          title: text(40, "заголовок про проверку"),
          lead: text(220, "кто проверяет и какие ошибки ищет", 60),
          figure: group({ value: text(8, "цифра"), label: text(56, "что исправили") }, "цифра проверки"),
          sheet: group(
            {
              head: text(48, "что за страница"),
              lines: list(
                3,
                7,
                {
                  label: text(18, "поле"),
                  text: opt(text(80, "текст строки без правки")),
                  before: opt(text(16, "текст до правки")),
                  fix: opt(
                    group(
                      {
                        wrong: text(20, "как было"),
                        right: text(20, "как верно"),
                        note: text(64, "почему, на полях"),
                      },
                      "правка",
                    ),
                  ),
                },
                "строки страницы, 2–3 с правкой",
              ),
              sign: text(32, "подпись редактора"),
            },
            "страница с правкой",
          ),
        },
        variants: one,
        tokens: [...base, "card", "accent", "accent-text", "muted-foreground"],
        motion: "signature",
      }),
      Component: B.EdProof,
    },
    {
      spec: spec({
        id: `${D}.prices`,
        section: "prices",
        title: "Цены колонкой",
        use: "Цены по видам (языки, отрасли права, тарифы) таблицей в две цены и срок, условия заметками.",
        slots: {
          anchor,
          title: text(24, "заголовок"),
          lead: text(160, "что считается единицей цены", 30),
          heads: group(
            {
              lang: text(14, "первая колонка"),
              doc: text(16, "первая цена"),
              page: text(18, "вторая цена"),
              term: text(10, "срок"),
            },
            "заголовки колонок",
          ),
          langs: list(
            3,
            10,
            { name: text(16, "вид"), doc: num("цена"), page: num("цена"), term: text(10, "срок") },
            "строки таблицы",
          ),
          notes: list(1, 4, { note: text(90, "условие с цифрой") }, "заметки"),
        },
        variants: one,
        tokens: [...base, "surface-alt"],
        motion: "none",
      }),
      Component: B.EdPrices,
    },
    {
      spec: spec({
        id: `${D}.steps`,
        section: "steps",
        title: "Шаги колонками",
        use: "Как получить услугу за 3–4 шага: крупная цифра, глагол, срок или условие.",
        slots: {
          anchor,
          title: text(28, "заголовок"),
          items: list(
            3,
            4,
            { title: text(24, "шаг глаголом"), text: text(110, "что происходит, с цифрой") },
            "шаги",
          ),
        },
        variants: one,
        tokens: [...base, "accent-text"],
        motion: "none",
      }),
      Component: B.EdSteps,
    },
    {
      spec: spec({
        id: `${D}.people`,
        section: "team",
        title: "Человек за делом",
        use: "Основатель или эксперт: цитата с цифрой крупным кеглем, чёрно-белый портрет, биография и список сотрудников.",
        slots: {
          anchor,
          quote: text(150, "цитата с фактом", 40),
          author: text(24, "имя"),
          role: text(56, "роль"),
          photo: photo("деловой портрет у окна"),
          bio: text(200, "биография с годами", 40),
          staffTitle: text(28, "заголовок списка"),
          staff: list(2, 10, { lang: text(24, "направление"), names: text(44, "имена") }, "сотрудники"),
        },
        variants: one,
        tokens: [...base, "accent-text"],
        motion: "none",
      }),
      Component: B.EdPeople,
    },
    {
      spec: spec({
        id: `${D}.reviews`,
        section: "reviews",
        title: "Письма в бюро",
        use: "Отзывы как письма в редакцию: что сделали и куда, текст с фактом, рейтинг в шапке раздела.",
        slots: {
          anchor,
          title: text(20, "заголовок"),
          rating: group({ value: text(4, "4,9"), source: text(28, "сервис и число отзывов") }, "рейтинг"),
          items: list(
            3,
            3,
            {
              name: text(20, "имя"),
              doc: text(36, "услуга и куда"),
              text: text(180, "отзыв с фактом", 40),
            },
            "отзывы",
          ),
        },
        variants: one,
        tokens: [...base, "surface-alt", "accent-text"],
        motion: "none",
      }),
      Component: B.EdReviews,
    },
    {
      spec: spec({
        id: `${D}.contacts`,
        section: "contacts",
        title: "Адрес и часы",
        use: "Адрес, путь до двери, часы офиса и партнёра (нотариуса), действие и почта, фото города с подписью.",
        slots: {
          anchor,
          title: text(20, "заголовок"),
          address: text(32, "улица, дом, офис"),
          way: list(1, 4, { line: text(56, "остановка, этаж, партнёр") }, "как дойти"),
          hours: list(1, 4, { who: text(20, "кто и дни"), time: text(14, "часы") }, "часы"),
          cta: text(28, "действие"),
          ctaHref: href("#kak или https://t.me/…"),
          email: text(32, "почта"),
          emailHref: href("mailto:…"),
          photo: photo("город бизнеса"),
          caption: text(80, "подпись к фото"),
        },
        variants: one,
        tokens: base,
        motion: "none",
      }),
      Component: B.EdContacts,
    },
    {
      spec: spec({
        id: `${D}.footer`,
        section: "footer",
        title: "Подвал с реквизитами",
        use: "Название, реквизиты ИП или юрлица, оговорка о партнёре, авторы фото.",
        slots: {
          name: text(28, "название"),
          logo: { kind: "mark", optional: true, hint: "знак" } as SlotSpec,
          legal: list(1, 4, { line: text(110, "реквизиты") }, "строки реквизитов"),
          credits: list(1, 12, { credit: text(48, "автор / Pexels") }, "авторы фото"),
        },
        variants: one,
        tokens: [...base, "muted-foreground"],
        motion: "none",
      }),
      Component: B.EdFooter,
    },
  ] as unknown as readonly Block<never>[];
}
