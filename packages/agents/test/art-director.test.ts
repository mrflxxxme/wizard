// V3-07: the art director stage. Three candidate directions by code (pickArchetypes with the niche memory) and their
// design systems (designSystemV3, no model); the model only picks one of them and interprets the brand colour and the
// voice through submit_art_direction (recorded answer through the fixture router, suite unit — the request key must
// match the real prompt); without a model, on a refusal or an error — the deterministic choice. No live calls.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, createRouter, type RouteInput, type RouteOutput } from "@wizard/llm";
import { ARCHETYPE_IDS, cssHex, designLintErrors, designSystemV3 } from "@wizard/ui-kit/v3/design";
import { describe, expect, test } from "vitest";
import {
  ART_DIRECTION_CALL_TYPE,
  type ArtDirectorInput,
  artDirectionCandidates,
  artDirectionMessages,
  artDirectionSchema,
  runArtDirector,
} from "../src/builder/index.js";
import { defineTool } from "../src/core/tool.js";
import { fixtureLine } from "./build-v2-fixtures.js";

const INPUT: ArtDirectorInput = {
  niche: "Пекарня-кондитерская, торты на заказ",
  goals: ["Заказы тортов через сайт", { text: "Меню и цены на виду" }],
  audience: "Семьи района, заказывают к праздникам",
  seed: "build-42",
  brandColor: "#B5541B",
};

const llm = createRegistry({ buildDefaultTier: "T1" });

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
            toolCalls: [{ id: `c${calls.length}`, name: "submit_art_direction", args: a }],
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

describe("with a model (recorded answer through the fixture router)", () => {
  test("the model picks the second candidate, voice and use of the brand colour; tokens stay code", async () => {
    const { candidates } = artDirectionCandidates(INPUT);
    const second = candidates[1]?.archetype as string;
    const answer = {
      archetype: second,
      voice: "warm",
      accentUse: "band",
      styleName: "Тёплая витрина",
      why: "Торты продают фото и честные цены: спокойная сетка и одна цветная полоса с фирменным цветом.",
    };
    const tool = defineTool({
      name: "submit_art_direction",
      description: "art direction",
      input: artDirectionSchema(candidates.map((c) => c.archetype)),
    });
    const dir = mkdtempSync(join(tmpdir(), "wz-art-"));
    mkdirSync(join(dir, "unit"), { recursive: true });
    const line = fixtureLine(
      ART_DIRECTION_CALL_TYPE,
      artDirectionMessages(INPUT, candidates),
      [tool.definition],
      {
        name: "submit_art_direction",
        args: answer,
      },
    );
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
    expect(r.fallback).toBe(false);
    expect(r.choice).toEqual({ ...answer, source: "model" });
    expect(r.design.archetype).toBe(second);
    expect(r.design.voice).toBe("warm");
    expect(r.design.palette.accentUse).toBe("band");
    expect(r.design).toEqual(
      designSystemV3({
        archetype: second as (typeof ARCHETYPE_IDS)[number],
        brandColor: "#B5541B",
        seed: INPUT.seed,
        niche: INPUT.niche,
        voice: "warm",
        accentUse: "band",
      }),
    );
    expect(cssHex(r.design.palette.light.accent)).toBe("#B5541B");
    expect(designLintErrors(r.design)).toEqual([]);
    expect(r.candidates.find((c) => c.archetype === second)?.design).toEqual(r.design);
    // Everything that goes to T1 is scrubbed (AGENTS.md); one call.
    expect(scrubbed).toEqual([true]);
    expect(r.stats?.calls).toBe(1);
    console.info(
      `V3-07 арт-директор на записанном ответе: ${((milli / 1000) * llm.rubPerCredit).toFixed(3)} ₽`,
    );
  });

  test("the prompt lists only the three candidates and the brand colour; no other archetype can be chosen", () => {
    const { candidates } = artDirectionCandidates(INPUT);
    const [system, user] = artDirectionMessages(INPUT, candidates);
    for (const c of candidates) expect(system?.content).toContain(`${c.archetype} — «${c.name}»`);
    const others = ARCHETYPE_IDS.filter((id) => !candidates.some((c) => c.archetype === id));
    for (const id of others) expect(system?.content).not.toContain(`- ${id} —`);
    expect(user?.content).toContain("#B5541B");
    const schema = artDirectionSchema(candidates.map((c) => c.archetype));
    expect(
      schema.safeParse({
        archetype: others[0],
        voice: "warm",
        accentUse: "fill",
        styleName: "Тест",
        why: "1234567890",
      }).success,
    ).toBe(false);
  });

  test("repairs: an archetype outside the three and invented colours go back to the model", async () => {
    const { candidates } = artDirectionCandidates(INPUT);
    const outside = ARCHETYPE_IDS.find((id) => !candidates.some((c) => c.archetype === id));
    const ok = {
      archetype: candidates[2]?.archetype,
      voice: "friendly",
      accentUse: "signal",
      styleName: "Домашняя кухня",
      why: "Покупатели выбирают по фото тортов и цене, поэтому главное — снимки и понятный прайс.",
    };
    const { route, calls } = scripted([
      { ...ok, archetype: outside },
      { ...ok, why: "Фон #FFF3E0 и акцент rgb(200, 80, 20) сделают сайт тёплым и аппетитным." },
      ok,
    ]);
    const r = await runArtDirector({ input: INPUT, route });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.callType).toBe("build_design");
    expect(JSON.stringify(calls[2]?.messages)).toContain("NO_COLOURS");
    expect(r.choice).toMatchObject({ archetype: ok.archetype, source: "model", styleName: "Домашняя кухня" });
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
