// V4-09 follow-up: the visual critic calls zai models without reasoning (thinking disabled, no reasoning headroom);
// every other call type keeps its effort (HIGH_REASONING → high, the rest → low).
import { describe, expect, test } from "vitest";
import { HIGH_REASONING, NO_REASONING, reasoningOf } from "../src/index.js";
import { transformBody } from "../src/providers.js";

describe("V4-09: critic_visual without reasoning", () => {
  test("reasoningOf: critic_visual off, card high, page_compose and photo_pick low", () => {
    expect([...NO_REASONING]).toEqual(["critic_visual"]);
    expect(reasoningOf("critic_visual")).toBe("off");
    expect(reasoningOf("card")).toBe("high");
    expect(reasoningOf("page_compose")).toBe("low");
    expect(reasoningOf("photo_pick")).toBe("low");
    for (const ct of NO_REASONING) expect(HIGH_REASONING.has(ct)).toBe(false);
  });

  test("zai with reasoning off: thinking disabled, no reasoning_effort, max_tokens without the headroom", () => {
    const out = transformBody(
      "zai",
      { messages: [], max_tokens: 4000, reasoning_effort: "high", tools: [{ type: "function" }] },
      "off",
    );
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out).not.toHaveProperty("reasoning_effort");
    expect(out.max_tokens).toBe(4000);
    expect(out.tools).toEqual([{ type: "function" }]);
  });

  test("other providers ignore off as they ignore low (their own thinking rules)", () => {
    expect(transformBody("deepseek", { messages: [] }, "off").thinking).toEqual({ type: "disabled" });
    expect(transformBody("moonshot", { messages: [], tools: [{}] }, "off")).not.toHaveProperty("thinking");
  });
});
