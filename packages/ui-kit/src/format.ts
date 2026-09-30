// ru-RU formatting (ui-kit.yaml#rules: Intl, RUB, browser time zone, Intl.PluralRules('ru')).
const money = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const moneyCompact = new Intl.NumberFormat("ru-RU", {
  notation: "compact",
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 1,
});
const int = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const num = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
const percent = new Intl.NumberFormat("ru-RU", { style: "percent", maximumFractionDigits: 1 });
const plural = new Intl.PluralRules("ru");

export const formatMoney = (v: number): string => money.format(v);
export const formatMoneyCompact = (v: number): string => moneyCompact.format(v);
export const formatInt = (v: number): string => int.format(v);
export const formatNumber = (v: number): string => num.format(v);
/** `v` is a fraction (0.62 → «62 %»). */
export const formatPercent = (v: number): string => percent.format(v);
export const formatDelta = (v: number): string => `${v >= 0 ? "+" : "−"}${money.format(Math.abs(v))}`;

export type PluralForms = { one: string; few: string; many: string; other: string };
export function pluralRu(n: number, forms: PluralForms): string {
  return forms[plural.select(n) as keyof PluralForms] ?? forms.other;
}

/** 'YYYY-MM-DD' → «14.11.2026» (a date without time zone shift). */
export function formatDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("ru-RU");
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("ru-RU");
}

/** ISO UTC → local «14.11.2026, 09:30». */
export function formatDateTime(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }).replace(/\s+/g, " ");
}

export function formatTime(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** +79001234510 → «+7 ••• ••• 45 10» (AppShell user menu). */
export function maskPhone(v: string): string {
  const d = v.replace(/\D/g, "");
  if (d.length < 4) return v;
  return `+${d.slice(0, d.length - 10) || "7"} ••• ••• ${d.slice(-4, -2)} ${d.slice(-2)}`;
}

/** Any input → E.164 +7XXXXXXXXXX when it is a Russian number, else digits with «+». */
export function toE164(v: string): string {
  let d = v.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("8")) d = `7${d.slice(1)}`;
  if (d.length === 10) d = `7${d}`;
  return d ? `+${d}` : "";
}

/** National 10 digits of a Russian number typed in any form ("+7 (900…", "8900…", "900…"). */
export function phoneDigits(v: string): string {
  let d = v.replace(/\D/g, "");
  if (d.length > 10 && (d.startsWith("7") || d.startsWith("8"))) d = d.slice(1);
  else if (d.length <= 10 && v.trim().startsWith("+7")) d = d.slice(1);
  return d.slice(0, 10);
}

/** Mask «+7 (900) 123-45-10» for the typed value. */
export function formatPhoneInput(v: string): string {
  const p = phoneDigits(v);
  if (!p) return "";
  let out = `+7 (${p.slice(0, 3)}`;
  if (p.length >= 3) out += ")";
  if (p.length > 3) out += ` ${p.slice(3, 6)}`;
  if (p.length > 6) out += `-${p.slice(6, 8)}`;
  if (p.length > 8) out += `-${p.slice(8, 10)}`;
  return out;
}
