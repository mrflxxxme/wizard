// V3-07 / V4-07: the art director stage. With a model it designs five directions (verbalized sampling) and code checks
// them — AA contrast, catalog fonts, the brand colour, designLint — sends issues back and keeps the three most
// different (recorded answer through the fixture router, suite unit — the request key must match the real prompt);
// without a model, on a refusal or an error — three archetype candidates of code and the first of them. No live calls.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, createRouter, decideTier, type RouteInput, type RouteOutput } from "@wizard/llm";
import { ARCHETYPE_IDS, cssHex, designDiversity, designLintErrors } from "@wizard/ui-kit/v3/design";
import { describe, expect, test } from "vitest";
import {
  ART_DIRECTION_CALL_TYPE,
  ART_DIRECTION_TOOL,
  type ArtDirectorInput,
  acceptedDirections,
  artDirectionCandidates,
  type DesignDirectionAnswer,
  type DesignDirectionsAnswer,
  designDirectionsIssues,
  designDirectionsMessages,
  designDirectionsTool,
  designProposalSchema,
  runArtDirector,
  storedProposal,
  toProposal,
} from "../src/builder/index.js";
import { fixtureLine } from "./build-v2-fixtures.js";
import { fiveDirections } from "./v4-art-fixtures.js";

const INPUT: ArtDirectorInput = {
  niche: "Пекарня-кондитерская, торты на заказ",
  goals: ["Заказы тортов через сайт", { text: "Меню и цены на виду" }],
  audience: "Семьи района, заказывают к праздникам",
  seed: "build-42",
  brandColor: "#B5541B",
};

const llm = createRegistry({ buildDefaultTier: "T1" });
const OPEN = { ruOnly: false, t1Restricted: false };

/** A scripted model: each call gets the next answer (null — a text answer; Error — thrown). */
function scripted(answers: (Record<string, unknown> | null | Error)[]) {
  const calls: RouteInput[] = [];
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    calls.push(input);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)] ?? null;
    if (a instanceof Error) throw a;
    return {
      tier: "T1",
      model: "glm-5.3",
      result: a
        ? {
            toolCalls: [{ id: `c${calls.length}`, name: "submit_design_directions", args: a }],
            finishReason: "tool-calls",
          }
        : { toolCalls: [], text: "Не могу выбрать.", finishReason: "stop" },
      usage: { inputTokens: 1500, cachedTokens: 0, outputTokens: 120 },
      creditsCharged: 0.05,
      creditsMilli: 50,
      routeReason: "default_T1",
      scrubbed: true,
      ruFallback: false,
    } as RouteOutput;
  };
  return { route, calls };
}

describe("candidates by code", () => {
  test("three different archetypes with their design systems; deterministic; the brand colour kept", () => {
    const a = artDirectionCandidates(INPUT);
    expect(artDirectionCandidates({ ...INPUT })).toEqual(a);
    expect(a.candidates).toHaveLength(3);
    expect(new Set(a.candidates.map((c) => c.archetype)).size).toBe(3);
    for (const c of a.candidates) {
      expect(c.name).toMatch(/[А-Яа-яё]/);
      expect(c.design.archetype).toBe(c.archetype);
      expect(designLintErrors(c.design)).toEqual([]);
      expect(cssHex(c.design.palette.light.accent)).toBe("#B5541B");
    }
    // Another seed of the same brief may draw other directions; the tokens are always code.
    const other = artDirectionCandidates({ ...INPUT, seed: "build-43" });
    expect(other.candidates.map((c) => c.design)).not.toEqual(a.candidates.map((c) => c.design));
  });

  test("niche memory: the archetypes of the last builds of the niche are not the first candidate", () => {
    const first = artDirectionCandidates(INPUT).candidates[0]?.archetype as string;
    const next = artDirectionCandidates({ ...INPUT, recent: [first] });
    expect(next.candidates[0]?.archetype).not.toBe(first);
    expect(next.avoided).toContain(first);
  });

  test("the owner's archetype from the brief comes first", () => {
    const c = artDirectionCandidates({ ...INPUT, design: { archetype: "swiss" } });
    expect(c.candidates[0]?.archetype).toBe("swiss");
    expect(new Set(c.candidates.map((x) => x.archetype)).size).toBe(3);
  });
});

