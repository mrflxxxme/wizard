// V4-17: «три направления» in parallel. A short ideas call (verbalized sampling: probabilities, the likeliest and the
// rarest kept on different bases), then one call per idea — its design system and its first-screen texts at once —
// run at the same time; each direction is handed out as soon as its own call ends, so the first screen does not wait
// for the slowest one. A direction whose call fails falls back to its archetype and the brief's texts alone; no ideas
// → the archetypes of code still get their own calls; no model → code throughout. The three stay far apart.
import { type SystemBrief, systemBriefSchema } from "@wizard/appspec";
import type { RouteInput, RouteOutput } from "@wizard/llm";
import { designDiversity } from "@wizard/ui-kit/v3/design";
import { describe, expect, test } from "vitest";
import { dentalBrief } from "../../appspec/test/brief-fixtures.js";
import {
  DESIGN_DIRECTION_TOOL,
  DIRECTION_IDEAS_TOOL,
  type DirectionIdea,
  directionsNiche,
  pickIdeas,
  proposalDesigns,
  proposeDirections,
  type StoredDirection,
} from "../src/builder/index.js";
import { fiveDirections } from "./v4-art-fixtures.js";

const NAME = "Стоматология «Улыбка»";
const NICHE = directionsNiche(NAME, "Нужен сайт стоматологии в нашем районе с онлайн-записью");
const BRIEF: SystemBrief = systemBriefSchema.parse({ ...dentalBrief(), design: { references: [] } });
const INPUT = { brief: BRIEF, name: NAME, niche: NICHE, seed: "sys-v417" };
const FIVE = fiveDirections().directions;
const IDEAS = FIVE.map(({ name, why, probability, base, voice }) => ({
  name,
  why,
  probability,
  base,
  voice,
}));
const TEXTS = {
  title: "Запись к стоматологу онлайн",
  lead: "Выберите услугу и удобное время на сайте — администратор подтвердит запись.",
  action: "Записаться",
};

const answer = (name: string, args: unknown, n: number): RouteOutput =>
  ({
    tier: "T1",
    model: "kimi-k3",
    result: { toolCalls: [{ id: `c${n}`, name, args }], finishReason: "tool-calls" },
    usage: { inputTokens: 3000, cachedTokens: 0, outputTokens: 1200 },
    creditsCharged: 0.3,
    creditsMilli: 300,
    routeReason: "default_T1",
    scrubbed: false,
    ruFallback: false,
  }) as RouteOutput;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const baseOf = (input: RouteInput) => /base: ([a-z_]+);/.exec(JSON.stringify(input.messages))?.[1];

/** The model: ideas on the ideas tool; on the direction tool the matching direction of FIVE, slow or failing by base. */
function model(o: { delay?: Record<string, number>; fail?: string[]; noIdeas?: boolean } = {}) {
  const calls: RouteInput[] = [];
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    calls.push(input);
    const tool = input.tools?.[0]?.name ?? "";
    if (tool === DIRECTION_IDEAS_TOOL) {
      if (o.noIdeas) throw new Error("upstream 502");
      return answer(tool, { ideas: IDEAS }, calls.length);
    }
    const base = baseOf(input) as string;
    await sleep(o.delay?.[base] ?? 20);
    if (o.fail?.includes(base)) throw new Error("timeout");
    const d = FIVE.find((x) => x.base === base) ?? FIVE[0];
    return answer(tool, { ...d, texts: TEXTS }, calls.length);
  };
  return { route, calls };
}

describe("V4-17 directions in parallel", () => {
  test("ideas: the likeliest and the two rarest on different bases", () => {
    expect(pickIdeas({ ideas: IDEAS as DirectionIdea[] }).map((d) => d.base)).toEqual([
      "warm_craft",
      "editorial",
      "night_contrast",
    ]);
  });

  test("one ideas call, then three direction calls at the same time; each handed out as soon as it is ready", async () => {
    const { route, calls } = model({ delay: { warm_craft: 300, editorial: 30, night_contrast: 120 } });
    const ready: { n: number; at: number }[] = [];
    const t0 = Date.now();
    const p = await proposeDirections(
      INPUT,
      { route },
      { onDirection: (d: StoredDirection) => ready.push({ n: d.n, at: Date.now() - t0 }) },
    );
    const total = Date.now() - t0;
    expect(calls.map((c) => c.tools?.[0]?.name)).toEqual([
      DIRECTION_IDEAS_TOOL,
      DESIGN_DIRECTION_TOOL,
      DESIGN_DIRECTION_TOOL,
      DESIGN_DIRECTION_TOOL,
    ]);
    // In the order they became ready, not in their order; the slowest alone sets the total (parallel, not 450 ms).
    expect(ready.map((r) => r.n)).toEqual([2, 3, 1]);
    expect((ready[0] as { at: number }).at).toBeLessThan(200);
    expect(total).toBeLessThan(420);
    expect(p.directions.map((d) => d.archetype)).toEqual(["warm_craft", "editorial", "night_contrast"]);
    expect(p.directions.map((d) => d.name)).toEqual(["Тёплая витрина", "Газетная колонка", "Ночная пекарня"]);
    expect(p.directions.every((d) => d.system && d.textsSource === "model")).toBe(true);
    expect(p.directions[0]?.texts).toEqual(TEXTS);
    expect(p.fallback).toBe(false);
    expect(p.calls).toBe(4);
    expect(p.costRub).toBeGreaterThan(0);
    expect(designDiversity(proposalDesigns(p)).minDistance).toBeGreaterThan(0.5);
    // Each direction's call names its idea and the others to stay away from; the ideas call carries no font lists.
    expect(JSON.stringify(calls[1]?.messages)).toContain("Другие направления");
    expect(JSON.stringify(calls[0]?.messages)).not.toContain("fonts.display");
  });

  test("a failed direction falls back alone: its archetype and the brief's texts; the others are the model's", async () => {
    const { route } = model({ fail: ["editorial"] });
    const got: number[] = [];
    const p = await proposeDirections(INPUT, { route }, { onDirection: (d) => got.push(d.n) });
    expect(got.sort()).toEqual([1, 2, 3]);
    const two = p.directions[1] as StoredDirection;
    expect(two.archetype).toBe("editorial");
    expect(two.system).toBeUndefined();
    expect(two.textsSource).toBe("brief");
    expect(p.directions.filter((d) => d.textsSource === "model")).toHaveLength(2);
    expect(p.fallback).toBe(false);
    expect(p.notes.join(" ")).toContain("направление 2");
  });

  test("no ideas: the archetypes of code still get their own calls", async () => {
    const { route, calls } = model({ noIdeas: true });
    const p = await proposeDirections(INPUT, { route }, { onDirection: () => {} });
    expect(calls.filter((c) => c.tools?.[0]?.name === DESIGN_DIRECTION_TOOL)).toHaveLength(3);
    expect(new Set(p.directions.map((d) => d.archetype)).size).toBe(3);
    expect(p.notes.join(" ")).toContain("идеи по архетипам");
  });

  test("no model: code throughout, each direction still handed out", async () => {
    const got: StoredDirection[] = [];
    const p = await proposeDirections(INPUT, {}, { onDirection: (d) => got.push(d) });
    expect(got).toHaveLength(3);
    expect(p.fallback).toBe(true);
    expect(p.directions.every((d) => d.textsSource === "brief" && !d.system)).toBe(true);
    expect(p.calls).toBe(0);
  });
});
