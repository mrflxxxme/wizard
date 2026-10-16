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

describe("round 2 first screens (grill-11, «Круг 2»)", async () => {
  const { BOX14, TEREKHOV } = await import("../src/v3/bar/heroes/data.js");
  const bakery = await import("../src/v3/bar/heroes/bakery.js");
  const service = await import("../src/v3/bar/heroes/service.js");
  const screens = [
    bakery.BakeryMorning,
    bakery.BakeryClock,
    bakery.BakerySign,
    service.ServiceBooking,
    service.ServiceChat,
    service.ServicePlate,
  ];

  test("copy keeps clear of the bans, each screen has a rating and an offer with a price", () => {
    for (const s of [...strings(TEREKHOV), ...strings(BOX14)]) {
      expect(s).not.toMatch(/\s—\s/);
      expect(s).not.toMatch(/\bне\s[^,.]+,\s*а\s/i);
      expect(s).not.toMatch(/мы заботимся|с любовью|качественн/i);
    }
    for (const Screen of screens) {
      const html = renderToStaticMarkup(createElement(Screen, { photos }));
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).toContain("/ Pexels");
      expect(html).toMatch(/4,[89]/);
      expect(html).toMatch(/\d\s₽/u);
      expect(html).toContain("<svg");
    }
  });

  test("the booking prices the chosen model", () => {
    const html = renderToStaticMarkup(createElement(service.ServiceBooking, { photos }));
    expect(html).toContain(rub(7800));
    expect(html).toContain("Записаться на 15:30");
  });
});
