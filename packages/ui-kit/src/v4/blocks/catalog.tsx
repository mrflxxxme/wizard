// The block catalog of wave V5 (V5-01): descriptions the director reads and the components they render. Text limits
// come from the accepted bar sites with room for a longer Russian word (grill-11, round 4).
import type { ComponentType } from "react";
import { DIRECTIONS } from "./directions.js";
import { editorialCatalog } from "./editorial/catalog.js";
import * as M from "./masterskaya.js";
import { medicineCatalog } from "./medicine/catalog.js";
import * as N from "./nochnoy.js";
import type { Block, BlockProps, BlockSpec, DirectionId, SlotSpec } from "./types.js";

const text = (max: number, hint: string, min = 1): SlotSpec => ({ kind: "text", max, min, hint });
const opt = (s: SlotSpec): SlotSpec => ({ ...s, optional: true }) as SlotSpec;
const anchor: SlotSpec = { kind: "text", max: 24, min: 2, hint: "id раздела латиницей для якоря меню" };
const photo = (hint: string): SlotSpec => ({ kind: "photo", hint });
const href = (hint: string): SlotSpec => ({ kind: "href", hint });
const list = (min: number, max: number, item: Record<string, SlotSpec>, hint: string): SlotSpec => ({
  kind: "list",
  min,
  max,
  item,
  hint,
});
const group = (slots: Record<string, SlotSpec>, hint: string): SlotSpec => ({ kind: "group", slots, hint });
/** Builds the catalog; one pure call so a bundle that imports none of it drops all of it. */
function catalog(): readonly Block<never>[] {
  const nav = list(2, 5, { id: anchor, label: text(18, "пункт меню") }, "якоря разделов страницы");
  const mark: SlotSpec = { kind: "mark", optional: true, hint: "знак бизнеса SVG в currentColor" };

  const mHeader = {
    name: text(28, "название бизнеса"),
    logo: mark,
    nav,
    phone: text(20, "телефон +7 …"),
    phoneHref: href("tel:+7…"),
  };
  const nHeader = mHeader;
  const point = {
    address: text(26, "адрес точки"),
    hours: text(13, "часы 7:30–20:00"),
    note: text(24, "что на точке"),
  };
  const sort = {
    id: text(16, "id позиции латиницей"),
    name: text(30, "название сорта"),
    weight: text(8, "вес: 900 г"),
    price: { kind: "number", hint: "цена в рублях" } as SlotSpec,
    note: text(32, "деталь: время брожения, состав"),
  };
  const rating = group(
    { value: text(4, "оценка 4,9"), count: text(16, "1 214 оценок"), source: text(16, "Яндекс Карты") },
    "рейтинг с числом оценок и источником",
  );

  const spec = (s: Omit<BlockSpec, "signature">): BlockSpec => ({
    ...s,
    signature: DIRECTIONS[s.direction].signature.block === s.id,
  });
  const base = ["background", "foreground", "line", "primary", "primary-foreground", "ring"] as const;
  const one = [{ id: "default", label: "Основной" }] as const;

  return (
    [
      {
        spec: spec({
          id: "masterskaya.header",
          direction: "masterskaya",
          section: "header",
          title: "Шапка с телефоном",
          use: "Над любым первым экраном без шапки; телефон виден и на телефоне.",
          slots: mHeader,
          variants: one,
          tokens: base,
          motion: "none",
        }),
        Component: M.MHeader,
      },
      {
        spec: spec({
          id: "masterskaya.hero",
          direction: "masterskaya",
          section: "hero",
          title: "Один продукт",
          use: "Первый экран, когда у бизнеса есть фирменный продукт с ценой: фото продукта, его выдержка и цена, одно действие, точки.",
          slots: {
            header: group(mHeader, "шапка"),
            photo: photo("фирменный продукт крупно, тёплый утренний свет"),
            kicker: text(24, "над названием: «Фирменный хлеб»"),
            name: text(32, "название продукта", 3),
            proof: text(26, "факт выдержки с цифрой: «36 часов брожения»"),
            price: { kind: "number", hint: "цена продукта в рублях" },
            lead: text(150, "как продукт делают и как его получить, с часом", 40),
            weight: text(10, "вес"),
            rating,
            cta: text(22, "одно действие: «Заказать к утру»"),
            ctaHref: href("#order"),
            points: list(1, 3, point, "точки с часами"),
          },
          variants: [
            { id: "score", label: "Надрез-знак на фото" },
            { id: "plain", label: "Фото без знака" },
          ],
          tokens: [...base, "scrim-foreground"],
          motion: "micro",
        }),
        Component: M.MHero,
      },
      {
        spec: spec({
          id: "masterskaya.menu",
          direction: "masterskaya",
          section: "menu",
          title: "Прайс строками",
          use: "Ассортимент с весом и ценой; 3–8 позиций, фото среза или прилавка сбоку.",
          slots: {
            anchor,
            title: text(24, "«Хлеб и цены»"),
            lead: text(120, "сколько сортов и когда печём, с часами", 20),
            items: list(3, 8, sort, "позиции"),
            photo: photo("срез или мякиш крупно"),
          },
          variants: [
            { id: "photo-right", label: "Фото справа" },
            { id: "photo-left", label: "Фото слева" },
          ],
          tokens: [...base, "border"],
          motion: "none",
        }),
        Component: M.MMenu,
      },
      {
        spec: spec({
          id: "masterskaya.moment",
          direction: "masterskaya",
          section: "moment",
          title: "Час печи",
          use: "Фирменный момент направления: одно время суток крупно на фото процесса и строка, что в этот час происходит.",
          slots: {
            label: text(16, "доступное имя раздела: «Печь»"),
            time: text(5, "время 4:30"),
            line: text(90, "что происходит в этот час и к чему это ведёт", 20),
            photo: photo("процесс: печь, лопата, руки"),
          },
          variants: one,
          tokens: ["scrim", "scrim-foreground"],
          motion: "signature",
        }),
        Component: M.MMoment,
      },
      {
        spec: spec({
          id: "masterskaya.order",
          direction: "masterskaya",
          section: "order",
          title: "Предзаказ к часу",
          use: "Корзина по прайсу, точка, день и час самовывоза; сумма считается на месте.",
          slots: {
            anchor,
            title: text(24, "«Предзаказ к утру»"),
            lead: text(80, "что сделаем с заказом", 10),
            items: list(3, 8, sort, "позиции прайса"),
            preset: opt(text(16, "id позиции, которая уже в корзине")),
            points: list(1, 3, point, "точки самовывоза"),
            days: list(2, 4, { day: text(10, "Завтра, Пт, 17") }, "дни"),
            slots: list(2, 5, { slot: text(5, "7:40") }, "часы"),
            submit: text(24, "«Оформить предзаказ»"),
            note: text(90, "оплата и отмена, со временем"),
          },
          variants: one,
          tokens: [...base, "surface-alt", "border", "accent-strong"],
          motion: "none",
        }),
        Component: M.MOrder,
      },
      {
        spec: spec({
          id: "masterskaya.locations",
          direction: "masterskaya",
          section: "locations",
          title: "Точки и часы",
          use: "Адреса с часами работы, звонок; фото полок или зала.",
          slots: {
            anchor,
            title: text(20, "«Две точки»"),
            lead: text(110, "город и как связаны точки", 10),
            points: list(1, 4, point, "точки"),
            photo: photo("полки с хлебом или зал"),
            cta: text(32, "«Позвонить +7 …»"),
            ctaHref: href("tel:+7…"),
          },
          variants: [
            { id: "photo-left", label: "Фото слева" },
            { id: "photo-right", label: "Фото справа" },
          ],
          tokens: base,
          motion: "none",
        }),
        Component: M.MLocations,
      },
      {
        spec: spec({
          id: "masterskaya.reviews",
          direction: "masterskaya",
          section: "reviews",
          title: "Отзывы крупно",
          use: "Рейтинг и три отзыва с конкретикой (день, сорт, час).",
          slots: {
            anchor,
            title: text(16, "«Отзывы»"),
            rating,
            items: list(
              2,
              3,
              { name: text(16, "имя"), when: text(12, "месяц"), text: text(120, "отзыв с деталью", 30) },
              "отзывы",
            ),
          },
          variants: one,
          tokens: base,
          motion: "none",
        }),
        Component: M.MReviews,
      },
      {
        spec: spec({
          id: "masterskaya.footer",
          direction: "masterskaya",
          section: "footer",
          title: "Подвал",
          use: "Знак, адрес с часами и авторы фото.",
          slots: {
            name: text(28, "название"),
            logo: mark,
            line: text(80, "адрес, город, часы"),
            credits: list(1, 12, { credit: text(48, "автор / Pexels") }, "авторы фото"),
          },
          variants: one,
          tokens: base,
          motion: "none",
        }),
        Component: M.MFooter,
      },
      {
        spec: spec({
          id: "nochnoy-produkt.header",
          direction: "nochnoy-produkt",
          section: "header",
          title: "Шапка с телефоном",
          use: "Над любым первым экраном без шапки; телефон виден и на телефоне.",
          slots: nHeader,
          variants: one,
          tokens: [...base, "accent-text"],
          motion: "none",
        }),
        Component: N.NHeader,
      },
      {
        spec: spec({
          id: "nochnoy-produkt.hero",
          direction: "nochnoy-produkt",
          section: "hero",
          title: "Опишите проблему",
          use: "Первый экран-инструмент: вопрос в 2–5 слов, поле с примером, кнопка расчёта, три цифры доверия.",
          slots: {
            header: group(nHeader, "шапка"),
            photo: photo("мастер за работой, тёмный цех"),
            title: text(28, "вопрос клиенту: «Что с машиной?»", 6),
            fieldLabel: text(40, "подпись поля для чтения с экрана"),
            placeholder: text(44, "пример ввода: «Kia K5 2021, стучит спереди справа»"),
            cta: text(20, "«Получить расчёт»"),
            lead: text(100, "что будет после отправки, со сроком", 20),
            facts: list(3, 3, { value: text(6, "4,8"), label: text(16, "в 2ГИС") }, "цифры доверия"),
          },
          variants: one,
          tokens: [...base, "scrim", "scrim-foreground", "border"],
          motion: "none",
        }),
        Component: N.NHero,
      },
      {
        spec: spec({
          id: "nochnoy-produkt.prices",
          direction: "nochnoy-produkt",
          section: "prices",
          title: "Цены по модели",
          use: "Цены «от» на типовые работы для выбранной марки и модели.",
          slots: {
            anchor,
            title: text(28, "«Цены для вашей машины»"),
            lead: text(110, "из чего цена и когда она окончательная", 20),
            models: list(
              2,
              8,
              {
                id: text(12, "id"),
                label: text(20, "марка и модель"),
                prices: { kind: "number", hint: "цены по работам" },
              },
              "модели",
            ),
            jobs: list(3, 8, { job: text(28, "работа") }, "работы"),
            cta: text(24, "«Записаться на время»"),
            ctaHref: href("#book"),
          },
          variants: one,
          tokens: [...base, "border"],
          motion: "none",
        }),
        Component: N.NPrices,
      },
      {
        spec: spec({
          id: "nochnoy-produkt.booking",
          direction: "nochnoy-produkt",
          section: "booking",
          title: "Запись на время",
          use: "День и окно времени плитками, занятые зачёркнуты; подтверждение на кнопке.",
          slots: {
            anchor,
            title: text(24, "«Запись на время»"),
            days: list(2, 4, { day: text(10, "Сегодня") }, "дни"),
            slots: list(3, 8, { slot: text(5, "15:30") }, "окна"),
            busy: list(0, 4, { slot: text(5, "17:00") }, "занятые окна первого дня"),
            place: text(80, "куда приезжать"),
            cta: text(16, "«Записаться»"),
            note: text(80, "подтверждение и перенос, со сроком"),
          },
          variants: one,
          tokens: [...base, "surface-alt", "accent", "accent-ink", "muted-foreground"],
          motion: "none",
        }),
        Component: N.NBooking,
      },
      {
        spec: spec({
          id: "nochnoy-produkt.status",
          direction: "nochnoy-produkt",
          section: "status",
          title: "Статус ремонта в чате",
          use: "Фирменный момент направления: этапы работы и чат мастера с фото детали и согласованной ценой.",
          slots: {
            anchor,
            title: text(24, "«Статус ремонта»"),
            lead: text(120, "что клиент видит, пока машина в боксе", 20),
            car: text(32, "машина и госномер"),
            stages: list(3, 5, { stage: text(12, "этап") }, "этапы"),
            current: { kind: "number", hint: "номер текущего этапа с нуля" },
            master: text(20, "«Мастер Денис»"),
            chat: list(
              2,
              5,
              {
                who: text(6, "master или client"),
                time: text(5, "15:42"),
                text: text(90, "сообщение с деталью и ценой"),
                photo: opt(photo("деталь крупно под машиной")),
              },
              "сообщения",
            ),
          },
          variants: one,
          tokens: [...base, "accent", "muted-foreground"],
          motion: "signature",
        }),
        Component: N.NStatus,
      },
      {
        spec: spec({
          id: "nochnoy-produkt.steps",
          direction: "nochnoy-produkt",
          section: "steps",
          title: "Четыре шага",
          use: "Как проходит заказ: от заявки до оплаты, по шагу в слово.",
          slots: {
            title: text(24, "«Как это работает»"),
            items: list(
              3,
              4,
              { n: text(2, "1"), title: text(14, "шаг"), text: text(60, "что происходит") },
              "шаги",
            ),
          },
          variants: one,
          tokens: [...base, "accent", "accent-text", "muted-foreground"],
          motion: "none",
        }),
        Component: N.NSteps,
      },
      {
        spec: spec({
          id: "nochnoy-produkt.reviews",
          direction: "nochnoy-produkt",
          section: "reviews",
          title: "Отзывы с машиной",
          use: "Рейтинг, число работ и три отзыва с маркой машины автора.",
          slots: {
            title: text(16, "«Отзывы»"),
            rating: group({ value: text(4, "4,8"), source: text(12, "2ГИС") }, "рейтинг"),
            tally: text(24, "«9 400 ремонтов»"),
            items: list(
              2,
              3,
              { name: text(32, "имя и машина"), text: text(130, "отзыв с деталью", 30) },
              "отзывы",
            ),
          },
          variants: one,
          tokens: [...base, "surface-alt", "accent-text"],
          motion: "none",
        }),
        Component: N.NReviews,
      },
      {
        spec: spec({
          id: "nochnoy-produkt.contacts",
          direction: "nochnoy-produkt",
          section: "contacts",
          title: "Адрес на фото",
          use: "Адрес заголовком на тёмном фото места, часы, запись и телефон.",
          slots: {
            anchor,
            address: text(40, "город и адрес"),
            hours: text(28, "часы"),
            photo: photo("бокс или ворота сервиса"),
            cta: text(16, "«Записаться»"),
            ctaHref: href("#book"),
            phone: text(20, "телефон"),
            phoneHref: href("tel:+7…"),
          },
          variants: one,
          tokens: [...base, "scrim", "scrim-foreground"],
          motion: "none",
        }),
        Component: N.NContacts,
      },
      {
        spec: spec({
          id: "nochnoy-produkt.footer",
          direction: "nochnoy-produkt",
          section: "footer",
          title: "Подвал с доверием",
          use: "Знак, гарантия, рейтинг, адрес и авторы фото.",
          slots: {
            name: text(28, "название"),
            logo: mark,
            warranty: text(20, "«Гарантия 1 год»"),
            rating: group({ value: text(4, "4,8"), source: text(12, "2ГИС") }, "рейтинг"),
            address: text(40, "адрес"),
            credits: list(1, 12, { credit: text(48, "автор / Pexels") }, "авторы фото"),
          },
          variants: one,
          tokens: [...base, "accent-text", "muted-foreground"],
          motion: "none",
        }),
        Component: N.NFooter,
      },
    ] as unknown as readonly Block<never>[]
  ).concat(medicineCatalog(), editorialCatalog());
}

