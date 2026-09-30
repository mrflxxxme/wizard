import type { ClientDoc, Json } from "@wizard/sdk";

type Order = ClientDoc<"cake_order">;
type Tone = "neutral" | "accent" | "ok" | "warn" | "bad";

export const STATUS: Record<Order["status"], { label: string; tone: Tone }> = {
  pending_payment: { label: "Ожидает предоплаты", tone: "warn" },
  prepaid: { label: "Предоплачен", tone: "accent" },
  in_production: { label: "В работе", tone: "accent" },
  ready: { label: "Готов к выдаче", tone: "ok" },
  completed: { label: "Выдан", tone: "neutral" },
  canceled: { label: "Отменён", tone: "bad" },
  refunded: { label: "Возвращён", tone: "bad" },
};

export const FULFILLMENT: Record<Order["fulfillment"], string> = { pickup: "Самовывоз", delivery: "Доставка" };

const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 });
const day = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" });

export const rub = (v: number): string => money.format(v);
/** YYYY-MM-DD → «сб, 11 октября». */
export const dayLabel = (date: string): string => day.format(new Date(`${date}T00:00:00Z`));

/** Снимок опций заказа (placeOrder.options) → «2,5 кг · Вишня–шоколад · Ягоды». */
export function optionsText(options: Json): string {
  if (!Array.isArray(options)) return "";
  return options
    .map((o) => (o && typeof o === "object" && !Array.isArray(o) && typeof o.title === "string" ? o.title : ""))
    .filter(Boolean)
    .join(" · ");
}
