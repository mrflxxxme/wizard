// Product patterns (V3-18 «Интернет-магазин», needs cart): the page of one product by the id of the address
// (/shop/<id>) over useProduct (@wizard/ui-kit/v3/headless, C4) — what the role may see (a visitor: goods on sale
// only), the name as the h1 of the page, the photo, the whole description, the price, the stock and «В корзину», the
// way back to the goods and to the cart. Names, prices, photos and stock come only from the data. DOM contract of the
// goal scenarios GS-shop-*: ShopProduct, wz-product [data-wz-product], wz-cart-add, wz-cart-link (builder-v3.md C3).
import { z } from "zod";
import { definePattern } from "../define.js";
import { line, linkSlot, SAME_ORIGIN_PATH_RE } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Detail from "./detail.js";

/** Entity and field names of the system (AppSpec identifiers). */
const ident = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "имя сущности или поля латиницей");

export const productSlots = z.object({
  /** Entity of the goods (publicFront.actions[].entity of useShop; default product). */
  entity: ident.optional(),
  /** Address prefix of the product pages: the product's id is the next segment («/shop/»). */
  path: z.string().regex(SAME_ORIGIN_PATH_RE, "путь страницы товара"),
  /** Field names of a product (default: the module contract); stock null — the shop keeps no stock. */
  fields: z
    .object({
      name: ident.optional(),
      price: ident.optional(),
      description: ident.optional(),
      photo: ident.optional(),
      stock: ident.nullable().optional(),
    })
    .optional(),
  /** The cart page. */
  cart: linkSlot,
  /** Back to the goods. */
  back: linkSlot.optional(),
  /** What a missing product says (off sale, removed or a wrong address). */
  missing: line(160).optional(),
  /** A fixed product instead of the id of the address (previews). */
  id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const PRODUCT_EXAMPLE = {
  entity: "product",
  path: "/shop/",
  cart: { label: "Корзина", href: "/cart" },
  back: { label: "Все товары", href: "/shop" },
  missing: "Возможно, товар сняли с продажи или адрес набран с ошибкой.",
} satisfies z.input<typeof productSlots>;

const at = import.meta.url;

export const PRODUCT_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Detail>()(at, "product", {
    variant: "detail",
    layout: "split",
    title:
      "Страница товара: большое фото слева, справа название, цена, остаток, «В корзину» и полное описание",
    archetypes: ["*"],
    slots: productSlots,
    needs: "cart",
    license: "own",
    origin: "own",
    example: PRODUCT_EXAMPLE,
  }),
];
