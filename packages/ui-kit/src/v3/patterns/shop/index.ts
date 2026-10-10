// Shop patterns (V3-23 «Интернет-магазин», needs cart): the goods on sale with «В корзину» over useShopCatalog
// (@wizard/ui-kit/v3/headless, C4): what the visitor may see in the owner's order, the stock, the section filter, the
// cart of this browser and the way to it. Names, prices, photos and stock come only from the data; level 1 makes the
// section the heading of its page (/shop). DOM contract of the goal scenarios GS-shop-*: ShopProducts, wz-product
// [data-wz-product], wz-cart-add, wz-cart-link (builder-v3.md C3).
import { z } from "zod";
import { definePattern } from "../define.js";
import { line, linkSlot, para, SAME_ORIGIN_PATH_RE } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Grid from "./grid.js";
import type List from "./list.js";

/** Entity and field names of the system (AppSpec identifiers). */
const ident = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "имя сущности или поля латиницей");

export const shopSlots = z.object({
  /** Entity of the goods (publicFront.actions[].entity of useShop; default product). */
  entity: ident.optional(),
  /** Entity of the shop's sections for the filter (absent — no filter). */
  categoryEntity: ident.optional(),
  /** Field names of a product (default: the module contract); stock null — the shop keeps no stock. */
  fields: z
    .object({
      name: ident.optional(),
      price: ident.optional(),
      description: ident.optional(),
      photo: ident.optional(),
      category: ident.optional(),
      stock: ident.nullable().optional(),
    })
    .optional(),
  title: line(80),
  text: para(260).optional(),
  /** 1 — the heading of the page (/shop), 2 — a section under the first screen (default). */
  level: z.union([z.literal(1), z.literal(2)]).optional(),
  /** What an empty shop says, calmly and without invented goods. */
  empty: line(120).optional(),
  /** Goods per «Показать ещё». */
  pageSize: z.number().int().min(3).max(48).optional(),
  /** The cart page. */
  cart: linkSlot,
  /** V3-18: the product pages — a card's name and photo lead to `path` + the product's id («/shop/»). */
  product: z.object({ path: z.string().regex(SAME_ORIGIN_PATH_RE, "путь страницы товара") }).optional(),
  /** V3-18: a preview on home — nothing while the shop is empty, no filter, no «Показать ещё». */
  preview: z.boolean().optional(),
  /** The way to all the goods from a preview. */
  all: linkSlot.optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const SHOP_EXAMPLE = {
  entity: "product",
  categoryEntity: "product_category",
  title: "Посуда мастерской",
  text: "Кружки, тарелки и вазы ручной работы. Каждая вещь — в одном или нескольких экземплярах.",
  level: 2,
  empty: "Товары скоро появятся",
  pageSize: 8,
  cart: { label: "Корзина", href: "/cart" },
  product: { path: "/shop/" },
} satisfies z.input<typeof shopSlots>;

const at = import.meta.url;

export const SHOP_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Grid>()(at, "shop", {
    variant: "grid",
    layout: "grid",
    title:
      "Витрина карточками: фото, название, цена, остаток и «В корзину»; фильтр по разделам, корзина внизу экрана",
    archetypes: ["*"],
    slots: shopSlots,
    needs: "cart",
    license: "own",
    origin: "own",
    example: SHOP_EXAMPLE,
  }),
  definePattern<typeof List>()(at, "shop", {
    variant: "list",
    layout: "list",
    title:
      "Витрина строками: фото слева, цена и «В корзину» справа; заголовок, разделы и корзина в колонке сбоку",
    archetypes: ["*"],
    slots: shopSlots,
    needs: "cart",
    license: "own",
    origin: "own",
    example: SHOP_EXAMPLE,
  }),
];
