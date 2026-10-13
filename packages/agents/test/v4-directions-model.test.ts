// V4-07: «три направления» designed by the art director's model. The design call answers five directions; code keeps
// the three most different (their own names, fonts and palettes), the texts call writes the first screens, the owner's
// pick carries the model's system into brief.design.system and the build's design is exactly the screen picked. On
// three reference briefs the three directions stay far apart (token-level distance of the template gate input).
import { type SystemBrief, systemBriefSchema } from "@wizard/appspec";
import type { RouteInput, RouteOutput } from "@wizard/llm";
import { cssHex, designDiversity, designLintErrors } from "@wizard/ui-kit/v3/design";
import { describe, expect, test } from "vitest";
import { dentalBrief, shopBrief } from "../../appspec/test/brief-fixtures.js";
import {
  ART_DIRECTION_TOOL,
  acceptedDirections,
  briefDesign,
  DIRECTION_TEXTS_TOOL,
  directionDesign,
  directionsNiche,
  pickedDesign,
  proposalDesigns,
  proposeDirections,
} from "../src/builder/index.js";
import { fiveDirections } from "./v4-art-fixtures.js";

const NAME = "Стоматология «Улыбка»";
const NICHE = directionsNiche(NAME, "Нужен сайт стоматологии в нашем районе с онлайн-записью");
const BRIEF: SystemBrief = systemBriefSchema.parse({ ...dentalBrief(), design: { references: [] } });
const INPUT = { brief: BRIEF, name: NAME, niche: NICHE, seed: "sys-v407" };

/** The model: design directions on the design tool, three sets of texts on the texts tool. */
function model() {
  const calls: RouteInput[] = [];
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    calls.push(input);
    const tool = input.tools?.[0]?.name;
    const args =
      tool === ART_DIRECTION_TOOL
        ? fiveDirections()
        : {
            sets: ["warm_craft", "night_contrast", "swiss"].map((direction, i) => ({
              direction,
              title: ["Запись к стоматологу онлайн", "Стоматолог рядом с домом", "Лечение зубов без очереди"][
                i
              ] as string,
              lead: "Выберите услугу и удобное время на сайте — администратор подтвердит запись.",
              action: "Записаться",
            })),
          };
    return {
      tier: "T1",
      model: "kimi-k3",
      result: { toolCalls: [{ id: `c${calls.length}`, name: tool ?? "", args }], finishReason: "tool-calls" },
      usage: { inputTokens: 4000, cachedTokens: 0, outputTokens: 2500 },
      creditsCharged: 0.6,
      creditsMilli: 600,
      routeReason: "default_T1",
      scrubbed: false,
      ruFallback: false,
    } as RouteOutput;
  };
  return { route, calls };
}

describe("V4-07 «три направления» designed by the model", () => {
  test("design call, then texts: three different systems with the model's names, fonts and colours", async () => {
    const { route, calls } = model();
    const p = await proposeDirections(INPUT, { route });
    expect(calls.map((c) => c.tools?.[0]?.name)).toEqual([ART_DIRECTION_TOOL, DIRECTION_TEXTS_TOOL]);
    expect(p.directions.map((d) => d.name)).toEqual(["Тёплая витрина", "Ночная пекарня", "Чистая сетка"]);
    expect(p.directions.map((d) => d.archetype)).toEqual(["warm_craft", "night_contrast", "swiss"]);
    expect(p.directions.every((d) => d.system && d.textsSource === "model")).toBe(true);
    // The texts prompt names the model's directions.
    expect(JSON.stringify(calls[1]?.messages)).toContain("Ночная пекарня");
    const designs = proposalDesigns(p);
    expect(designs.map((d) => d.fonts.display.family)).toEqual([
      "Alegreya",
      "Unbounded",
      "Wix Madefor Display",
    ]);
    expect(designs.map((d) => d.palette.scheme)).toEqual(["light", "dark", "light"]);
    expect(cssHex(designs[2]?.palette.light.accent as string)).toBe("#C8102E");
    for (const d of designs) expect(designLintErrors(d)).toEqual([]);
    expect(designDiversity(designs).minDistance).toBeGreaterThan(0.5);
    expect(p.fallback).toBe(false);
    expect(p.costRub).toBeCloseTo(2 * 0.6 * 5, 5);
  });

  test("the owner's pick goes into brief.design.system; the build's design is exactly the screen picked", async () => {
    const p = await proposeDirections(INPUT, { route: model().route });
    const d2 = p.directions[1];
    if (!d2) throw new Error("no direction 2");
    const design = pickedDesign(BRIEF.design, p, 2);
    expect(design).toMatchObject({ archetype: "night_contrast", pinned: true });
    expect(design.system).toEqual(d2.system);
    const brief = systemBriefSchema.parse({ ...BRIEF, design });
    const built = briefDesign(brief, { seed: p.seed, niche: p.niche });
    expect(built?.design).toEqual(directionDesign(p, d2).design);
    // «Решите за меня»: the first direction's system, not pinned.
    expect(pickedDesign(BRIEF.design, p, null)).toMatchObject({
      pinned: false,
      system: p.directions[0]?.system,
    });
  });

  test("without a model or with a broken answer — the archetypes of code, as in v3", async () => {
    const noModel = await proposeDirections(INPUT);
    expect(noModel.directions.every((d) => !d.system)).toBe(true);
    const broken = async (input: RouteInput): Promise<RouteOutput> => {
      const r = await model().route(input);
      if (input.tools?.[0]?.name !== ART_DIRECTION_TOOL) return r;
      const answer = fiveDirections();
      for (const d of answer.directions) d.colors.ink = d.colors.bg;
      return {
        ...r,
        result: { ...r.result, toolCalls: [{ id: "c", name: ART_DIRECTION_TOOL, args: answer }] },
      };
    };
    const p = await proposeDirections(INPUT, { route: broken });
    expect(p.directions.every((d) => !d.system)).toBe(true);
    expect(p.notes.join(" ")).toContain("направления по архетипам");
  });

  test("three reference briefs: the three directions of each stay far apart", () => {
    const briefs = [
      { niche: "стоматология с онлайн-записью", seed: "a", brand: undefined },
      { niche: "магазин украшений ручной работы", seed: "b", brand: "#1F5FA8" },
      { niche: "автосервис: заявка на ремонт", seed: "c", brand: "#C8102E" },
    ];
    for (const b of briefs) {
      const kept = acceptedDirections(fiveDirections(b.brand), {
        niche: b.niche,
        goals: [],
        seed: b.seed,
        ...(b.brand ? { brandColor: b.brand } : {}),
      });
      expect(kept, b.niche).toHaveLength(3);
      const d = designDiversity(kept.map((x) => x.design));
      expect(d.minDistance, b.niche).toBeGreaterThan(0.5);
      expect(d.fontPairs).toBe(3);
    }
    expect(shopBrief()).toBeTruthy();
  });
});
