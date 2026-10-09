// V3-09 acceptance, agents part: three first screens in three different archetypes with the client's texts (one
// recorded art_direction answer through the fixture router, or the brief), ≤ 40 ₽ by the route stats; refinement by
// words through the lexicon («теплее», «как второй, но строже», «крупнее заголовок», «без фото»…), the model only for a
// phrase the lexicon does not know; logo and references → principles (GZ-03: no texts, logos or layouts copied); the
// pick round-trips through brief.design. No live calls.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SystemBrief, systemBriefSchema } from "@wizard/appspec";
import { createRegistry, createRouter, type RouteInput, type RouteOutput } from "@wizard/llm";
import { fontEntry } from "@wizard/ui-kit/themes";
import {
  ARCHETYPE_IDS,
  archetype,
  cssHex,
  designLintErrors,
  designSystemV3,
  parseOklch,
} from "@wizard/ui-kit/v3/design";
import { patternById } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import { dentalBrief, shopBrief } from "../../appspec/test/brief-fixtures.js";
import {
  ART_DIRECTION_CALL_TYPE,
  briefDesign,
  briefFacts,
  colorsInText,
  DIRECTION_TEXTS_TOOL,
  type DirectionsProposal,
  type DirectionTuning,
  directionDesign,
  directionPreview,
  directionsNiche,
  directionTextsMessages,
  directionTextsSchema,
  dominantColors,
  factsText,
  fallbackTexts,
  inventedFacts,
  isDirectionsProposal,
  logoPrinciples,
  pagePrinciples,
  parseRefinement,
  pickedDesign,
  proposalDesigns,
  proposeDirections,
  REFINE_HINT,
  REFINEMENT_TOOL,
  RubWallet,
  referenceHints,
  referenceLine,
  refineDirections,
  refinementSchema,
  screenshotPrinciples,
  TUNING_AXES,
  tuneDesign,
  tuningWords,
  wordsLine,
} from "../src/builder/index.js";
import { defineTool } from "../src/core/tool.js";
import { fixtureLine } from "./build-v2-fixtures.js";

const NAME = "Стоматология «Улыбка»";
const REQUEST = "Нужен сайт стоматологии в нашем районе с онлайн-записью";
const NICHE = directionsNiche(NAME, REQUEST);
const BRIEF: SystemBrief = systemBriefSchema.parse({ ...dentalBrief(), design: { references: [] } });
const INPUT = { brief: BRIEF, name: NAME, niche: NICHE, seed: "sys-v309" };
const PATHS = {
  fontBase: "/api/v1/direction-previews/fonts/",
  photoBase: "/api/v1/direction-previews/photos/",
};
const llm = createRegistry({ buildDefaultTier: "T1" });

/** A scripted model: each call gets the next answer (Error — thrown; null — a text answer). */
function scripted(tool: string, answers: (Record<string, unknown> | null | Error)[], credits = 0.2) {
  const calls: RouteInput[] = [];
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    calls.push(input);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)] ?? null;
    if (a instanceof Error) throw a;
    return {
      tier: "T1",
      model: "glm-5.3",
      result: a
        ? { toolCalls: [{ id: `c${calls.length}`, name: tool, args: a }], finishReason: "tool-calls" }
        : { toolCalls: [], text: "Не могу.", finishReason: "stop" },
      usage: { inputTokens: 2500, cachedTokens: 0, outputTokens: 400 },
      creditsCharged: credits,
      creditsMilli: credits * 1000,
      routeReason: "default_T1",
      scrubbed: true,
      ruFallback: false,
    } as RouteOutput;
  };
  return { route, calls };
}

const TEXTS = [
  {
    title: "Стоматология «Улыбка»: запись на приём с сайта",
    lead: "Выберите услугу и удобное время — подтверждение придёт в Telegram. Для жителей района и семей с детьми.",
    action: "Записаться",
  },
  {
    title: "Приём у стоматолога рядом с домом",
    lead: "Записывайтесь вечером с телефона: услуга, время и подтверждение в Telegram без звонков.",
    action: "Выбрать время",
  },
  {
    title: "Запись к стоматологу без звонков",
    lead: "Услуга, время, подтверждение в Telegram — всё на сайте, когда вам удобно.",
    action: "Записаться онлайн",
  },
];

async function baseline(): Promise<DirectionsProposal> {
  return proposeDirections(INPUT);
}

