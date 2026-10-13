// V3-13: the upper bound of a call's cost (budget.ts upperBoundCredits) counts screenshots as images by the model's rule
// (models.yaml#models[].image), not their base64 as text. A critic cycle with 4 screenshots 390/1440 is bounded close
// to what the recorded answer costs (the output reserve max_tokens stays); text calls are bounded exactly as before.
import {
  CALL_TYPES,
  type CallType,
  costRub,
  creditsMilli,
  estimateTokens,
  imageTokens,
  type LlmMessage,
  type LlmTool,
  MODELS,
} from "@wizard/llm";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import { type CriticShot, critiqueMessages, critiqueTool, upperBoundCredits } from "../src/builder/index.js";
import { siteFacts } from "../src/builder/v3/compose/index.js";
import { criticContext, critique, critiqueLines, fixtureRoute, registry } from "./v3-critic-fixtures.js";

const rpc = registry.rubPerCredit;
const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
/** A JPEG of the size with `bytes` of incompressible filler: the base64 is as long as a real screenshot's. */
function jpeg(width: number, height: number, bytes: number): string {
  const sof = Buffer.concat([
    Buffer.from([0xff, 0xc0]),
    u16(17),
    Buffer.from([8]),
    u16(height),
    u16(width),
    Buffer.alloc(10),
  ]);
  const fill = Buffer.from(Array.from({ length: bytes }, (_, i) => (i * 2654435761) >>> 24));
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, fill, Buffer.from([0xff, 0xd9])]).toString("base64");
}

/** The bound before V3-13: the whole JSON of the messages (base64 included) / 3.2 for every model of the chain. */
function oldBound(ct: CallType, messages: readonly LlmMessage[], tools: readonly LlmTool[]): number {
  const route = registry.routes[ct];
  const ids = [...(route.chain.T1 ?? []), ...(route.chain.T0 ?? [])];
  const input = estimateTokens(messages) + estimateTokens(tools);
  let worst = 0;
  for (const m of registry.models.filter((x) => ids.includes(x.id) && x.enabled))
    worst = Math.max(
      worst,
      creditsMilli(
        costRub(m.price, { inputTokens: input, cachedTokens: 0, outputTokens: route.maxTokens }),
        rpc,
      ),
    );
  return worst / 1000;
}

describe("V3-13 upper bound of a call with images", () => {
  test("text calls: the bound of every callType is exactly the old one", () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "Ты — агент сборки. Отвечай только вызовом инструмента." },
      { role: "user", content: "Бриф: стоматология «Белая линия», запись с сайта, напоминания. ".repeat(40) },
    ];
    const tools = [critiqueTool.definition];
    const bounds = Object.fromEntries(
      CALL_TYPES.map((ct) => [ct, upperBoundCredits(ct, messages, tools, registry)]),
    );
    expect(bounds).toEqual(Object.fromEntries(CALL_TYPES.map((ct) => [ct, oldBound(ct, messages, tools)])));
    expect(bounds).toMatchInlineSnapshot(`
      {
        "art_direction": 2.212,
        "audit": 1.225,
        "brief_extract": 1.399,
        "build_code": 2.727,
        "build_custom": 1.731,
        "build_design": 0.321,
        "build_ops": 1.399,
        "build_texts": 0.736,
        "card": 1.399,
        "critic_visual": 0.644,
        "fix": 2.063,
        "import_mapping": 0.736,
        "interview": 1.399,
        "interview_v3": 1.399,
        "page_compose": 5.69,
        "page_edit": 2.727,
        "plan": 0.736,
        "qa_explain": 0.404,
        "qa_generate": 1.399,
        "repo_code": 2.727,
        "repo_review": 1.237,
        "research": 0.644,
        "runtime_ai_extract": 0.208,
        "runtime_ai_generate": 0.38,
        "signature_section": 5.69,
        "support": 0.736,
        "system_plan": 1.399,
        "techreview": 1.237,
      }
    `);
  });

  test("a critic cycle with 4 screenshots 390/1440: the bound is near the recorded cost, not 5 times over", async () => {
    const ctx = await criticContext();
    const shot = (
      route: string,
      width: 390 | 1440,
      kind: "screen" | "page",
      w: number,
      h: number,
      bytes: number,
    ): CriticShot => ({
      route,
      width,
      kind,
      maxWidth: w,
      maxHeight: kind === "page" ? 2400 : h,
      mime: "image/jpeg",
      data: jpeg(w, h, bytes),
      px: { width: w, height: h },
      sections: ["header", "hero"],
    });
    // Sizes of the JPEGs the platform inspector sent in the browser test (≈ 28/18/40/23 thousand base64 characters).
    const shots = [
      shot("/", 390, "screen", 390, 844, 21_000),
      shot("/", 1440, "screen", 720, 450, 13_500),
      shot("/", 1440, "page", 360, 1800, 30_000),
      shot("/services", 390, "screen", 390, 844, 17_000),
    ];
    const messages = critiqueMessages({
      facts: siteFacts(ctx),
      brief: ctx.brief,
      site: ctx.site,
      design: ctx.design,
      library: PATTERNS,
      shots,
      found: [],
      history: [],
      stubPhotos: true,
    });
    const tools = [critiqueTool.definition];
    // The recorded answer is priced like a live one: the vision model that answers (V4-05: glm-5v-turbo abroad).
    const glm = MODELS.find((m) => m.id === "glm-5v-turbo");
    const images = shots.reduce((s, x) => s + imageTokens(x.px.width, x.px.height, glm?.image), 0);
    const fx = fixtureRoute(critiqueLines({ messages, imageTokens: images }, [critique(2)]));
    const out = await fx.route({
      callType: "critic_visual",
      messages,
      tools,
      toolChoice: "required",
      ctx: { orgId: "org" },
    });
    expect(`${out.tier}:${out.model}`).toBe("T1:glm-5v-turbo");
    const actual = (out.creditsMilli / 1000) * rpc;
    const bound = upperBoundCredits("critic_visual", messages, tools, registry) * rpc;
    const before = oldBound("critic_visual", messages, tools) * rpc;
    expect(actual).toBeGreaterThan(1);
    expect(bound).toBeGreaterThan(actual);
    // With room for the reserve of max_tokens, but not 5 times over (the old bound was).
    // V4-05: the bound prices the dearest model of the chain (kimi-k2.6), the answer comes from glm-5v-turbo.
    expect(bound / actual).toBeLessThan(3);
    expect(before / actual).toBeGreaterThan(4);
    // Three cycles of such calls fit the critic's 60 ₽ by their bounds.
    expect(3 * bound).toBeLessThan(60);
  });
});
