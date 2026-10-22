// V5-01 and V5-09 block catalog: machine-readable specs, both accepted bar sites assembled from catalog blocks with content that
// fits the slots, contrast AA, a still final frame without hydration, the bans of grill-11 (8), a snapshot per block.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  AI_PHRASES,
  aiTextErrors,
  BLOCKS,
  blockContrastPairs,
  blocksOf,
  contentErrors,
  contentStrings,
  DIRECTIONS,
  MASTERSKAYA_DS,
  paletteBanErrors,
  stillFrame,
  templateMarkupErrors,
} from "../src/index.js";
import { BakeryLoaf, bakeryBlocks } from "../src/v3/bar/heroes/bakery.js";
import { BureauSite, bureauBlocks } from "../src/v3/bar/heroes/bureau.js";
import { ClinicSite, clinicBlocks } from "../src/v3/bar/heroes/clinic.js";
import { ServiceAsk, serviceBlocks } from "../src/v3/bar/heroes/service.js";
import { BAR_PHOTOS, type PhotoSlot } from "../src/v3/bar/photos.js";
import type { Photo } from "../src/v3/bar/still.js";
import { designLintErrors, oklchCss } from "../src/v3/design/index.js";
import type { DirectionId } from "../src/v4/blocks/types.js";

const photos = Object.fromEntries(
  Object.entries(BAR_PHOTOS).map(([slot, p]) => [
    slot,
    { src: `/${p.file}`, alt: p.alt, credit: `${p.author} / Pexels` },
  ]),
) as Record<PhotoSlot, Photo>;
const pages = {
  masterskaya: bakeryBlocks(photos),
  "nochnoy-produkt": serviceBlocks(photos),
  "chistaya-medicina": clinicBlocks(photos),
  redaktsiya: bureauBlocks(photos),
} as const;
const dirs = Object.keys(DIRECTIONS) as DirectionId[];
const html = (id: string, content: unknown) =>
  renderToStaticMarkup(
    createElement(BLOCKS.find((b) => b.spec.id === id)?.Component as never, { content } as never),
  );
const shots = join(import.meta.dirname, "../../../docs/prototypes/blocks");

describe("catalog specs", () => {
  test("ids are unique, `<direction>.<name>`, each with slots, variants and tokens", () => {
    const ids = BLOCKS.map((b) => b.spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { spec } of BLOCKS) {
      expect(spec.id.startsWith(`${spec.direction}.`)).toBe(true);
      expect(Object.keys(spec.slots).length).toBeGreaterThan(0);
      expect(spec.variants.length).toBeGreaterThan(0);
      expect(spec.tokens.length).toBeGreaterThan(0);
      expect(spec.use.length).toBeGreaterThan(20);
    }
  });

  test("one signature moment per direction, on the block the direction names", () => {
    for (const d of dirs) {
      const sig = blocksOf(d).filter((b) => b.spec.signature);
      expect(sig.map((b) => b.spec.id)).toEqual([DIRECTIONS[d].signature.block]);
      expect(sig[0]?.spec.motion).toBe("signature");
      expect(blocksOf(d).filter((b) => b.spec.motion === "signature")).toHaveLength(1);
    }
  });

  test("contentErrors catches a missing slot, a long text and a list out of range", () => {
    const content = (pages.masterskaya.find((b) => b.id === "masterskaya.reviews")?.content ?? {}) as Record<
      string,
      unknown
    >;
    expect(contentErrors("masterskaya.reviews", content)).toEqual([]);
    expect(contentErrors("masterskaya.reviews", { ...content, title: "О".repeat(40) })).toEqual([
      "title: 40 знаков, предел 16",
    ]);
    expect(contentErrors("masterskaya.reviews", { ...content, items: [] })[0]).toMatch(/0 элементов/);
    expect(contentErrors("masterskaya.reviews", { ...content, rating: undefined })).toEqual([
      "rating: нет значения",
    ]);
  });
});

describe("the accepted sites are assembled from the catalog (grill-11, round 4)", () => {
  test("every section of both pages is a catalog block of its direction with content that fits the slots", () => {
    for (const d of dirs) {
      const ids = pages[d].map((b) => b.id);
      for (const b of pages[d]) {
        expect(b.id.startsWith(`${d}.`)).toBe(true);
        expect(contentErrors(b.id, b.content)).toEqual([]);
      }
      // Each block of the direction is used by its accepted site; the header sits inside the hero.
      const used = new Set([...ids, `${d}.header`]);
      expect(
        blocksOf(d)
          .map((b) => b.spec.id)
          .filter((id) => !used.has(id)),
      ).toEqual([]);
    }
  });

  test("the pages render with one h1, the brand mark, prices and photo credits", () => {
    for (const Site of [BakeryLoaf, ServiceAsk, ClinicSite, BureauSite]) {
      const out = renderToStaticMarkup(createElement(Site, { photos }));
      expect(out.match(/<h1/g)).toHaveLength(1);
      expect(out).toContain("<svg");
      expect(out).toMatch(/\d ₽/u);
      expect(out).toContain("/ Pexels");
    }
  });

  test("each block has snapshots at 390 and 1440 px", () => {
    for (const { spec } of BLOCKS)
      for (const w of [390, 1440]) expect(existsSync(join(shots, `${spec.id}-${w}.jpg`)), spec.id).toBe(true);
  });
});