/** All blocks of the catalog; `Component` takes `{content, variant}` with content shaped by `spec.slots`. */
export const BLOCKS: readonly Block<never>[] = /* @__PURE__ */ catalog();

/** A block by id; throws on an unknown id. */
export function block(id: string): Block<never> {
  const b = BLOCKS.find((x) => x.spec.id === id);
  if (!b) throw new Error(`unknown block ${id}`);
  return b;
}

/** Blocks of one direction in catalog order. */
export const blocksOf = (d: DirectionId): readonly Block<never>[] =>
  BLOCKS.filter((b) => b.spec.direction === d);

/** Renders a block by id with untyped content (the director's path; typed callers import the component). */
export const BlockById = ({ id, ...p }: { id: string } & BlockProps<unknown>) => {
  const C = block(id).Component as unknown as ComponentType<BlockProps<unknown>>;
  return <C {...p} />;
};

function check(slots: Record<string, SlotSpec>, v: Record<string, unknown>, at: string, out: string[]): void {
  for (const [k, s] of Object.entries(slots)) {
    const x = v[k];
    const p = at ? `${at}.${k}` : k;
    if (x === undefined || x === null) {
      if (!("optional" in s && s.optional)) out.push(`${p}: нет значения`);
      continue;
    }
    if (s.kind === "text") {
      if (typeof x !== "string") out.push(`${p}: нужен текст`);
      else if (x.length > s.max) out.push(`${p}: ${x.length} знаков, предел ${s.max}`);
      else if (x.length < (s.min ?? 0)) out.push(`${p}: ${x.length} знаков, нужно от ${s.min}`);
    } else if (s.kind === "number") {
      if (typeof x !== "number" && !(Array.isArray(x) && x.every((n) => typeof n === "number")))
        out.push(`${p}: нужно число`);
    } else if (s.kind === "photo") {
      const ph = x as { src?: unknown; alt?: unknown; credit?: unknown };
      if (
        typeof ph.src !== "string" ||
        typeof ph.alt !== "string" ||
        !ph.alt ||
        typeof ph.credit !== "string"
      )
        out.push(`${p}: фото без src, alt или автора`);
    } else if (s.kind === "href") {
      if (typeof x !== "string" || !/^(#[\w-]+|tel:\+\d+|https:\/\/|mailto:[^@\s]+@)/.test(x))
        out.push(`${p}: ссылка не #, tel:, mailto: или https:`);
    } else if (s.kind === "icon") {
      if (typeof x !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(x)) out.push(`${p}: имя иконки Lucide`);
    } else if (s.kind === "list") {
      if (!Array.isArray(x)) {
        out.push(`${p}: нужен список`);
        continue;
      }
      if (x.length < s.min || x.length > s.max)
        out.push(`${p}: ${x.length} элементов, нужно ${s.min}–${s.max}`);
      const keys = Object.keys(s.item);
      x.forEach((it, i) => {
        // A one-slot list holds bare values (days, slots, credits).
        const rec = keys.length === 1 && typeof it !== "object" ? { [keys[0] as string]: it } : it;
        check(s.item, rec as Record<string, unknown>, `${p}[${i}]`, out);
      });
    } else if (s.kind === "group") {
      check(s.slots, x as Record<string, unknown>, p, out);
    }
  }
}

/** Errors of content against a block's slots (missing, over the length limit, list size, photo without credit). */
export function contentErrors(id: string, content: unknown): string[] {
  const out: string[] = [];
  check(block(id).spec.slots, (content ?? {}) as Record<string, unknown>, "", out);
  return out;
}
