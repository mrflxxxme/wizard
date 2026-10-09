// V3-18: the seller's pages of a shop (ст. 26.1 ЗоЗПП, ПП РФ № 2463) — the offer, delivery and payment, returns — from
// the lawyer's drafts and the spec: the seller's requisites, the delivery methods of the checkout, the online payment.
// Nothing the owner did not give is stated: the times of delivery are «уточняйте у продавца».
import type { AppSpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  DRAFT_MARK,
  defaultLegalTemplates,
  renderShopTerms,
  SHOP_TERMS_PAGES,
  shopTermsKind,
} from "../src/index.js";
import { markdownToHtml } from "../src/privacy/policy.js";

function shopSpec(o: { online: boolean; delivery: string[]; ogrn?: string }): AppSpec {
  return {
    version: 1,
    app: { name: "Лавка", locale: "ru" },
    roles: [
      { name: "owner", label: "Владелец", access: "login", isAdmin: true },
      { name: "guest", label: "Посетитель", access: "public" },
    ],
    entities: [
      {
        name: "shop_order",
        label: "Заказ",
        fields: [
          { name: "name", label: "Покупатель", type: "string", pii: "basic", piiKind: "fio" },
          {
            name: "delivery",
            label: "Доставка",
            type: "enum",
            enum: o.delivery.map((value) => ({ value, label: value })),
          },
        ],
      },
    ],
    permissions: [],
    ...(o.online
      ? { integrations: [{ name: "shop_pay", connector: "yookassa", config: {}, secretRefs: [] }] }
      : {}),
    compliance: {
      operatorName: "ООО «Лавка»",
      operatorContact: "shop@lavka.example",
      operatorAddress: "г. Москва, ул. Лавочная, д. 1",
      operatorInn: "7707083893",
      ...(o.ogrn ? { operatorOgrn: o.ogrn } : {}),
    },
  } as unknown as AppSpec;
}

describe("the seller's pages of a shop", () => {
  const templates = defaultLegalTemplates();

  test("the offer: the seller's requisites, the payment by ЮKassa, the links to delivery, returns and the policy", () => {
    const spec = shopSpec({ online: true, delivery: ["pickup", "cdek"], ogrn: "1027700132195" });
    const offer = renderShopTerms(spec, templates, "offer");
    expect(offer?.draft).toBe(true);
    expect(offer?.markdown).toContain(DRAFT_MARK);
    expect(offer?.markdown).toContain("Наименование: ООО «Лавка»");
    expect(offer?.markdown).toContain("ИНН: 7707083893");
    expect(offer?.markdown).toContain("ОГРН: 1027700132195");
    expect(offer?.markdown).toContain("Адрес: г. Москва, ул. Лавочная, д. 1");
    expect(offer?.markdown).toContain("ЮKassa");
    expect(offer?.markdown).toContain(SHOP_TERMS_PAGES.delivery);
    expect(offer?.markdown).toContain(SHOP_TERMS_PAGES.returns);
    expect(offer?.markdown).not.toMatch(/\{\{|\[не указано/);
    expect(markdownToHtml(offer?.markdown ?? "")).toContain("<h3>Продавец</h3>");
  });

  test("delivery: only the checkout's methods; times not given by the owner are «уточняйте у продавца»", () => {
    const pickup = renderShopTerms(shopSpec({ online: false, delivery: ["pickup"] }), templates, "delivery");
    expect(pickup?.markdown).toContain("Самовывоз");
    expect(pickup?.markdown).not.toContain("СДЭК");
    expect(pickup?.markdown).not.toContain("Курьер");
    expect(pickup?.markdown).toContain("уточняйте у продавца");
    expect(pickup?.markdown).not.toContain("ЮKassa");
    const all = renderShopTerms(
      shopSpec({ online: true, delivery: ["pickup", "cdek", "courier"] }),
      templates,
      "delivery",
    );
    expect(all?.markdown).toContain("СДЭК");
    expect(all?.markdown).toContain("Курьер магазина");
  });

  test("returns: the consumer's 7 days and 3 months, the 10 days of the refund, the seller's contact", () => {
    const r = renderShopTerms(shopSpec({ online: true, delivery: ["pickup"] }), templates, "returns");
    expect(r?.markdown).toMatch(/7 дней/);
    expect(r?.markdown).toMatch(/3 месяцев/);
    expect(r?.markdown).toMatch(/10 дней/);
    expect(r?.markdown).toContain("shop@lavka.example");
  });

  test("served only for a shop and only when no page of the spec takes the route", () => {
    const spec = shopSpec({ online: true, delivery: ["pickup"] });
    expect(shopTermsKind(spec, "/offer")).toBe("offer");
    expect(shopTermsKind(spec, "/returns/")).toBe("returns");
    expect(shopTermsKind(spec, "/shop")).toBeNull();
    expect(shopTermsKind({ ...spec, entities: [] }, "/offer")).toBeNull();
    expect(
      shopTermsKind(
        { ...spec, pages: [{ route: "/offer", title: "Оферта", file: "ui/pages/O.tsx", roles: [] }] },
        "/offer",
      ),
    ).toBeNull();
  });
});
