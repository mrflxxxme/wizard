// Cart patterns (V3-23 «Интернет-магазин», needs cart): the cart of this browser and the checkout over useCheckout
// (@wizard/ui-kit/v3/headless, C4) — the delivery methods of the module (self-pickup, СДЭК by the city, the courier),
// the buyer's contacts with the consent (G2-PII-04), the order by the module's function and the way to its payment.
// DOM contract of the goal scenarios GS-shop-*: ShopCart with wz-cart-line, ShopCheckout with wz-field-*, wz-cdek-find,
// wz-consent and wz-checkout-submit (builder-v3.md C3).
import { z } from "zod";
import { definePattern } from "../define.js";
import { line, linkSlot, SAME_ORIGIN_PATH_RE } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Split from "./split.js";
import type Stacked from "./stacked.js";

/** Entity and function names of the system (AppSpec identifiers). */
const ident = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "имя сущности латиницей");
const fnName = z.string().regex(/^[a-z][A-Za-z0-9_]{0,63}$/, "имя функции модуля");

/** The module's checkout: publicFront.actions[].shop of the backend compile (ShopFrontConfig without the showcase). */
export const checkoutSlot = z.object({
  methods: z
    .array(z.object({ value: z.enum(["pickup", "cdek", "courier"]), label: line(60) }))
    .min(1)
    .max(3),
  online: z.boolean(),
  courierPrice: z.number().min(0).max(100_000).optional(),
  pointEntity: ident.optional(),
  placeFn: fnName.optional(),
  cdekFn: fnName.optional(),
  payment: z.object({ integration: ident, binding: ident }).optional(),
  orderPath: z.string().regex(SAME_ORIGIN_PATH_RE, "путь страницы заказа").optional(),
  /** V3-18: a separate box «Согласен получать письма о заказе» (the shop sends the buyer letters about his order). */
  consentMessages: z.boolean().optional(),
});

/** V3-18: the seller's pages (ст. 26.1 ЗоЗПП): the offer the order accepts, delivery and payment, returns. */
export const termsSlot = z.object({
  offer: linkSlot,
  delivery: linkSlot.optional(),
  returns: linkSlot.optional(),
});

export const cartSlots = z.object({
  title: line(80),
  /** 1 — the heading of the page (/cart), 2 — a section under the first screen (default). */
  level: z.union([z.literal(1), z.literal(2)]).optional(),
  checkout: checkoutSlot,
  /** Back to the goods. */
  back: linkSlot.optional(),
  /** What an empty cart says. */
  empty: line(120).optional(),
  /** A line of the shop under the sums (returns, delivery terms) from the brief. */
  note: line(200).optional(),
  /** The seller's pages: «Оформляя заказ, вы принимаете условия оферты» by the action, the other terms beside. */
  terms: termsSlot.optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const CART_EXAMPLE = {
  title: "Корзина",
  level: 2,
  checkout: {
    methods: [
      { value: "pickup", label: "Самовывоз" },
      { value: "cdek", label: "СДЭК, пункт выдачи" },
    ],
    online: true,
    pointEntity: "pickup_point",
    placeFn: "shopPlaceOrder",
    cdekFn: "shopCdekOptions",
    payment: { integration: "shop_pay", binding: "order" },
    orderPath: "/order/",
  },
  back: { label: "Вернуться к товарам", href: "/shop" },
  empty: "В корзине пока ничего нет",
  terms: {
    offer: { label: "Публичная оферта", href: "/offer" },
    delivery: { label: "Доставка и оплата", href: "/delivery" },
    returns: { label: "Возврат товара", href: "/returns" },
  },
} satisfies z.input<typeof cartSlots>;

const at = import.meta.url;

export const CART_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Split>()(at, "cart", {
    variant: "split",
    layout: "split",
    title:
      "Корзина и оформление на одной странице: строки корзины слева, справа карточка — доставка, контакты, итог",
    archetypes: ["*"],
    slots: cartSlots,
    needs: "cart",
    license: "own",
    origin: "own",
    example: CART_EXAMPLE,
  }),
  definePattern<typeof Stacked>()(at, "cart", {
    variant: "stacked",
    layout: "stacked",
    title:
      "Корзина и оформление одной узкой колонкой: сначала строки корзины и сумма, под ними карточка — доставка, контакты, итог",
    archetypes: ["*"],
    slots: cartSlots,
    needs: "cart",
    license: "own",
    origin: "own",
    example: CART_EXAMPLE,
  }),
];
