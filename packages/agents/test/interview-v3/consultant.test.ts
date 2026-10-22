// V5-04 acceptance: every question has a hypothesis and ≥ 2 buttons, «Сделай сам» takes the default; the answers
// reach the brief journal the strategist reads; a screenshot reference gives tokens, the brand colour wins.
import { emptyBrief } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  contrastRatio,
  mergeStyleTokens,
  readReference,
  VIBES,
  vibeHeroHtml,
} from "../../src/builder/v3/directions/index.js";
import { businessDigest } from "../../src/builder/v4/prompts.js";
import {
  applyConsultToBrief,
  CONSULT_STEP_COUNT,
  type ConsultContext,
  consultQuestion,
  findCompetitors,
  fixtureSearch,
  foldConsult,
  SELF_DO_ID,
} from "../../src/interview-v3/index.js";

const ctx: ConsultContext = { name: "Кофемания", niche: "кофейня", city: "Казань" };

describe("consultant steps", () => {
  test("12–18 steps, each with a hypothesis and ≥ 2 buttons; the default is one of them", () => {
    expect(CONSULT_STEP_COUNT).toBeGreaterThanOrEqual(12);
    expect(CONSULT_STEP_COUNT).toBeLessThanOrEqual(18);
    const blocks = new Set<string>();
    for (let i = 0; i < CONSULT_STEP_COUNT; i++) {
      const q = consultQuestion(i, ctx);
      expect(q?.hypothesis.length).toBeGreaterThan(10);
      expect(q?.options.length).toBeGreaterThanOrEqual(2);
      expect(q?.options.map((o) => o.id)).toContain(q?.defaultId);
      blocks.add(q?.block ?? "");
    }
    expect([...blocks].sort()).toEqual(["business", "style", "system"]);
    expect(consultQuestion(CONSULT_STEP_COUNT, ctx)).toBeNull();
  });

  test("«Сделай сам» takes the default on every step", () => {
    const answers = Array.from({ length: CONSULT_STEP_COUNT }, (_, i) => ({
      questionId: consultQuestion(i, ctx)?.id ?? "",
      choice: [SELF_DO_ID],
    }));
    const r = foldConsult(ctx, answers);
    expect(r.qa).toHaveLength(CONSULT_STEP_COUNT);
    expect(r.qa.every((x) => x.chosen === "delegated" && x.a === x.recommended && x.a.length > 0)).toBe(true);
    expect(foldConsult(ctx, []).qa).toEqual(r.qa);
  });
});

describe("answers reach the brief and the strategist", () => {
  test("УТП, конкуренты и тон are in the digest of the strategist", async () => {
    const search = fixtureSearch({
      кофейня: [
        { title: "Бобры", url: "https://bobry.ru/kazan", snippet: "сеть кофеен" },
        { title: "2ГИС", url: "https://2gis.ru/kazan", snippet: "справочник" },
        { title: "Зерно", url: "https://www.zerno.ru", snippet: "обжарка" },
        { title: "Бобры 2", url: "https://bobry.ru/other", snippet: "дубль" },
      ],
    });
    const competitors = await findCompetitors(search, ctx);
    expect(competitors.map((c) => c.url)).toEqual(["https://bobry.ru", "https://zerno.ru"]);
    const c2 = { ...ctx, competitors };
    const brief = emptyBrief();
    const r = foldConsult(c2, [{ questionId: "usp", choice: [], text: "Обжариваем сами, 12 лет" }]);
    applyConsultToBrief(brief, r);
    const digest = businessDigest({ name: ctx.name, brief, photos: [] });
    expect(digest).toContain("Обжариваем сами, 12 лет");
    expect(digest).toContain("bobry.ru");
    expect(digest).toContain("тёплый, простой");
    expect(digest).toContain("Стиль сайта");
  });

  test("a failed search gives no competitors, not an error", async () => {
    expect(await findCompetitors(async () => Promise.reject(new Error("x")), ctx)).toEqual([]);
  });
});

describe("style: vibes, reference, brand", () => {
  test("8 vibes, each hero preview carries the client's headline", () => {
    expect(VIBES).toHaveLength(8);
    for (const v of VIBES) {
      expect(vibeHeroHtml(v, "Кофе <b>без</b> суеты")).toContain("Кофе &lt;b&gt;без&lt;/b&gt; суеты");
      expect(contrastRatio(v.text, v.background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  const good = {
    background: "#101820",
    text: "#f2f2f2",
    accent: "#ff6b35",
    density: "dense",
    fontKind: "mono",
  };

  test("a reference gives palette, contrast, density and font kind", async () => {
    const ref = await readReference(async () => good, { url: "https://example.ru/shot.png" });
    expect(ref).not.toBeNull();
    const t = mergeStyleTokens({ vibes: ["workshop"], reference: ref });
    expect(t).toMatchObject({ background: "#101820", accent: "#ff6b35", density: "dense", fontKind: "mono" });
    expect(t.contrast).toBeGreaterThan(10);
    expect(t.sources).toEqual(["vibe", "reference"]);
  });

  test("brand colour wins over the reference and the vibe", async () => {
    const ref = await readReference(async () => good, { dataUrl: "data:image/png;base64,AAAA" });
    const t = mergeStyleTokens({ vibes: ["night"], reference: ref, brandColor: "#00aa55" });
    expect(t.accent).toBe("#00aa55");
    expect(t.sources.at(-1)).toBe("brand");
  });

  test("an unreadable reference falls back to the vibes; low contrast text is repaired", async () => {
    expect(await readReference(async () => ({ nope: 1 }), { url: "https://x.ru/a.png" })).toBeNull();
    expect(
      await readReference(async () => Promise.reject(new Error("vision down")), { url: "https://x.ru" }),
    ).toBeNull();
    const t = mergeStyleTokens({
      vibes: [],
      reference: {
        background: "#ffffff",
        text: "#eeeeee",
        accent: "#123456",
        density: "airy",
        fontKind: "sans",
      },
    });
    expect(t.contrast).toBeGreaterThanOrEqual(4.5);
  });
});
