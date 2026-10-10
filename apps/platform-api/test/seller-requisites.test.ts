// V3-18 (ст. 26.1 ЗоЗПП, ПП РФ № 2463): a shop is published only with the seller's requisites of its offer — name,
// ИНН and address; ОГРН / ОГРНИП, when given, passes its check digit. Russian texts of the blockers.
import type { AppSpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { ogrnValid } from "../src/auth/region.js";
import { BLOCKER_RU, SHOP_ORDER_ENTITY, specPublishBlockers } from "../src/publish/blockers.js";

const shop = (compliance: AppSpec["compliance"]): AppSpec =>
  ({
    version: 1,
    app: { name: "Лавка", locale: "ru" },
    roles: [{ name: "owner", label: "Владелец", access: "login", isAdmin: true }],
    entities: [
      {
        name: SHOP_ORDER_ENTITY,
        label: "Заказ",
        fields: [{ name: "name", label: "Покупатель", type: "string", pii: "basic", piiKind: "fio" }],
      },
    ],
    permissions: [],
    compliance,
  }) as unknown as AppSpec;

const FULL = {
  operatorName: "ООО «Лавка»",
  operatorContact: "privacy@lavka.example",
  operatorAddress: "г. Москва, ул. Лавочная, д. 1",
  operatorInn: "7707083893",
};

describe("seller's requisites of a shop", () => {
  test("name, ИНН and address are required; ОГРН is optional but checked", () => {
    expect(specPublishBlockers(shop(FULL), "pilot")).toEqual([]);
    const { operatorInn: _inn, ...noInn } = FULL;
    expect(specPublishBlockers(shop(noInn), "pilot")).toContain("SELLER_REQUISITES_REQUIRED");
    expect(specPublishBlockers(shop({ ...FULL, operatorOgrn: "1027700132195" }), "pilot")).toEqual([]);
    expect(specPublishBlockers(shop({ ...FULL, operatorOgrn: "1027700132196" }), "pilot")).toContain(
      "OGRN_INVALID",
    );
    // Not a shop: no seller's requisites asked.
    const notShop = shop({ ...noInn });
    notShop.entities = [{ ...(notShop.entities[0] as AppSpec["entities"][number]), name: "lead" }];
    expect(specPublishBlockers(notShop, "pilot")).not.toContain("SELLER_REQUISITES_REQUIRED");
    expect(BLOCKER_RU.SELLER_REQUISITES_REQUIRED).toMatch(/реквизиты продавца.*ИНН и адрес/);
    expect(BLOCKER_RU.OGRN_INVALID).toMatch(/ОГРН/);
  });

  test("ОГРН (13) and ОГРНИП (15) check digits", () => {
    expect(ogrnValid("1027700132195")).toBe(true);
    expect(ogrnValid("1027700132194")).toBe(false);
    expect(ogrnValid("304500116000157")).toBe(true);
    expect(ogrnValid("304500116000158")).toBe(false);
    expect(ogrnValid("12345")).toBe(false);
  });
});
