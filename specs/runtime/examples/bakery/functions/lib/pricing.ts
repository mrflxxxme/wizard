import type { Doc, Id, QueryCtx } from "@wizard/sdk";

type Option = Doc<"product_option">;
export type OptionGroup = Option["option_group"];

/** Порядок групп в чеке; вес и начинка — ровно по одной, декор — сколько угодно. */
export const GROUPS: readonly OptionGroup[] = ["weight", "filling", "decor"];
const REQUIRED: Readonly<Record<OptionGroup, string | null>> = {
  weight: "Выберите вес",
  filling: "Выберите начинку",
  decor: null,
};

export type PriceLine = { id: Id<"product_option">; group: OptionGroup; title: string; price: number };

export interface Quote {
  lines: PriceLine[];
  /** Группы, в которых не выбран обязательный вариант; оформить заказ можно только при пустом списке. */
  missing: OptionGroup[];
  total: number;
  /** Предоплата 50%; нечётная копейка — в предоплату. */
  prepay: number;
  remaining: number;
}

const toKop = (rub: number) => Math.round(rub * 100);

/**
 * Цена считается только здесь (ui-kit.yaml#ItemCard: итог — от сервера). Опции читаются через ctx.db,
 * то есть с правами вызывающего: витрина открыта посетителю, скрытых полей у опций нет.
 */
export async function quote(
  ctx: Pick<QueryCtx, "db" | "error">,
  productId: Id<"product">,
  optionIds: readonly Id<"product_option">[],
): Promise<Quote> {
  const product = await ctx.db.product.get(productId);
  if (!product || product.active === false) {
    throw ctx.error("NOT_FOUND", { message: "Изделие не найдено или снято с продажи" });
  }
  const wanted = new Set(optionIds);
  if (wanted.size !== optionIds.length) throw ctx.error("OPTION_INVALID", { message: "Опция выбрана дважды" });

  const available = await ctx.db.product_option.list({ where: { product: productId }, limit: 1000 });
  const picked = available.filter((o) => wanted.has(o.id) && o.active !== false);
  if (picked.length !== wanted.size) {
    throw ctx.error("OPTION_INVALID", { message: "Одна из опций недоступна для этого изделия" });
  }

  const missing: OptionGroup[] = [];
  for (const group of GROUPS) {
    const n = picked.filter((o) => o.option_group === group).length;
    if (n > 1 && REQUIRED[group]) throw ctx.error("OPTION_INVALID", { message: `${REQUIRED[group]}: только один вариант` });
    if (n === 0 && REQUIRED[group]) missing.push(group);
  }

  const rank = (o: Option) => GROUPS.indexOf(o.option_group) * 1e6 + (o.sort_order ?? 0);
  const lines = picked
    .sort((a, b) => rank(a) - rank(b))
    .map((o) => ({ id: o.id, group: o.option_group, title: o.title, price: o.price }));
  const totalKop = lines.reduce((s, l) => s + toKop(l.price), 0);
  const prepayKop = Math.ceil(totalKop / 2);
  return {
    lines,
    missing,
    total: totalKop / 100,
    prepay: prepayKop / 100,
    remaining: (totalKop - prepayKop) / 100,
  };
}

/** Текст первой ошибки выбора для ctx.error. */
export function missingMessage(missing: readonly OptionGroup[]): string {
  return missing.map((g) => REQUIRED[g]).find((m) => m) ?? "Выберите опции";
}