describe("contrast AA (D80 (4))", () => {
  test("design lint has no errors and every text pair the blocks paint is ≥ 4.5", () => {
    for (const d of dirs) {
      expect(designLintErrors(DIRECTIONS[d].design)).toEqual([]);
      for (const p of blockContrastPairs(DIRECTIONS[d].design))
        expect(p.ratio, `${d}: ${p.pair}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("static fallback on 390 px and with prefers-reduced-motion", () => {
  test("motion plays only on a wide screen without reduced motion", () => {
    expect(stillFrame({ reducedMotion: false, wide: true })).toBe(false);
    expect(stillFrame({ reducedMotion: true, wide: true })).toBe(true);
    expect(stillFrame({ reducedMotion: false, wide: false })).toBe(true);
    expect(stillFrame({ reducedMotion: true, wide: false })).toBe(true);
  });

  test("before hydration every block renders its final frame: nothing hidden or shifted", () => {
    for (const d of dirs)
      for (const b of pages[d]) {
        const out = html(b.id, b.content);
        expect(out, b.id).not.toMatch(/opacity:\s*0[;"]/);
        expect(out, b.id).not.toMatch(/translateY\((100%|16px)\)/);
      }
    const status = pages["nochnoy-produkt"].find((b) => b.id === "nochnoy-produkt.status");
    expect(html("nochnoy-produkt.status", status?.content).match(/border-l-4/g)).toHaveLength(4);
  });
});

describe("bans of grill-11 (8)", () => {
  test("no template first screen, icon squares or three feature cards in any block", () => {
    for (const d of dirs)
      for (const b of pages[d]) expect(templateMarkupErrors(html(b.id, b.content)), b.id).toEqual([]);
    const template = `<section class="text-center"><span class="rounded-full bg-accent-soft px-3">Новое</span>
<h1>Заголовок</h1><p>Абзац</p><a class="bg-primary">Начать</a><a class="border-primary">Подробнее</a></section>
<div class="rounded-lg bg-accent p-2"><svg></svg></div>`;
    expect(templateMarkupErrors(template)).toEqual([
      "первый экран по центру с двумя кнопками",
      "плашка-надзаголовок",
      "иконка в цветном квадрате",
    ]);
  });

  test("palettes are an explicit brand choice, none of the AI palettes", () => {
    for (const d of dirs)
      expect(paletteBanErrors(DIRECTIONS[d].design, DIRECTIONS[d].brandChoice)).toEqual([]);
    const ds = MASTERSKAYA_DS;
    const why = "причина выбора бренда записана здесь подробно и с цветом";
    const recolor = (scheme: "light" | "dark", roles: Record<string, string>) => ({
      ...ds,
      palette: {
        ...ds.palette,
        scheme,
        [scheme]: {
          ...ds.palette[scheme],
          ...Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, oklchCss(v)])),
        },
      },
    });
    const cream = recolor("light", { bg: "#F3E9D9", accent: "#B85A35" });
    expect(
      paletteBanErrors(
        { ...cream, fonts: { ...ds.fonts, display: { ...ds.fonts.display, family: "Lora" } } },
        why,
      ),
    ).toEqual(["крем, засечки и терракота"]);
    expect(paletteBanErrors(recolor("light", { accent: "#7B4DFF", accent2: "#4B5CFF" }), why)).toEqual([
      "фиолетово-синяя пара для градиента",
    ]);
    expect(paletteBanErrors(recolor("dark", { bg: "#0D0E0F", accent: "#B8FF2E" }), why)).toEqual([
      "чёрный с кислотным акцентом",
    ]);
    expect(paletteBanErrors(ds, "")).toEqual(["нет явного выбора бренда: цвет и шрифты без причины"]);
  });

  // AI phrases the anti-AI editor must catch (grill-11 (8)): triples of adjectives, «не X, а Y», care slogans,
  // dash asides, promises without numbers.
  const AI_SAMPLES = [
    "Свежий, ароматный и вкусный хлеб каждый день",
    "Это не просто пекарня, а место встреч",
    "Мы заботимся о каждом клиенте",
    "Хлеб — это наша страсть",
    "Индивидуальный подход к каждой машине",
    "Команда профессионалов с многолетним опытом",
    "Широкий спектр услуг по доступным ценам",
    "Ремонт в кратчайшие сроки",
    "Высокое качество и уникальный вкус",
    "Погрузитесь в атмосферу уюта",
    "Откройте для себя новый вкус",
    "Испечено с любовью",
  ];

  test("every AI phrase sample is caught, the copy of both sites is clean", () => {
    expect(AI_PHRASES.length).toBeGreaterThanOrEqual(10);
    for (const s of AI_SAMPLES) expect(aiTextErrors(s), s).not.toEqual([]);
    for (const d of dirs)
      for (const b of pages[d])
        for (const s of contentStrings(b.content)) expect(aiTextErrors(s), `${b.id}: ${s}`).toEqual([]);
    for (const d of dirs) {
      const { grammar, brandChoice, signature } = DIRECTIONS[d];
      for (const s of [grammar, brandChoice, signature.moment]) expect(aiTextErrors(s), s).toEqual([]);
    }
  });
});
