// Catalog patterns (V3-08, needs catalog): showcases of the «Каталог и прайс» module over useCatalog
// (@wizard/ui-kit/v3/headless, C4) — visible items in the owner's order, sections, «Показать ещё». Names, prices,
// durations and photos come only from the data; the slots carry the section's own texts and the field names.
import { z } from "zod";
import { definePattern } from "../define.js";
import { line, linkSlot, para, SAME_ORIGIN_PATH_RE } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Carousel from "./carousel.js";
import type Featured from "./featured.js";
import type Grid from "./grid.js";
import type List from "./list.js";
import type PriceList from "./price-list.js";
import type Sections from "./sections.js";
import type Table from "./table.js";
import type Tabs from "./tabs.js";

/** Entity and field names of the system (AppSpec identifiers). */
const ident = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "имя сущности или поля латиницей");

/** Everything a catalog showcase may show; each variant picks what it renders. */
export const catalogSlots = z.object({
  /** Entity of the showcase (publicFront.actions[].entity of useCatalog; default service). */
  entity: ident.optional(),
  /** Entity of the sections (catalog contract service_category); without it — no section filter. */
  categoryEntity: ident.optional(),
  /** Field names of an item; defaults — the catalog module contract (name, description, price, duration_min, photo). */
  fields: z
    .object({
      title: ident.optional(),
      description: ident.optional(),
      price: ident.optional(),
      duration: ident.optional(),
      photo: ident.optional(),
      category: ident.optional(),
    })
    .optional(),
  title: line(80),
  text: para(260).optional(),
  /** What an empty catalog says, calmly and without invented items. */
  empty: line(120).optional(),
  /** Items per «Показать ещё» (≤ 96 in all, the data API limit). */
  pageSize: z.number().int().min(3).max(48).optional(),
  /** An action on each item: the path gets ?service=<id> (a booking page reads it). */
  itemAction: z
    .object({ label: line(40), path: z.string().regex(SAME_ORIGIN_PATH_RE, "путь страницы системы") })
    .optional(),
  /** One action of the section (catalog K09). */
  action: linkSlot.optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const CATALOG_EXAMPLE = {
  entity: "service",
  categoryEntity: "service_category",
  title: "Занятия и цены",
  text: "Глина, глазурь и обжиг входят в стоимость. Абонемент можно оплатить частями.",
  empty: "Расписание и цены скоро появятся",
  pageSize: 6,
  itemAction: { label: "Записаться", path: "/booking" },
  action: { label: "Задать вопрос", href: "#form" },
} satisfies z.input<typeof catalogSlots>;

const at = import.meta.url;
const base = catalogSlots.pick({
  entity: true,
  fields: true,
  title: true,
  text: true,
  empty: true,
  action: true,
});
const filtered = base.extend({ categoryEntity: catalogSlots.shape.categoryEntity });
/** The variants built on the sections need them. */
const bySections = base.extend({ categoryEntity: ident });
const paged = { pageSize: catalogSlots.shape.pageSize };
const acting = { itemAction: catalogSlots.shape.itemAction };

export const CATALOG_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Grid>()(at, "catalog", {
    variant: "grid",
    layout: "grid",
    title: "Сетка карточек с фото, ценой и длительностью; фильтр по разделам и «Показать ещё»",
    archetypes: ["*"],
    slots: filtered.extend({ ...paged, ...acting }),
    needs: "catalog",
    license: "MIT",
    origin: "hyperui",
    example: CATALOG_EXAMPLE,
  }),
  definePattern<typeof List>()(at, "catalog", {
    variant: "list",
    layout: "list",
    title: "Список строками с квадратным фото: название, описание, цена и действие справа; заголовок слева",
    archetypes: ["*"],
    slots: filtered.extend({ ...paged, ...acting }),
    needs: "catalog",
    license: "MIT",
    origin: "hyperui",
    example: CATALOG_EXAMPLE,
  }),
  definePattern<typeof Sections>()(at, "catalog", {
    variant: "sections",
    layout: "columns",
    title: "Весь каталог по разделам с липкой навигацией слева (на телефоне — строка ссылок сверху)",
    archetypes: ["*"],
    slots: bySections,
    needs: "catalog",
    license: "own",
    origin: "own",
    example: CATALOG_EXAMPLE,
  }),
  definePattern<typeof Featured>()(at, "catalog", {
    variant: "featured",
    layout: "asymmetric",
    title: "Первая позиция крупно с большим фото и ценой, остальные компактным списком справа",
    archetypes: ["*"],
    slots: base.extend({ ...paged, ...acting }),
    needs: "catalog",
    license: "own",
    origin: "own",
    example: CATALOG_EXAMPLE,
  }),
  definePattern<typeof PriceList>()(at, "catalog", {
    variant: "price-list",
    layout: "typographic",
    title: "Типографский прайс без фото: разделы в две колонки, строки «название … цена» с отточием",
    archetypes: ["*"],
    slots: filtered,
    needs: "catalog",
    license: "own",
    origin: "own",
    example: CATALOG_EXAMPLE,
  }),
  definePattern<typeof Tabs>()(at, "catalog", {
    variant: "tabs",
    layout: "panel",
    title: "Разделы вкладками над тонированной панелью, в ней позиции горизонтальными карточками по две",
    archetypes: ["*"],
    slots: bySections.extend({ ...paged, ...acting }),
    needs: "catalog",
    license: "own",
    origin: "own",
    example: CATALOG_EXAMPLE,
  }),
  definePattern<typeof Carousel>()(at, "catalog", {
    variant: "carousel",
    layout: "band",
    title: "Тонированная полоса с лентой карточек, листается пальцем или стрелками, без автопрокрутки",
    archetypes: ["*"],
    slots: base.extend({ ...paged, ...acting }),
    needs: "catalog",
    license: "own",
    origin: "own",
    example: CATALOG_EXAMPLE,
  }),
  definePattern<typeof Table>()(at, "catalog", {
    variant: "table",
    layout: "stacked",
    title: "Таблица: название с описанием, длительность и цена в колонках; фильтр по разделам",
    archetypes: ["*"],
    slots: filtered.extend(paged),
    needs: "catalog",
    license: "MIT",
    origin: "shadcn-ui",
    example: CATALOG_EXAMPLE,
  }),
];
