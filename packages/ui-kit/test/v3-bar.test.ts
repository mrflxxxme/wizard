// Bar sites of grill-11: tokens pass the design lint (AA, fonts), every photo is a credited stock copy, the copy
// keeps clear of the bans of grill-11 (8), and both pages render with each section as its own block.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { BAKERY } from "../src/v3/bar/bakery/data.js";
import BakerySite from "../src/v3/bar/bakery/site.js";
import { BAR_PHOTOS, type PhotoSlot } from "../src/v3/bar/photos.js";
import { SERVICE } from "../src/v3/bar/service/data.js";
import ServiceSite from "../src/v3/bar/service/site.js";
import { type Photo, rub } from "../src/v3/bar/still.js";
import { BAKERY_DS, SERVICE_DS } from "../src/v3/bar/tokens.js";
import { designLintErrors } from "../src/v3/design/index.js";

const photos = Object.fromEntries(
  Object.entries(BAR_PHOTOS).map(([slot, p]) => [
    slot,
    { src: `/${p.file}`, alt: p.alt, credit: `${p.author} / Pexels` },
  ]),
) as Record<PhotoSlot, Photo>;

const strings = (v: unknown): string[] =>
  typeof v === "string"
    ? [v]
    : Array.isArray(v) || (v && typeof v === "object")
      ? Object.values(v).flatMap(strings)
      : [];

describe("bar sites (grill-11)", () => {
  test("tokens pass the design lint, banned palettes avoided", () => {
    expect(designLintErrors(BAKERY_DS)).toEqual([]);
    expect(designLintErrors(SERVICE_DS)).toEqual([]);
    expect(BAKERY_DS.fonts.display.family).not.toBe("Cormorant Garamond");
    expect([BAKERY_DS.palette.brandColor, SERVICE_DS.palette.brandColor]).toEqual(["#2443A6", "#E8A13A"]);
  });

  test("photos are credited Pexels copies", () => {
    for (const p of Object.values(BAR_PHOTOS)) {
      expect(p.author.length).toBeGreaterThan(1);
      expect(p.pageUrl).toMatch(/^https:\/\/www\.pexels\.com\/photo\/.+-\d+\/$/);
      expect(p.cdnUrl).toMatch(/^https:\/\/images\.pexels\.com\/photos\/\d+\//);
    }
  });

  test("copy has no dash asides, «не X, а Y» or care slogans", () => {
    for (const s of [...strings(BAKERY), ...strings(SERVICE)]) {
      expect(s).not.toMatch(/\s—\s/);
      expect(s).not.toMatch(/\bне\s[^,.]+,\s*а\s/i);
      expect(s).not.toMatch(/мы заботимся|с любовью|качественн/i);
    }
  });

  test("both pages render, credits in the footer, one h1 each", () => {
    const bakery = renderToStaticMarkup(createElement(BakerySite, { photos, now: "09:40" }));
    const service = renderToStaticMarkup(createElement(ServiceSite, { photos }));
    for (const html of [bakery, service]) {
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).toContain("/ Pexels");
    }
    expect(bakery).toContain("На витрине, 12 буханок");
    expect(bakery).toContain("Будет в 12:30");
    expect(service).toContain("7 800 ₽");
  });
});

describe("round 3 first screens (grill-11, «Круг 3»)", async () => {
  const { BOX14, TEREKHOV } = await import("../src/v3/bar/heroes/data.js");
  const bakery = await import("../src/v3/bar/heroes/bakery.js");
  const service = await import("../src/v3/bar/heroes/service.js");
  const screens = [
    bakery.BakeryShelf,
    bakery.BakeryLoaf,
    bakery.BakeryOrder,
    service.ServicePick,
    service.ServiceAsk,
    service.ServicePlate,
  ];
  const render = (Screen: (typeof screens)[number]) =>
    renderToStaticMarkup(createElement(Screen, { photos }));

  test("copy keeps clear of the bans, each screen has a rating, a price and a mark", () => {
    for (const s of [...strings(TEREKHOV), ...strings(BOX14)]) {
      expect(s).not.toMatch(/\s—\s/);
      expect(s).not.toMatch(/\bне\s[^,.]+,\s*а\s/i);
      expect(s).not.toMatch(/мы заботимся|с любовью|качественн/i);
    }
    for (const Screen of screens) {
      const html = render(Screen);
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).toContain("/ Pexels");
      expect(html).toMatch(/4,[89]/);
      expect(html).toMatch(/\d\s₽/u);
      expect(html).toContain("<svg");
    }
  });

  test("each screen leads with what a visitor does in the niche", () => {
    expect(render(bakery.BakeryShelf)).toContain("Хлеб на закваске. Каждое утро с\u00a07:40");
    expect(render(bakery.BakeryShelf)).toContain("осталось 7 буханок");
    expect(render(bakery.BakeryLoaf)).toContain("36 часов брожения");
    expect(render(bakery.BakeryLoaf)).toContain("Заказать к утру");
    expect(render(bakery.BakeryOrder)).toContain("Куличи к Пасхе");
    expect(render(bakery.BakeryOrder)).toContain("Добавить");
    expect(render(service.ServicePick)).toContain(`Записаться от ${rub(7800)}`);
    expect(render(service.ServiceAsk)).toContain("Kia K5 2021, стучит спереди справа");
    expect(render(service.ServiceAsk)).toContain("9 400");
    expect(render(service.ServicePlate)).toContain("Диагностика подвески 0 ₽");
    expect(render(service.ServicePlate)).toContain("до 31 октября");
  });
});
