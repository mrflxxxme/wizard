// B2-37 acceptance: the design agent's direction is data by the schema, themeLint passes without errors, only ready
// layouts are used, the contrast holds; the ten mvp briefs get different combinations of theme, fonts and layouts
// (diversity metric below); a refusal of the model gives the fallback direction (themeForNiche + the theme's layouts);
// the brand colour and the owner's choices survive. Recorded answers: tools/fixtures/demo/b2/design-<brief>.jsonl
// (regenerate: WIZARD_GEN_FIXTURES=1 pnpm exec vitest run packages/agents/test/design-direction.test.ts). No models.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type PlanSection,
  SECTION_CATALOG,
  type SystemPlan,
  systemPlanSchema,
  THEME_PRESETS,
} from "@wizard/appspec";
import { createRegistry, createRouter, type RouteInput, type RouteOutput } from "@wizard/llm";
import { compilePlan } from "@wizard/modules";
import { THEME_PRESET_LIST, themeForNiche } from "@wizard/ui-kit/themes";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_V2_BUDGETS,
  type DesignDirection,
  type DesignInput,
  designDirection,
  designInputSchema,
  designIssues,
  designLintIssues,
  designMessages,
  directionDistance,
  directionDiversity,
  fallbackDesign,
  mergeDesign,
  polishDirection,
  runDesignStage,
} from "../src/builder/index.js";
import { defineTool } from "../src/core/tool.js";
import {
  applyPlanEdits,
  DEFAULT_REGISTRY,
  finalizePlan,
  planErrors,
  planSketch,
} from "../src/planner/index.js";
import { B2_FIXTURE_DIR, fixtureLine, serializeLines } from "./build-v2-fixtures.js";
import { DESIGN_SCENARIOS, type DesignScenario } from "./design-mvp-scenarios.js";

const GEN = process.env.WIZARD_GEN_FIXTURES === "1";
const reg = DEFAULT_REGISTRY;
const llm = createRegistry({ buildDefaultTier: "T1" });

/** The plan the design stage gets: finalized like the planner does and compiled (manifest versions written in). */
function stagePlan(sc: DesignScenario): SystemPlan {
  const r = compilePlan(finalizePlan(sc.plan, reg), reg);
  if (!r.ok) throw new Error(`${sc.brief}: ${JSON.stringify(r.errors)}`);
  return r.plan;
}

const designLines = (sc: DesignScenario) => {
  const tool = defineTool({ name: "submit_design", description: "design", input: designInputSchema(reg) });
  return [
    fixtureLine("build_design", designMessages(stagePlan(sc), reg), [tool.definition], {
      name: "submit_design",
      args: sc.design,
    }),
  ];
};

const noStep = <T>(_n: string, fn: () => Promise<T>) => fn();

/** The design stage on the recorded answer of a brief (fixture router, suite demo). */
async function recordedStage(sc: DesignScenario, ruOnly = false) {
  const router = createRouter({
    mode: "fixture",
    fixture: { suite: "demo", name: `b2/design-${sc.brief}` },
    registry: llm,
    sink: { write: async () => {} },
    env: {},
  });
  let milli = 0;
  const scrubbed: boolean[] = [];
  const route = async (input: RouteInput) => {
    const out = await router.route({
      ...input,
      orgPolicy: { ruOnly, t1Restricted: false },
      ctx: { orgId: "org" },
    } as RouteInput);
    milli += out.creditsMilli;
    scrubbed.push(out.scrubbed);
    return out;
  };
  const r = await runDesignStage({ route, runStep: noStep, plan: stagePlan(sc), registry: reg });
  return { ...r, rub: (milli / 1000) * llm.rubPerCredit, scrubbed };
}

/** A scripted model: answers submit_design with the given arguments in turn (null — a text answer, no tool call). */
function scripted(answers: (Record<string, unknown> | null)[]) {
  const calls: RouteInput[] = [];
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    calls.push(input);
    const args = answers[Math.min(calls.length - 1, answers.length - 1)] ?? null;
    return {
      tier: "T1",
      model: "glm-5.3",
      result: args
        ? { toolCalls: [{ id: `c${calls.length}`, name: "submit_design", args }], finishReason: "tool-calls" }
        : { toolCalls: [], text: "Не могу подобрать оформление.", finishReason: "stop" },
      usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 200 },
      creditsCharged: 0.06,
      creditsMilli: 60,
      routeReason: "default_T1",
      scrubbed: true,
      ruFallback: false,
    } as RouteOutput;
  };
  return { route, calls };
}

