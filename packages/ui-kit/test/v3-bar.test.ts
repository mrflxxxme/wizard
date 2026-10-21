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

describe("round 4 sites from the chosen first screens (grill-11, П5 and С5)", async () => {
  const { BOX14, TEREKHOV } = await import("../src/v3/bar/heroes/data.js");
  const bakery = await import("../src/v3/bar/heroes/bakery.js");
  const service = await import("../src/v3/bar/heroes/service.js");
  const sites = [bakery.BakeryLoaf, service.ServiceAsk];
  const render = (Site: (typeof sites)[number]) => renderToStaticMarkup(createElement(Site, { photos }));

  test("copy keeps clear of the bans, each site has one h1, a rating, prices, a mark and credits", () => {
    for (const s of [...strings(TEREKHOV), ...strings(BOX14)]) {
      expect(s).not.toMatch(/\s—\s/);
      expect(s).not.toMatch(/\bне\s[^,.]+,\s*а\s/i);
      expect(s).not.toMatch(/мы заботимся|с любовью|качественн/i);
    }
    for (const Site of sites) {
      const html = render(Site);
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).toContain("/ Pexels");
      expect(html).toMatch(/4,[89]/);
      expect(html).toMatch(/\d\s₽/u);
      expect(html).toContain("<svg");
      expect(html).not.toMatch(/rounded-(card|lg|xl|2xl)/);
    }
  });

  test("the bakery site covers sorts and prices, pre-order, shops and hours, reviews", () => {
    const html = render(bakery.BakeryLoaf);
    expect(html).toContain("36 часов брожения");
    expect(html).toContain("Заказать к утру");
    for (const id of ["sorts", "order", "points", "reviews"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain(rub(310));
    expect(html).toContain("Оформить предзаказ");
    expect(html).toContain("Большая Покровская, 12");
    expect(html).toContain("8:00–21:00");
    expect(html.match(/<blockquote/g)).toHaveLength(TEREKHOV.reviews.length);
  });

  test("the service site covers the quote, prices «от», booking, repair status with photos, reviews and address", () => {
    const html = render(service.ServiceAsk);
    expect(html).toContain("Kia K5 2021, стучит спереди справа");
    expect(html).toContain("9 400");
    for (const id of ["prices", "book", "status", "contacts"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain(`от ${rub(7800)}`);
    expect(html).toContain("Записаться на 15:30");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Чат с мастером");
    expect(html).toContain("Монтажников, 4");
    expect(html.match(/<blockquote/g)).toHaveLength(BOX14.reviews.length);
  });
});
