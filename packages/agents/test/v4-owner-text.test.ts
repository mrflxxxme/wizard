// V4-09: what the owner reads about the critic — plain words with the right cases and plurals, no routes, anchors,
// keys or check codes (the technical lines stay in CriticReport.details and the staff report V4-04).
import { describe, expect, test } from "vitest";
import type { SiteModel } from "../src/builder/v3/compose/site.js";
import { ownerCriticNotes, ownerEdit, ruPlaces, ruRemarks } from "../src/builder/v3/critic/owner.js";

const site = {
  pages: [
    {
      route: "/",
      title: "Главная",
      nav: "Главная",
      file: "ui/pages/site/Home.tsx",
      sections: [
        { id: "hero", type: "hero" },
        { id: "services", type: "services" },
        { id: "first-visit", type: "signature", file: "ui/sections/first-visit.tsx" },
      ],
    },
    {
      route: "/prices",
      title: "Цены на услуги",
      nav: "Цены",
      file: "ui/pages/site/Prices.tsx",
      sections: [],
    },
  ],
} as unknown as SiteModel;

describe("V4-09: the critic's text for the owner", () => {
  test("each edit as a place on the site, in the genitive", () => {
    const op = (o: Record<string, unknown>) => ownerEdit(site, { op: o as never });
    expect(op({ op: "set_text", route: "/", section: "hero", path: "title", text: "…" })).toBe(
      "заголовок первого экрана главной",
    );
    expect(op({ op: "set_text", route: "/", section: "hero", path: "action.label", text: "…" })).toBe(
      "надпись на кнопке первого экрана главной",
    );
    expect(op({ op: "set_text", route: "/", section: "services", path: "items.1.text", text: "…" })).toBe(
      "текст блока услуг главной",
    );
    expect(op({ op: "swap_variant", route: "/", section: "services", pattern: "services-cards" })).toBe(
      "вид блока услуг главной",
    );
    expect(op({ op: "reorder", route: "/prices", order: ["a", "b"] })).toBe("порядок блоков страницы «Цены»");
    expect(op({ op: "drop_section", route: "/prices", section: "faq" })).toBe(
      "лишний блок страницы «Цены» убран",
    );
    expect(op({ op: "token", token: "display_size", value: "smaller" })).toBe("размер главного заголовка");
    const patch = (file: string) => ownerEdit(site, { patch: { file, find: "abc", replace: "x" } });
    expect(patch("ui/pages/site/Home.tsx")).toBe("вёрстка главной");
    expect(patch("ui/sections/first-visit.tsx")).toBe("вёрстка фирменного блока");
  });

  test("one or two phrases: what was improved (three places at most) and what to check by hand", () => {
    expect(
      ownerCriticNotes({
        edits: ["заголовок первого экрана главной", "вид блока услуг главной"],
        fixes: ["Секция services: другой вариант (L11)", "Второстепенный текст контрастнее (C08)"],
        left: [{ code: "A01", route: "/prices" }],
        site,
      }),
    ).toEqual([
      "Посмотрел сайт глазами дизайнера и улучшил 4 места: заголовок первого экрана главной, вид блока услуг главной, элемент за краем экрана и другое.",
      "Стоит проверить вручную: кнопки мелковаты для пальца на странице «Цены».",
    ]);
    expect(ownerCriticNotes({ edits: [], fixes: [], left: [], site })).toEqual([
      "Посмотрел сайт глазами дизайнера на телефоне и компьютере — править нечего.",
    ]);
    expect(ownerCriticNotes({ edits: ["порядок блоков главной"], fixes: [], left: [], site })[0]).toBe(
      "Посмотрел сайт глазами дизайнера и улучшил 1 место: порядок блоков главной.",
    );
  });

  test("plurals", () => {
    expect([1, 2, 5, 11, 21, 22, 25, 112].map((n) => `${n} ${ruPlaces(n)}`)).toEqual([
      "1 место",
      "2 места",
      "5 мест",
      "11 мест",
      "21 место",
      "22 места",
      "25 мест",
      "112 мест",
    ]);
    expect([1, 3, 7, 14].map((n) => `${n} ${ruRemarks(n)}`)).toEqual([
      "1 замечание",
      "3 замечания",
      "7 замечаний",
      "14 замечаний",
    ]);
  });
});