describe("without a model", () => {
  test("deterministic choice of the first candidate, no calls", async () => {
    const r = await runArtDirector({ input: INPUT });
    expect(r).toEqual(await runArtDirector({ input: { ...INPUT } }));
    expect(r.fallback).toBe(true);
    expect(r.choice.source).toBe("fallback");
    expect(r.stats).toBeNull();
    expect(r.design).toEqual(r.candidates[0]?.design);
    expect(r.choice.archetype).toBe(r.candidates[0]?.archetype);
    expect(r.choice.styleName).toBe(r.candidates[0]?.name);
    expect(designLintErrors(r.design)).toEqual([]);
  });

  test("a pinned archetype of the owner is taken without asking the model", async () => {
    const { route, calls } = scripted([null]);
    const r = await runArtDirector({
      input: { ...INPUT, design: { archetype: "luxury", pinned: true } },
      route,
    });
    expect(calls).toHaveLength(0);
    expect(r.choice).toMatchObject({ archetype: "luxury", source: "pinned" });
    expect(r.fallback).toBe(false);
  });
});

describe("with a model: the model designs, code checks (V4-07)", () => {
  test("recorded answer: five directions → the three most different on different bases; the likeliest is the design", async () => {
    const answer = fiveDirections("#B5541B");
    const tool = designDirectionsTool(INPUT);
    const dir = mkdtempSync(join(tmpdir(), "wz-art-"));
    mkdirSync(join(dir, "unit"), { recursive: true });
    // Request keys are taken over the scrubbed messages (font names like «Sofia Sans» read as names there).
    const keyed = decideTier(
      { callType: ART_DIRECTION_CALL_TYPE, messages: designDirectionsMessages(INPUT), orgPolicy: OPEN },
      llm,
    ).scrubbedMessages;
    const line = fixtureLine(ART_DIRECTION_CALL_TYPE, keyed, [tool.definition], {
      name: ART_DIRECTION_TOOL,
      args: answer,
    });
    writeFileSync(join(dir, "unit", "art-director.jsonl"), `${JSON.stringify(line)}\n`);
    const router = createRouter({
      mode: "fixture",
      fixture: { suite: "unit", name: "art-director", dir },
      registry: llm,
      sink: { write: async () => {} },
      env: {},
    });
    const scrubbed: boolean[] = [];
    let milli = 0;
    const route = async (input: RouteInput) => {
      const out = await router.route({
        ...input,
        orgPolicy: { ruOnly: false, t1Restricted: false },
        ctx: { orgId: "org" },
      } as RouteInput);
      scrubbed.push(out.scrubbed);
      milli += out.creditsMilli;
      return out;
    };
    const r = await runArtDirector({ input: INPUT, route });
    expect(r.note).toBeUndefined();
    expect(r.fallback).toBe(false);
    expect(r.candidates.map((c) => c.name)).toEqual(["Тёплая витрина", "Ночная пекарня", "Чистая сетка"]);
    expect(new Set(r.candidates.map((c) => c.archetype)).size).toBe(3);
    expect(r.choice).toMatchObject({ archetype: "warm_craft", styleName: "Тёплая витрина", source: "model" });
    expect(r.proposal?.name).toBe("Тёплая витрина");
    // The model's own fonts and colours, the client's colour kept; tokens pass designLint.
    expect([r.design.fonts.display.family, r.design.fonts.text.family]).toEqual(["Alegreya", "Onest"]);
    expect(cssHex(r.design.palette.light.accent)).toBe("#B5541B");
    expect(cssHex(r.design.palette.light.bg)).toBe("#F7F5F2");
    for (const c of r.candidates) expect(designLintErrors(c.design)).toEqual([]);
    const d = designDiversity(r.candidates.map((c) => c.design));
    expect(d.minDistance).toBeGreaterThan(0.5);
    // V4-05 (D79 (3)): a build stage goes abroad as is; one call.
    expect(scrubbed).toEqual([false]);
    expect(r.stats?.calls).toBe(1);
    console.info(
      `V4-07 арт-директор на записанном ответе: ${((milli / 1000) * llm.rubPerCredit).toFixed(3)} ₽`,
    );
  });

  test("the prompt: taste rules, verbalized sampling, only catalog fonts, the brand colour and references", () => {
    const [system, user] = designDirectionsMessages({
      ...INPUT,
      references: ["Как у пекарни «Хлеб насущный»"],
    });
    expect(system?.content).toContain("probability");
    expect(system?.content).toContain("фиолетовых");
    expect(system?.content).toContain("Alegreya (антиква)");
    expect(system?.content).not.toMatch(/Inter Tight \(/);
    for (const id of ARCHETYPE_IDS) expect(system?.content).toContain(`- ${id} —`);
    expect(user?.content).toContain("#B5541B");
    expect(user?.content).toContain("Хлеб насущный");
    const schema = designProposalSchema();
    const one = fiveDirections().directions[0];
    expect(schema.safeParse(one).success).toBe(true);
    expect(schema.safeParse({ ...one, fonts: { display: "Playfair Display", text: "Onest" } }).success).toBe(
      false,
    );
  });

  test("repairs: low contrast, a changed brand colour and colour codes in the name go back to the model", async () => {
    const ok = fiveDirections("#B5541B");
    const broken: DesignDirectionsAnswer = structuredClone(ok);
    (broken.directions[0] as DesignDirectionAnswer).colors.ink = "#B8B0A8";
    (broken.directions[1] as DesignDirectionAnswer).colors.accent = "#3F7D3A";
    (broken.directions[2] as DesignDirectionAnswer).name = "Белый #FFFFFF";
    const { route, calls } = scripted([
      broken as unknown as Record<string, unknown>,
      ok as unknown as Record<string, unknown>,
    ]);
    const r = await runArtDirector({ input: INPUT, route });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.callType).toBe("art_direction");
    const repair = JSON.stringify(calls[1]?.messages);
    for (const code of ["TEXT_CONTRAST", "BRAND_COLOR", "NO_COLOURS"]) expect(repair).toContain(code);
    expect(r.fallback).toBe(false);
    expect(r.choice.source).toBe("model");
  });

  test("an answer that never passes keeps its valid directions when three remain; fewer → the archetypes of code", () => {
    const answer = fiveDirections();
    (answer.directions[1] as DesignDirectionAnswer).colors.ink = "#C8C8C8";
    const issues = designDirectionsIssues(answer, { ...INPUT, brandColor: undefined });
    expect(issues.map((i) => i.path)).toEqual(["directions.1.colors.ink"]);
    const kept = acceptedDirections(answer, { ...INPUT, brandColor: undefined });
    expect(kept.map((d) => d.proposal.name)).not.toContain("Почти витрина");
    expect(kept).toHaveLength(3);
    const few = fiveDirections();
    for (const d of few.directions.slice(1)) d.colors.ink = d.colors.bg;
    expect(designDirectionsIssues(few, { ...INPUT, brandColor: undefined }).map((i) => i.code)).toContain(
      "TOO_FEW_DISTINCT",
    );
    expect(acceptedDirections(few, { ...INPUT, brandColor: undefined })).toHaveLength(1);
  });

  test("a stored proposal is checked again before use", () => {
    const p = toProposal(fiveDirections().directions[0] as DesignDirectionAnswer);
    expect(storedProposal(p, { seed: 1, niche: "пекарня" })).toEqual(p);
    expect(
      storedProposal({ ...p, colors: { ...p.colors, ink: p.colors.bg } }, { seed: 1, niche: "x" }),
    ).toBeNull();
    expect(storedProposal({ archetype: "swiss" }, { seed: 1, niche: "x" })).toBeNull();
    expect(storedProposal(undefined, { seed: 1, niche: "x" })).toBeNull();
  });

  test("a refusal or an error of the model → the deterministic choice; an abort is not swallowed", async () => {
    const det = await runArtDirector({ input: INPUT });
    const refusal = await runArtDirector({ input: INPUT, route: scripted([null]).route });
    expect(refusal.fallback).toBe(true);
    expect(refusal.design).toEqual(det.design);
    expect(refusal.stats?.calls).toBe(3);
    const error = await runArtDirector({
      input: INPUT,
      route: scripted([new Error("провайдер недоступен")]).route,
    });
    expect(error.fallback).toBe(true);
    expect(error.note).toContain("провайдер недоступен");
    expect(error.design).toEqual(det.design);
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      runArtDirector({ input: INPUT, route: scripted([new Error("aborted")]).route, signal: ctl.signal }),
    ).rejects.toThrow("aborted");
  });
});
