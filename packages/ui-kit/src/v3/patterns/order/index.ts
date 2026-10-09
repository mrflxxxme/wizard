// Order patterns (V3-23 «Интернет-магазин», needs cart): the page of one order for its buyer over useOrder
// (@wizard/ui-kit/v3/headless, C4) — the order of the address by the buyer's secret kept in this browser, its status,
// goods, delivery and sums, and its payment while it waits for one. DOM contract of the goal scenarios GS-shop-*:
// ShopOrder with wz-order-number, wz-order-status and wz-order-pay (builder-v3.md C3).
import { z } from "zod";
import { definePattern } from "../define.js";
import { linkSlot, SAME_ORIGIN_PATH_RE } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Summary from "./summary.js";

/** Entity names of the system (AppSpec identifiers). */
const ident = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "имя латиницей");

export const orderSlots = z.object({
  /** 1 — the heading of the page (/order/:id), 2 — a section under another heading (default). */
  level: z.union([z.literal(1), z.literal(2)]).optional(),
  /** Address prefix of the order pages («/order/»). */
  path: z.string().regex(SAME_ORIGIN_PATH_RE, "путь страницы заказа").optional(),
  /** The module's payment; absent — the shop takes no online payment. */
  payment: z.object({ integration: ident, binding: ident }).optional(),
  /** Back to the goods. */
  back: linkSlot.optional(),
  /** A direct channel to the shop. */
  contact: linkSlot.optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const ORDER_EXAMPLE = {
  level: 2,
  path: "/order/",
  payment: { integration: "shop_pay", binding: "order" },
  back: { label: "Вернуться к товарам", href: "/shop" },
  contact: { label: "+7 900 000-00-00", href: "tel:+79000000000" },
} satisfies z.input<typeof orderSlots>;

const at = import.meta.url;

export const ORDER_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Summary>()(at, "order", {
    variant: "summary",
    layout: "card",
    title:
      "Заказ покупателя карточкой-чеком: номер и статус, состав и суммы, получение, «Оплатить» до оплаты",
    archetypes: ["*"],
    slots: orderSlots,
    needs: "cart",
    license: "own",
    origin: "own",
    example: ORDER_EXAMPLE,
  }),
];