/** Checks every direction must pass: schema, themeLint without errors and contrast, ready layouts, it compiles. */
function expectValidDirection(before: SystemPlan, plan: SystemPlan) {
  expect(systemPlanSchema.safeParse(plan).success).toBe(true);
  expect(designLintIssues(before, plan.design)).toEqual([]);
  for (const s of plan.landing?.sections ?? [])
    expect(SECTION_CATALOG.find((t) => t.type === s.type)?.ready, s.type).toContain(s.variant);
  expect(planErrors(plan, reg)).toEqual([]);
  const built = compilePlan(plan, reg);
  expect(built.ok, JSON.stringify(built.ok ? [] : built.errors)).toBe(true);
  // Direction is data: no CSS in its free texts.
  const free = [...plan.design.direction.mood, plan.design.photoStyle, plan.design.direction.notes ?? ""];
  for (const t of free) expect(t).not.toMatch(/[{};:]|px\b|rgba?\(|var\(--|#[0-9a-f]{3,6}\b/i);
}

const fmt = (d: ReturnType<typeof directionDiversity>) =>
  `уникальных сочетаний ${d.uniqueCombos}/${d.count} (${d.comboShare}), тем ${d.themes}, наборов раскладок ${d.layoutSets}, расстояние min ${d.minDistance} / среднее ${d.meanDistance}`;

describe("B2-37 design direction on the ten mvp briefs", () => {
  test("the scenarios cover the ten mvp briefs of tools/eval/briefs", () => {
    expect(DESIGN_SCENARIOS.map((s) => s.brief)).toEqual(
      Array.from({ length: 10 }, (_, i) =>
        expect.stringMatching(new RegExp(`^mvp-${String(i + 1).padStart(2, "0")}-`)),
      ),
    );
    for (const sc of DESIGN_SCENARIOS)
      expect(() =>
        readFileSync(join(B2_FIXTURE_DIR, `../../../eval/briefs/${sc.brief}.json`), "utf8"),
      ).not.toThrow();
  });

  test.each(DESIGN_SCENARIOS.map((s) => [s.brief, s] as const))(
    "%s: the recorded answer passes the tool check; the direction is valid data",
    (_n, sc) => {
      const plan = stagePlan(sc);
      expect(planErrors(plan, reg)).toEqual([]);
      expect(designIssues(plan, sc.design, reg)).toEqual([]);
      const next = mergeDesign(plan, sc.design, reg);
      expectValidDirection(plan, next);
      expect(next.design.theme).toBe(sc.design.theme);
      expect(next.design.direction.voice).toBe(sc.design.direction.voice);
    },
  );

  test.each(DESIGN_SCENARIOS.map((s) => [s.brief, s] as const))(
    "%s: fixture file is up to date",
    (_n, sc) => {
      const text = serializeLines(designLines(sc));
      const path = join(B2_FIXTURE_DIR, `design-${sc.brief}.jsonl`);
      if (GEN) {
        mkdirSync(B2_FIXTURE_DIR, { recursive: true });
        writeFileSync(path, text);
      }
      expect(readFileSync(path, "utf8")).toBe(text);
    },
  );

  test("the stage on the recorded answers: the merged direction, ≤ 3 ₽ a brief on T1 and «Только РФ»", async () => {
    const costs: number[] = [];
    for (const sc of DESIGN_SCENARIOS) {
      const r = await recordedStage(sc);
      expect(r.fallback, sc.brief).toBe(false);
      expect(r.plan).toEqual(mergeDesign(stagePlan(sc), sc.design, reg));
      expect(r.rub).toBeLessThanOrEqual(DEFAULT_V2_BUDGETS.design);
      // The call goes through the route of build_design with the PII scrub (AGENTS.md: everything to T1 is scrubbed).
      expect(r.scrubbed).toEqual([true]);
      const ru = await recordedStage(sc, true);
      expect(ru.rub).toBeLessThanOrEqual(DEFAULT_V2_BUDGETS.design);
      costs.push(r.rub, ru.rub);
    }
    console.info(`B2-37 этап дизайна на записанных ответах: до ${Math.max(...costs).toFixed(3)} ₽ за бриф`);
  });

  test("diversity: every brief gets its own combination of theme, fonts and layouts", () => {
    const directions = DESIGN_SCENARIOS.map((sc) =>
      designDirection(mergeDesign(stagePlan(sc), sc.design, reg)),
    );
    const d = directionDiversity(directions);
    console.info(`B2-37 разнообразие направлений на 10 брифах mvp: ${fmt(d)}`);
    expect(d.count).toBe(10);
    expect(d.comboShare).toBe(1);
    expect(d.themes).toBeGreaterThanOrEqual(8);
    expect(d.minDistance).toBeGreaterThanOrEqual(0.3);
    expect(d.meanDistance).toBeGreaterThanOrEqual(0.7);
    // Sites of different niches differ in layouts, not only in colour.
    const sites = directions.filter((x) => x.sections.length > 0);
    expect(directionDiversity(sites).layoutSets).toBe(sites.length);
  });

  test("diversity of the fallback (no model): themes by niche, the theme's layouts", () => {
    const directions = DESIGN_SCENARIOS.map((sc) => designDirection(fallbackDesign(stagePlan(sc), reg)));
    const d = directionDiversity(directions);
    console.info(`B2-37 разнообразие запасного пути (без модели): ${fmt(d)}`);
    expect(d.comboShare).toBe(1);
    expect(d.themes).toBeGreaterThanOrEqual(5);
  });

  test("distance: the same direction is 0, a direction of another theme, fonts and layouts is far", () => {
    const [a, b] = DESIGN_SCENARIOS.map((sc) =>
      designDirection(mergeDesign(stagePlan(sc), sc.design, reg)),
    ) as [DesignDirection, DesignDirection];
    expect(directionDistance(a, a)).toBe(0);
    expect(directionDistance(a, b)).toBeGreaterThan(0.5);
  });
});

describe("B2-37 checks, repairs and the fallback", () => {
  const sc = DESIGN_SCENARIOS[0] as DesignScenario;
  const base = () => stagePlan(sc);
  const answer = (over: Partial<DesignInput>): DesignInput => ({ ...sc.design, ...over });

  test("a heading-only face for the text, a pale accent, an unknown layout → tool errors in plain Russian", () => {
    const plan = base();
    const codes = (i: DesignInput) => designIssues(plan, i, reg).map((x) => x.code);
    expect(codes(answer({ fontPair: { heading: "Onest", body: "Unbounded" } }))).toContain(
      "DISPLAY_FONT_AS_BODY",
    );
    expect(codes(answer({ accent: "#F2E3A0" }))).toContain("ACCENT_CONTRAST");
    expect(codes(answer({ accent: "#8A8A8A" }))).toContain("ACCENT_CONTRAST");
    expect(codes(answer({ fontPair: { heading: "Onest", body: "Onest" } }))).toContain("THEME_LINT");
    expect(codes(answer({ sections: [{ index: 1, variant: "carousel" }] }))).toEqual(["UNKNOWN_VARIANT"]);
    expect(codes(answer({ sections: [{ index: 19, variant: "split" }] }))).toEqual(["UNKNOWN_SECTION"]);
    for (const i of designIssues(plan, answer({ accent: "#F2E3A0" }), reg))
      expect(i.message).toMatch(/[а-я]/);
  });

  test("a wrong answer, then the fixed one: the stage takes the fixed direction", async () => {
    const m = scripted([{ ...sc.design, accent: "#F2E3A0" }, sc.design]);
    const r = await runDesignStage({ route: m.route, runStep: noStep, plan: base(), registry: reg });
    expect(r.fallback).toBe(false);
    expect(m.calls).toHaveLength(2);
    expect(r.plan.design.accent).toBe(sc.design.accent);
  });

  test("the model refuses (no tool call, then invalid answers): the fallback direction, not a failure", async () => {
    for (const answers of [[null], [{ ...sc.design, theme: "neon" }]]) {
      const plan = base();
      const m = scripted(answers);
      const r = await runDesignStage({ route: m.route, runStep: noStep, plan, registry: reg });
      expect(r.fallback).toBe(true);
      expect(m.calls).toHaveLength(3);
      expect(r.plan.design.theme).toBe(themeForNiche(plan.niche));
      expect(r.plan.design.direction.voice).toBe("calm");
      expectValidDirection(plan, r.plan);
    }
  });

  test("the fallback keeps the brand colour and the owner's choices", () => {
    const plan = base();
    plan.design = {
      ...plan.design,
      accent: "#E8E2C0",
      direction: { ...plan.design.direction, notes: "Фирменный цвет клиента" },
    };
    const r = fallbackDesign(plan, reg);
    expect(r.design.accent).toBe("#E8E2C0");
    expect(designLintIssues(plan, r.design)).toEqual([]);
  });

  test("every theme preset gives a lint-clean fallback (its fonts and accent pass the checks)", () => {
    expect(THEME_PRESET_LIST.map((p) => p.id).sort()).toEqual([...THEME_PRESETS].sort());
    for (const p of THEME_PRESET_LIST) {
      const plan = base();
      plan.design = { ...plan.design, theme: p.id, pinned: ["theme"] };
      const r = fallbackDesign(plan, reg);
      expect(r.design.theme).toBe(p.id);
      expectValidDirection(plan, r);
    }
  });

  test("the brand colour is never changed by the agent's answer, even a pale one", () => {
    const plan = base();
    plan.design = {
      ...plan.design,
      accent: "#F0D8E0",
      direction: { ...plan.design.direction, notes: "Фирменный цвет клиента" },
    };
    expect(designIssues(plan, sc.design, reg)).toEqual([]);
    const next = mergeDesign(plan, sc.design, reg);
    expect(next.design.accent).toBe("#F0D8E0");
    expect(next.design.direction.notes).toBe("Фирменный цвет клиента");
  });

  test("owner's edits (theme, fonts, a section layout) are pinned and survive the design stage", () => {
    const r = applyPlanEdits(
      base(),
      [
        { op: "set_design", theme: "poster", fontPair: { heading: "Alumni Sans", body: "Literata" } },
        { op: "update_section", index: 1, variant: "collage" },
      ],
      reg,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const plan = r.plan;
    expect(plan.design.pinned).toEqual(["theme", "fontPair"]);
    expect(plan.landing?.sections[1]?.pinned).toBe(true);
    const next = mergeDesign(plan, answer({ sections: [{ index: 1, variant: "split" }] }), reg);
    expect(next.design.theme).toBe("poster");
    expect(next.design.fontPair).toEqual({ heading: "Alumni Sans", body: "Literata" });
    expect(next.landing?.sections[1]?.variant).toBe("collage");
    expect(next.design.accent).toBe(sc.design.accent);
    const prompt = designMessages(plan, reg)
      .map((m) => m.content)
      .join("\n");
    expect(prompt).toContain("закреплено владельцем");
    expect(fallbackDesign(plan, reg).design.theme).toBe("poster");
  });

  test("polish: bands only on body sections, no two neighbours with the same layout", () => {
    const plan = base();
    if (!plan.landing) throw new Error("landing");
    plan.landing.sections[0] = { ...(plan.landing.sections[0] as PlanSection), band: "alt" };
    plan.landing.sections.splice(3, 0, {
      type: "steps",
      variant: "cards",
      content: { title: "Как попасть на приём", items: ["Заявка", "Звонок", "Визит"] },
    });
    plan.landing.sections[4] = { ...(plan.landing.sections[4] as PlanSection), variant: "cards" };
    const p = polishDirection(plan, reg);
    expect(p.landing?.sections[0]?.band).toBeUndefined();
    expect(p.landing?.sections[3]?.variant).toBe("cards");
    expect(p.landing?.sections[4]?.variant).not.toBe("cards");
  });

  test("bands of the direction reach the page: an alt band where the agent asked, none on the hero", () => {
    const sc2 = DESIGN_SCENARIOS.find((s) => s.brief === "mvp-02-renovation") as DesignScenario;
    const next = mergeDesign(stagePlan(sc2), sc2.design, reg);
    const d = designDirection(next);
    expect(d.sections.find((s) => s.type === "gallery")).toMatchObject({ variant: "masonry", band: "alt" });
    expect(d.sections.find((s) => s.type === "hero")?.band).toBeNull();
    const built = compilePlan(next, reg);
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    expect(built.files["ui/pages/Home.tsx"]).toContain('tone="alt"');
  });

  test("palette from the accent: the brand colour as is, text shades with AA contrast", () => {
    const d = designDirection(mergeDesign(base(), sc.design, reg));
    expect(d.palette.accent).toBe(sc.design.accent);
    expect(d.palette.onAccent).toMatch(/^#[0-9A-F]{6}$/i);
    expect(d.palette.accentText).toMatch(/^#[0-9A-F]{6}$/i);
  });

  test("the canvas sketch shows the direction: theme, fonts, mood, voice, palette", () => {
    const plan = mergeDesign(base(), sc.design, reg);
    const built = compilePlan(plan, reg);
    const sk = planSketch(plan, built, reg);
    expect(sk.design).toMatchObject({
      theme: "care",
      themeName: "Заботливая",
      fonts: { heading: "Wix Madefor Display", body: "Wix Madefor Text" },
      voice: "calm",
      mood: ["бережность", "чистота", "доверие"],
    });
    expect(sk.design?.palette.accent).toBe(sc.design.accent);
  });
});
