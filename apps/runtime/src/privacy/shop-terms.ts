// The seller's pages of «Интернет-магазин» (V3-18; ст. 26.1 Закона «О защите прав потребителей», Правила продажи
// товаров — ПП РФ от 31.12.2020 № 2463): the public offer, delivery and payment, returns. A lawyer's template
// (templates.ts, kind shop) plus facts of the spec: the seller's requisites (compliance), the delivery methods the
// checkout offers (shop_order.delivery) and whether the shop takes payment online (a yookassa integration). Terms the
// owner did not give (delivery times, courier zones) are «уточняйте у продавца»: nothing is invented here.
import type { AppSpec } from "@wizard/appspec";
import { effectivePolicyPage } from "./policy.js";
import { fillTemplate, type LegalTemplates } from "./templates.js";

/** Routes of the seller's pages (@wizard/modules SHOP_TERMS_ROUTES keeps the same values). */
export const SHOP_TERMS_PAGES = { offer: "/offer", delivery: "/delivery", returns: "/returns" } as const;
export type ShopTermsKind = keyof typeof SHOP_TERMS_PAGES;

/** The order entity of «Интернет-магазин» (@wizard/modules SHOP_NAMES.order): its presence makes a system a shop. */
export const SHOP_ORDER_ENTITY = "shop_order";

const NOT_SET = "[не указано продавцом]";
const TITLES: Readonly<Record<ShopTermsKind, string>> = {
  offer: "Публичная оферта",
  delivery: "Доставка и оплата",
  returns: "Возврат товара",
};

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const list = (items: readonly string[]) => items.map((s) => `- ${oneLine(s)}`).join("\n");

/** The seller's page served on `pathname` (not when a page of the spec takes the route), else null. */
export function shopTermsKind(spec: AppSpec, pathname: string): ShopTermsKind | null {
  if (!spec.entities.some((e) => e.name === SHOP_ORDER_ENTITY)) return null;
  const route = pathname.replace(/\/+$/, "") || "/";
  const kind = (Object.keys(SHOP_TERMS_PAGES) as ShopTermsKind[]).find((k) => SHOP_TERMS_PAGES[k] === route);
  if (!kind || (spec.pages ?? []).some((p) => p.route === route)) return null;
  return kind;
}

const DELIVERY_LINES: Readonly<Record<string, string>> = {
  pickup:
    "Самовывоз — бесплатно, из пунктов самовывоза магазина; адреса и часы работы показаны при оформлении заказа.",
  cdek: "Доставка СДЭК до пункта выдачи — стоимость и срок рассчитываются по городу покупателя при оформлении заказа и входят в сумму заказа.",
  courier:
    "Курьер магазина — стоимость показана при оформлении заказа и входит в сумму заказа; зону и время доставки уточняйте у продавца.",
};

/** Facts of the templates from the spec. */
export function shopTermsFacts(spec: AppSpec): Record<string, string> {
  const c = spec.compliance ?? {};
  const order = spec.entities.find((e) => e.name === SHOP_ORDER_ENTITY);
  const methods = (order?.fields.find((f) => f.name === "delivery")?.enum ?? []).map((x) => x.value);
  const online = (spec.integrations ?? []).some((i) => i.connector === "yookassa");
  const contact = oneLine(c.operatorContact ?? NOT_SET);
  const seller = [
    `Наименование: ${c.operatorName ?? NOT_SET}`,
    `ИНН: ${c.operatorInn ?? NOT_SET}`,
    ...(c.operatorOgrn ? [`${c.operatorOgrn.length === 15 ? "ОГРНИП" : "ОГРН"}: ${c.operatorOgrn}`] : []),
    `Адрес: ${c.operatorAddress ?? NOT_SET}`,
    `Контакт для обращений: ${contact}`,
  ];
  const delivery = methods.flatMap((m) => (DELIVERY_LINES[m] ? [DELIVERY_LINES[m] as string] : []));
  const payment = online
    ? [
        "Оплата на сайте сразу после оформления заказа банковской картой или другим способом, доступным на странице оплаты ЮKassa.",
        "Кассовый чек по 54-ФЗ направляется на почту или телефон, указанные в заказе.",
        "Заказ, не оплаченный в отведённое время, отменяется; срок оплаты показан на странице заказа.",
      ]
    : [
        "Способ и срок оплаты продавец согласует с покупателем после оформления заказа — уточняйте у продавца.",
      ];
  const terms = [
    ...(methods.includes("cdek") ? ["Срок доставки СДЭК показывается при выборе пункта выдачи."] : []),
    `Сроки сборки и передачи заказа уточняйте у продавца: ${contact}.`,
  ];
  const refund = online
    ? "Деньги за заказ, оплаченный на сайте, возвращаются тем же способом, которым он был оплачен, через ЮKassa."
    : "Способ возврата денег продавец согласует с покупателем.";
  return {
    appName: oneLine(spec.app.name),
    seller: list(seller),
    contact,
    delivery: list(delivery.length ? delivery : ["Способы получения уточняйте у продавца."]),
    payment: list(payment),
    terms: list(terms),
    refund,
    offerPage: SHOP_TERMS_PAGES.offer,
    deliveryPage: SHOP_TERMS_PAGES.delivery,
    returnsPage: SHOP_TERMS_PAGES.returns,
    policyPage: effectivePolicyPage(spec) ?? "политика оператора",
  };
}

export interface RenderedShopTerms {
  title: string;
  markdown: string;
  draft: boolean;
}

/** The page's markdown from the template `shop:<kind>`; null without the template. */
export function renderShopTerms(
  spec: AppSpec,
  templates: LegalTemplates,
  kind: ShopTermsKind,
): RenderedShopTerms | null {
  const t = templates.get("shop", kind);
  if (!t) return null;
  return {
    title: TITLES[kind],
    markdown: fillTemplate(t.body, shopTermsFacts(spec)),
    draft: t.status === "draft",
  };
}
