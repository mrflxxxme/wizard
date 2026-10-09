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
        "art_direction": 0.731,
        "audit": 1.221,
        "brief_extract": 1.394,
        "build_code": 2.722,
        "build_custom": 1.726,
        "build_design": 0.316,
        "build_ops": 1.394,
        "build_texts": 0.731,
        "card": 1.394,
        "critic_visual": 0.64,
        "fix": 2.058,
        "import_mapping": 0.731,
        "interview": 1.394,
        "interview_v3": 1.394,
        "page_compose": 2.722,
        "plan": 0.731,
        "qa_explain": 0.399,
        "qa_generate": 1.394,
        "repo_code": 2.722,
        "repo_review": 1.233,
        "research": 0.64,
        "runtime_ai_extract": 0.201,
        "runtime_ai_generate": 0.368,
        "signature_section": 2.058,
        "support": 0.731,
        "system_plan": 1.394,
        "techreview": 1.233,
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
    // The recorded answer is priced like a live one: the T0 vision model that answers (kimi-k2.6), its image rule.
    const kimi = MODELS.find((m) => m.id === "kimi-k2.6");
    const images = shots.reduce((s, x) => s + imageTokens(x.px.width, x.px.height, kimi?.image), 0);
    const fx = fixtureRoute(critiqueLines({ messages, imageTokens: images }, [critique(2)]));
    const out = await fx.route({
      callType: "critic_visual",
      messages,
      tools,
      toolChoice: "required",
      ctx: { orgId: "org" },
    });
    expect(`${out.tier}:${out.model}`).toBe("T0:kimi-k2.6");
    const actual = (out.creditsMilli / 1000) * rpc;
    const bound = upperBoundCredits("critic_visual", messages, tools, registry) * rpc;
    const before = oldBound("critic_visual", messages, tools) * rpc;
    expect(actual).toBeGreaterThan(1);
    expect(bound).toBeGreaterThan(actual);
    // With room for the reserve of max_tokens, but not 5 times over (the old bound was).
    expect(bound / actual).toBeLessThan(2.5);
    expect(before / actual).toBeGreaterThan(4);
    // Three cycles of such calls fit the critic's 40 ₽ by their bounds.
    expect(3 * bound).toBeLessThan(40);
  });
});