describe("three directions by code", () => {
  test("three different archetypes, header and hero spread, lint-clean designs, texts from the brief; deterministic", async () => {
    const t0 = performance.now();
    const p = await baseline();
    const ms = performance.now() - t0;
    expect(await proposeDirections(INPUT)).toEqual(p);
    expect(isDirectionsProposal(p)).toBe(true);
    expect(p.directions).toHaveLength(3);
    expect(new Set(p.directions.map((d) => d.archetype)).size).toBe(3);
    expect(new Set(p.directions.map((d) => d.hero)).size).toBe(3);
    expect(new Set(p.directions.map((d) => d.header)).size).toBe(3);
    // Spread layouts: no two first screens share a layout family.
    expect(new Set(p.directions.map((d) => patternById(d.hero)?.layout)).size).toBe(3);
    for (const ds of proposalDesigns(p)) expect(designLintErrors(ds)).toEqual([]);
    expect(p.fallback).toBe(true);
    expect(p.costRub).toBe(0);
    expect(p.notes.join(" ")).toContain("модель не подключена");
    const facts = factsText(briefFacts(BRIEF, NAME, NICHE));
    for (const d of p.directions) {
      expect(d.textsSource).toBe("brief");
      expect(d.texts.title).toContain("Улыбка");
      for (const t of [d.texts.title, d.texts.lead ?? "", d.texts.action])
        expect(inventedFacts(t, facts, "t").filter((i) => i.code !== "RUSSIAN" || t)).toEqual([]);
    }
    expect(p.directions.map((d) => d.texts.action)).toEqual([
      "Записаться",
      "Выбрать время",
      "Записаться онлайн",
    ]);
    expect(p.nav.map((x) => x.label)).toEqual(["Услуги", "О нас", "Контакты"]);
    expect(ms).toBeLessThan(2000);
  });

  test("the owner's archetype from the brief comes first; another seed or niche may change the rest", async () => {
    const p = await proposeDirections({
      ...INPUT,
      brief: { ...BRIEF, design: { archetype: "luxury", references: [] } },
    });
    expect(p.directions[0]?.archetype).toBe("luxury");
    const q = await proposeDirections({
      ...INPUT,
      recent: (await baseline()).directions.map((d) => d.archetype),
    });
    expect(q.directions.map((d) => d.archetype)).not.toEqual(
      (await baseline()).directions.map((d) => d.archetype),
    );
  });

  test("preview systems: header + hero patterns with the client's texts, design.css with self-hosted fonts", async () => {
    const p = await baseline();
    const t0 = performance.now();
    for (const [i, d] of p.directions.entries()) {
      const ds = proposalDesigns(p)[i] as ReturnType<typeof designSystemV3>;
      const sys = directionPreview(
        { ...d, design: ds },
        { name: p.name, nav: p.nav, texts: d.texts, photos: d.tuning.photos !== false },
        PATHS,
      );
      expect([...sys.files.keys()].sort()).toEqual(
        [
          "ui/design.css",
          `ui/patterns/${d.header}.tsx`,
          `ui/patterns/${d.hero}.tsx`,
          "ui/pages/Preview.tsx",
        ].sort(),
      );
      const page = sys.files.get("ui/pages/Preview.tsx") as string;
      expect(page).toContain(JSON.stringify(d.texts.title).slice(1, -1));
      expect(page).toContain('"href":"#form"');
      expect(page).not.toMatch(/https?:\/\//);
      expect(sys.files.get("ui/design.css")).toContain("url(/api/v1/direction-previews/fonts/");
      expect(sys.spec.pages?.map((x) => x.route)).toEqual(["/", "/srcdoc"]);
    }
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("texts: one model call for three voices", () => {
  test("recorded answer through the fixture router: texts of the model, scrubbed, ≤ 40 ₽ by the route stats", async () => {
    const p = await baseline();
    const ids = p.directions.map((d) => d.archetype);
    const facts = briefFacts(BRIEF, NAME, NICHE);
    const tool = defineTool({
      name: DIRECTION_TEXTS_TOOL,
      description: "texts",
      input: directionTextsSchema(ids),
    });
    const messages = directionTextsMessages(
      facts,
      p.directions.map((d) => ({ archetype: d.archetype, voice: d.voice })),
    );
    const answer = { sets: ids.map((direction, i) => ({ direction, ...TEXTS[i] })) };
    const dir = mkdtempSync(join(tmpdir(), "wz-dir-"));
    mkdirSync(join(dir, "unit"), { recursive: true });
    const line = fixtureLine(ART_DIRECTION_CALL_TYPE, messages, [tool.definition], {
      name: DIRECTION_TEXTS_TOOL,
      args: answer,
    });
    writeFileSync(join(dir, "unit", "directions.jsonl"), `${JSON.stringify(line)}\n`);
    const router = createRouter({
      mode: "fixture",
      fixture: { suite: "unit", name: "directions", dir },
      registry: llm,
      sink: { write: async () => {} },
      env: {},
    });
    const scrubbed: boolean[] = [];
    const route = async (input: RouteInput) => {
      const out = await router.route({
        ...input,
        orgPolicy: { ruOnly: false, t1Restricted: false },
      } as RouteInput);
      scrubbed.push(out.scrubbed);
      return out;
    };
    const t0 = performance.now();
    const r = await proposeDirections(INPUT, { route, ctx: { orgId: "org" } });
    const ms = performance.now() - t0;
    expect(r.fallback).toBe(false);
    expect(r.directions.map((d) => d.texts)).toEqual(TEXTS);
    expect(r.directions.every((d) => d.textsSource === "model")).toBe(true);
    // Code, not the model, decided everything else.
    expect(r.directions.map((d) => [d.archetype, d.header, d.hero])).toEqual(
      p.directions.map((d) => [d.archetype, d.header, d.hero]),
    );
    expect(scrubbed).toEqual([true]);
    expect(r.calls).toBe(1);
    expect(r.costRub).toBeGreaterThan(0);
    expect(r.costRub).toBeLessThanOrEqual(40);
    expect(ms).toBeLessThan(120_000);
    console.info(
      `V3-09 три направления на записанном ответе: ${r.costRub.toFixed(2)} ₽, ${Math.round(ms)} мс без сборки`,
    );
  });

  test("invented facts go back to the model (D49); personal data never reaches it", async () => {
    const brief = systemBriefSchema.parse({
      ...dentalBrief(),
      audience: "Семьи района; звонить Ивану по +7 912 345-67-89 или ivan.petrov@example.ru",
      design: { references: [] },
    });
    const ids = (await proposeDirections({ ...INPUT, brief })).directions.map((d) => d.archetype);
    const bad = {
      sets: ids.map((direction, i) => ({
        direction,
        ...TEXTS[i],
        title: i === 0 ? "Лучшая стоматология района — 20 лет опыта" : (TEXTS[i]?.title as string),
      })),
    };
    const good = { sets: ids.map((direction, i) => ({ direction, ...TEXTS[i] })) };
    const { route, calls } = scripted(DIRECTION_TEXTS_TOOL, [bad, good]);
    const r = await proposeDirections({ ...INPUT, brief }, { route });
    expect(calls).toHaveLength(2);
    const repair = JSON.stringify(calls[1]?.messages);
    expect(repair).toContain("NO_FACTS");
    expect(repair).toContain("NO_CLAIMS");
    expect(r.directions[0]?.texts.title).toBe(TEXTS[0]?.title);
    const sent = JSON.stringify(calls.map((c) => c.messages));
    expect(sent).not.toContain("345-67-89");
    expect(sent).not.toContain("ivan.petrov@example.ru");
    expect(r.costRub).toBeCloseTo(2 * 0.2 * 5, 5);
  });

  test("no money, a refusal, an error or the deadline → texts from the brief; an abort of the caller is not swallowed", async () => {
    const det = await baseline();
    const poor = await proposeDirections(INPUT, {
      route: scripted(DIRECTION_TEXTS_TOOL, [null]).route,
      wallet: new RubWallet(40, 5, 37),
    });
    expect(poor.fallback).toBe(true);
    expect(poor.calls).toBe(0);
    expect(poor.notes.join(" ")).toContain("бюджет");
    const refusal = await proposeDirections(INPUT, { route: scripted(DIRECTION_TEXTS_TOOL, [null]).route });
    expect(refusal.directions.map((d) => d.texts)).toEqual(det.directions.map((d) => d.texts));
    expect(refusal.calls).toBe(3);
    const error = await proposeDirections(INPUT, {
      route: scripted(DIRECTION_TEXTS_TOOL, [new Error("провайдер недоступен")]).route,
    });
    expect(error.notes.join(" ")).toContain("провайдер недоступен");
    const hang = async (input: RouteInput): Promise<RouteOutput> =>
      new Promise((_, reject) => {
        if (input.signal?.aborted) reject(new Error("aborted"));
        input.signal?.addEventListener("abort", () => reject(new Error("timeout")));
      });
    const t0 = performance.now();
    const late = await proposeDirections(INPUT, { route: hang, deadlineMs: 50 });
    expect(late.fallback).toBe(true);
    expect(performance.now() - t0).toBeLessThan(2000);
    const ctl = new AbortController();
    ctl.abort();
    await expect(proposeDirections(INPUT, { route: hang, signal: ctl.signal })).rejects.toThrow();
  });
});

describe("refinement by words", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["Теплее", { tuning: { warmth: 1 }, target: null, pick: null }],
    ["строже", { tuning: { contrast: 1, radius: -1, motion: -1 }, target: null }],
    ["как второй, но строже", { tuning: { contrast: 1, radius: -1, motion: -1 }, target: 2, pick: null }],
    ["крупнее заголовок", { tuning: { scale: 1 } }],
    ["без фото", { tuning: { photos: false } }],
    ["у первого без фото и теплее", { tuning: { photos: false, warmth: 1 }, target: 1 }],
    ["не так строго", { tuning: { contrast: -1, radius: 1, motion: 1 } }],
    ["намного теплее", { tuning: { warmth: 2 } }],
    ["тёмный фон, просторнее", { tuning: { scheme: "dark", density: 1 } }],
    ["поярче и без анимации", { tuning: { saturation: 1, motion: -2 } }],
    ["беру второй", { tuning: {}, pick: 2 }],
    ["третий", { tuning: {}, pick: 3 }],
    ["сделайте с котиками", { tuning: {}, pick: null, unknown: ["котиками"] }],
  ];
  test.each(cases)("«%s»", (text, expected) => {
    expect(parseRefinement(text)).toMatchObject(expected);
  });

  test("«теплее» moves every direction warmer by code; «как второй, но строже» only the second", async () => {
    const p = await baseline();
    const warm = await refineDirections(p, "теплее");
    expect(warm.kind).toBe("tuned");
    expect(warm.source).toBe("lexicon");
    expect(warm.changed).toEqual([1, 2, 3]);
    expect(warm.reply).toMatch(/теплее/);
    const before = proposalDesigns(p);
    const after = proposalDesigns(warm.proposal);
    for (const [i, ds] of after.entries()) {
      expect(designLintErrors(ds)).toEqual([]);
      // Neutrals take the warm hue (a near-grey's hue is only approximate after quantization).
      const bg = parseOklch(ds.palette.light.bg)?.h as number;
      expect(bg).toBeGreaterThan(40);
      expect(bg).toBeLessThan(110);
      expect(ds).not.toEqual(before[i]);
    }
    const strict = await refineDirections(p, "как второй, но строже");
    expect(strict.changed).toEqual([2]);
    expect(strict.proposal.directions[0]).toEqual(p.directions[0]);
    expect(strict.proposal.directions[2]).toEqual(p.directions[2]);
    const d2 = strict.proposal.directions[1];
    expect(d2?.tuning.contrast).toBe(1);
  });

  test("«без фото» switches the first screens to compositions without a photo; «беру третий» is a pick", async () => {
    const p = await baseline();
    const r = await refineDirections(p, "без фото");
    for (const d of r.proposal.directions) {
      expect(["hero-typographic", "hero-centered"]).toContain(d.hero);
      const sys = directionPreview(
        { ...d, design: directionDesign(r.proposal, d).design },
        { name: p.name, nav: p.nav, texts: d.texts, photos: false },
        PATHS,
      );
      expect(sys.files.get("ui/pages/Preview.tsx")).not.toContain("/photos/");
    }
    const pick = await refineDirections(p, "беру третий");
    expect(pick).toMatchObject({ kind: "pick", pick: 3, changed: [] });
    expect(pick.reply).toContain(p.directions[2]?.name);
  });

  test("«крупнее заголовок»: the headline grows within 72 px or the owner is told it is at its limit", async () => {
    const p = await baseline();
    const r = await refineDirections(p, "крупнее заголовок");
    const before = proposalDesigns(p);
    const after = proposalDesigns(r.proposal);
    for (const [i, ds] of after.entries()) {
      const a = ds.type.steps.display;
      const b = (before[i] as typeof ds).type.steps.display;
      expect(a.max).toBeLessThanOrEqual(72);
      if (r.changed.includes(i + 1)) expect(a.max + a.min).toBeGreaterThan(b.max + b.min);
      else expect(r.reply).toContain("самого крупного размера");
    }
    expect(r.changed.length).toBeGreaterThan(0);
  });

  test("a phrase the lexicon does not know goes to the model (one call); without a model — the hint", async () => {
    const p = await baseline();
    const none = await refineDirections(p, "сделайте как у Apple");
    expect(none).toMatchObject({ kind: "unknown", reply: REFINE_HINT, source: "none" });
    const answer = {
      understood: true,
      target: 0,
      pick: 0,
      tuning: { contrast: 1, saturation: -1 },
      reply: "Сделаю строже и спокойнее по цвету, без лишних деталей.",
    };
    expect(refinementSchema.safeParse(answer).success).toBe(true);
    const { route, calls } = scripted(REFINEMENT_TOOL, [answer]);
    const r = await refineDirections(p, "сделайте как у Apple", { route });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.callType).toBe("art_direction");
    expect(r).toMatchObject({ kind: "tuned", source: "model", reply: answer.reply });
    expect(r.proposal.costRub).toBeCloseTo(1, 5);
    expect(r.proposal.directions.every((d) => d.tuning.contrast === 1)).toBe(true);
    // The lexicon understands «теплее» itself: no model call.
    const lex = scripted(REFINEMENT_TOOL, [answer]);
    await refineDirections(p, "теплее", { route: lex.route });
    expect(lex.calls).toHaveLength(0);
    // Out of money (the proposal already spent 38 ₽): the hint without a call.
    const poor = scripted(REFINEMENT_TOOL, [answer]);
    const r2 = await refineDirections({ ...p, costRub: 38 }, "сделайте как у Apple", { route: poor.route });
    expect(poor.calls).toHaveLength(0);
    expect(r2.reply).toBe(REFINE_HINT);
  });
});

describe("tuning keeps the design system valid", () => {
  test("every archetype × every axis ±2, scheme and photos: designLint clean (a step that would break it is skipped)", () => {
    for (const id of ARCHETYPE_IDS)
      for (const brandColor of [undefined, "#B5541B"]) {
        for (const axis of TUNING_AXES)
          for (const v of [-2, -1, 1, 2]) {
            const t = tuneDesign(
              { archetype: id, seed: 3, niche: "проверка", ...(brandColor ? { brandColor } : {}) },
              { [axis]: v },
            );
            expect(designLintErrors(t.design), `${id} ${axis} ${v}`).toEqual([]);
            if (brandColor) expect(cssHex(t.design.palette.light.accent)).toBe(brandColor);
          }
        const dark = tuneDesign({ archetype: id, seed: 3, niche: "проверка" }, { scheme: "dark" });
        expect(dark.design.palette.scheme).toBe("dark");
        expect(designLintErrors(dark.design)).toEqual([]);
      }
  });

  test("no tuning = designSystemV3; warmth without a brand colour moves the accent hue toward warm", () => {
    const base = designSystemV3({ archetype: "calm_medical", seed: 1, niche: "клиника" });
    expect(tuneDesign({ archetype: "calm_medical", seed: 1, niche: "клиника" }, {}).design).toEqual(base);
    const warm = tuneDesign({ archetype: "calm_medical", seed: 1, niche: "клиника" }, { warmth: 2 }).design;
    const h0 = parseOklch(base.palette.light.accent)?.h as number;
    const h1 = parseOklch(warm.palette.light.accent)?.h as number;
    const dist = (h: number) => Math.min(Math.abs(h - 45), 360 - Math.abs(h - 45));
    expect(dist(h1)).toBeLessThan(dist(h0));
  });
});

/** RGBA of a w×h image: background colour, a block of `fg` covering `share` of the area, transparent border. */
function image(
  w: number,
  h: number,
  bg: [number, number, number, number],
  fg: [number, number, number],
  share: number,
) {
  const px = new Uint8Array(w * h * 4);
  const fgRows = Math.round(h * share);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = y < fgRows ? [...fg, 255] : bg;
      px.set(c, i);
    }
  return px;
}

describe("logo and references → principles (GZ-03)", () => {
  test("a logo on white: its orange is the brand colour; transparent pixels are ignored", () => {
    const colors = dominantColors(image(200, 120, [255, 255, 255, 255], [0xb5, 0x54, 0x1b], 0.3), 200, 120);
    expect(colors[0]?.hex).toBe("#FFFFFF");
    const p = logoPrinciples(colors);
    expect(p.brandColor).toMatch(/^#B[0-9A-F]5[0-9A-F]1[0-9A-F]$/);
    expect(p.warmth).toBe(1);
    const transparent = dominantColors(image(50, 50, [0, 0, 0, 0], [0x2f, 0x7f, 0xb8], 0.5), 50, 50);
    expect(transparent).toHaveLength(1);
    expect(
      logoPrinciples(dominantColors(image(40, 40, [255, 255, 255, 255], [20, 20, 20], 0.4), 40, 40))
        .brandColor,
    ).toBe(undefined);
    const svg = colorsInText(
      '<svg><path fill="#1F6FEB" d="M0 0"/><circle fill="#1f6feb"/><rect fill="#fff"/></svg>',
    );
    expect(logoPrinciples(svg).brandColor).toBe("#1F6FEB");
  });

  test("a dark, dense screenshot: dark scheme, dense rhythm, contrast; the line holds principles only", () => {
    // A busy dark page: the dark background is the largest colour but holds only a third of the screen.
    const px = image(300, 200, [18, 20, 26, 255], [235, 235, 230], 0.22);
    px.set(image(300, 44, [0, 0, 0, 0], [194, 65, 12], 1), 300 * 44 * 4);
    px.set(image(300, 44, [0, 0, 0, 0], [40, 90, 160], 1), 300 * 88 * 4);
    const shot = screenshotPrinciples(dominantColors(px, 300, 200));
    expect(shot).toMatchObject({ kind: "screenshot", scheme: "dark", density: -1, contrast: 1 });
    const line = referenceLine(shot, "Скриншот 1");
    expect(line).toMatch(/^Скриншот 1: .*тёмный фон.*ритм плотный.*Принципы, без копирования/);
    expect(line.length).toBeLessThanOrEqual(500);
  });

  test("a page: inline CSS colours and fonts, grid, photos and rhythm — no text, logo or layout of the page kept", () => {
    const html = `<!doctype html><html><head><title>Кофейня «Секретный рецепт» — лучший кофе</title>
      <meta name="theme-color" content="#7A3E1D">
      <style>h1,h2{font-family:"Playfair Display",serif;color:#2B1D14} body{font-family:Inter,sans-serif;background:#FBF6EF}
      .grid{display:grid;grid-template-columns:repeat(12,1fr)} .btn{background:#C2410C;color:#fff}</style></head>
      <body><img src="/logo.svg" alt="Логотип Секретный рецепт"><h1>Секретный рецепт счастья</h1></body></html>`;
    const md = [
      "# Секретный рецепт счастья",
      "![Зал](https://example.ru/a.jpg)",
      "Короткий абзац про зерно.",
      "## Меню",
      "![Капучино](https://example.ru/b.jpg)",
      "Ещё один короткий абзац.",
      "## Контакты",
      "![Бариста](https://example.ru/c.jpg)",
      "Адрес и часы.",
    ].join("\n\n");
    const p = pagePrinciples(html, md);
    expect(p).toMatchObject({ kind: "page", type: "contrast", grid: 12, photos: true, warmth: 1 });
    const line = referenceLine(p, "Сайт example.ru");
    expect(line).toContain("антиква в заголовках, гротеск в тексте");
    expect(line).toContain("сетка 12 колонок");
    for (const copied of ["Секретный рецепт", "лучший кофе", "Капучино", "Бариста", "Меню", "logo.svg"])
      expect(line).not.toContain(copied);
  });

  test("principles round-trip through brief.design.references into the directions (logo colour, serif, words)", async () => {
    const refs = [
      referenceLine(logoPrinciples(colorsInText('<svg fill="#0B6E4F"/>')), "Логотип"),
      "Сайт example.ru: цвета #7A3E1D, #FBF6EF; палитра тёплая; шрифты: антиква в заголовках, гротеск в тексте; ритм просторный. Принципы, без копирования текстов, логотипов и раскладки.",
      wordsLine(["без фото", "крупнее заголовок"]),
    ];
    const hints = referenceHints(refs);
    expect(hints).toMatchObject({ brandColor: "#0B6E4F", type: "contrast", used: 3 });
    expect(hints.tuning).toMatchObject({ warmth: 1, density: 1, photos: false, scale: 1 });
    const p = await proposeDirections({ ...INPUT, brief: { ...BRIEF, design: { references: refs } } });
    expect(p.brandColor).toBe("#0B6E4F");
    for (const ds of proposalDesigns(p)) expect(cssHex(ds.palette.light.accent)).toBe("#0B6E4F");
    expect(p.directions.every((d) => ["hero-typographic", "hero-centered"].includes(d.hero))).toBe(true);
    expect(
      p.directions.some((d) =>
        (archetype(d.archetype)?.fontPairs ?? []).every((f) => fontEntry(f.display)?.category === "serif"),
      ),
    ).toBe(true);
    // Skipping the step: no references, no pick — the system chooses.
    expect(referenceHints([])).toEqual({ tuning: {}, used: 0 });
  });

  test("the pick is reproducible from the brief: archetype + references give the same design system", async () => {
    const p = await baseline();
    const r = await refineDirections(p, "как второй, но теплее");
    const d = r.proposal.directions[1] as DirectionsProposal["directions"][number];
    const brief = {
      ...BRIEF,
      design: { archetype: d.archetype, pinned: true, references: [wordsLine(["теплее"])] },
    };
    const fromBrief = briefDesign(brief, { seed: p.seed, niche: p.niche });
    expect(fromBrief?.design).toEqual(directionDesign(r.proposal, d).design);
    expect(briefDesign(BRIEF, { seed: p.seed, niche: p.niche })).toBeNull();
    expect(pickedDesign(BRIEF.design, r.proposal, 2)).toEqual(brief.design);
  });

  test("with references too: pickedDesign keeps them and adds only the owner's own words; briefDesign = what was shown", async () => {
    const refs = [
      referenceLine(logoPrinciples(colorsInText('<svg fill="#0B6E4F"/>')), "Логотип"),
      "Сайт example.ru: цвета #7A3E1D; палитра тёплая; ритм просторный. Принципы, без копирования текстов, логотипов и раскладки.",
      wordsLine(["без фото"]),
    ];
    const brief = { ...BRIEF, design: { references: refs } };
    const p = await proposeDirections({ ...INPUT, brief });
    let q = p;
    for (const words of [
      "как второй, но строже",
      "у второго намного холоднее",
      "у второго с фото",
      "тёмный фон",
    ])
      q = (await refineDirections(q, words)).proposal;
    for (const n of [1, 2, 3]) {
      const design = pickedDesign(brief.design, q, n);
      expect(design.references.slice(0, 2)).toEqual(refs.slice(0, 2));
      expect(design.references.filter((x) => x.startsWith("Пожелания словами:")).length).toBeLessThanOrEqual(
        1,
      );
      const shown = directionDesign(
        q,
        q.directions[n - 1] as DirectionsProposal["directions"][number],
      ).design;
      expect(briefDesign({ ...brief, design }, { seed: q.seed, niche: q.niche })?.design).toEqual(shown);
    }
    const skip = pickedDesign(brief.design, q, null);
    expect(skip).toEqual({
      archetype: q.directions[0]?.archetype,
      pinned: false,
      references: refs.slice(0, 2),
    });
  });

  test("the words of a tuning read back as the same tuning (every axis, both signs, photos and scheme)", () => {
    const all: DirectionTuning[] = [
      ...TUNING_AXES.flatMap((axis) => [-2, -1, 1, 2].map((v) => ({ [axis]: v }))),
      { photos: false },
      { photos: true },
      { scheme: "dark" },
      { scheme: "light" },
      {
        warmth: -2,
        contrast: 1,
        saturation: -1,
        density: 2,
        scale: -1,
        radius: 1,
        motion: -2,
        photos: true,
        scheme: "dark",
      },
    ];
    for (const t of all)
      expect(parseRefinement(tuningWords(t).join("; ")).tuning, JSON.stringify(t)).toEqual(t);
  });

  test("fallback texts on another niche: a shop gets a catalog button and its own name", async () => {
    const brief = systemBriefSchema.parse(shopBrief());
    const facts = briefFacts(brief, "Чайная лавка", directionsNiche("Чайная лавка", "Интернет-магазин чая"));
    const t = fallbackTexts(facts, 0);
    expect(t).toMatchObject({ title: expect.stringContaining("Чайная лавка"), action: "Перейти в каталог" });
    expect(inventedFacts(`${t.title} ${t.lead ?? ""}`, factsText(facts), "t")).toEqual([]);
  });
});
