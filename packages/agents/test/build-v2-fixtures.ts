// B2-21: recorded answers of the modules pipeline (tools/fixtures/demo/b2/<name>.jsonl, suite demo — answers by the
// order of each callType) generated from build-v2-scenarios.ts. Usage is counted from the real prompts the agents send
// (characters / 3.2, as the budget estimate) plus a reasoning allowance per call, so the build cost on these answers is
// the cost by the models.yaml prices. Regenerate: WIZARD_GEN_FIXTURES=1 pnpm exec vitest run packages/agents/test/build-v2.fixtures.test.ts
import { join } from "node:path";
import type { SystemPlan } from "@wizard/appspec";
import { type FixtureLine, type LlmMessage, type LlmTool, ROUTES, requestKey, schemaHash } from "@wizard/llm";
import { compilePlan } from "@wizard/modules";
import { estimateTokens } from "../src/builder/budget.js";
import {
  customFixText,
  customInputSchema,
  customMessages,
  designInputSchema,
  designMessages,
  mergeDesign,
  mergeTexts,
  textsInputSchema,
  textsMessages,
} from "../src/builder/index.js";
import { defineTool } from "../src/core/tool.js";
import { reportCapabilityGapTool } from "../src/gaps.js";
import {
  DEFAULT_REGISTRY,
  finalizePlan,
  goalsAnalysisSchema,
  interviewMessages,
  plannerMessages,
  plannerPlanSchema,
} from "../src/planner/index.js";
import type { B2CustomScenario, B2Scenario } from "./build-v2-scenarios.js";

export const ROOT = join(import.meta.dirname, "../../..");
export const B2_FIXTURE_DIR = join(ROOT, "tools/fixtures/demo/b2");
const MODEL = "glm-5.3";
const RECORDED_AT = "2026-10-06T00:00:00.000Z";

/** Reasoning tokens glm-5.3 adds to the answer (effort high for system_plan, low for the rest) and latency, ms. */
const CALL_PROFILE = {
  interview: { reasoning: 1200, latencyMs: 30_000 },
  system_plan: { reasoning: 4000, latencyMs: 120_000 },
  build_texts: { reasoning: 800, latencyMs: 40_000 },
  build_design: { reasoning: 500, latencyMs: 18_000 },
  art_direction: { reasoning: 500, latencyMs: 18_000 },
  build_custom: { reasoning: 1500, latencyMs: 90_000 },
  // V3-04: T0 only — the first model of the route chain answers (models.yaml#routes.brief_extract).
  brief_extract: { reasoning: 0, latencyMs: 25_000, model: "gigachat-3.5" },
  // V3-03: one turn of the grill interview (brief update + question, or a search).
  interview_v3: { reasoning: 1200, latencyMs: 30_000 },
  // V3-12 / V3-11: the page composer of a scenario and the signature sections (compose/, v3-harness-fixtures.ts).
  page_compose: { reasoning: 1200, latencyMs: 60_000 },
  signature_section: { reasoning: 1500, latencyMs: 90_000 },
  // V3-13: the visual critic — with screenshots the router keeps it on T0, the first vision model of the chain answers.
  critic_visual: { reasoning: 1500, latencyMs: 45_000, model: "kimi-k2.6" },
  // V3-15: the reviewer of the techreview — T0, another family than the builder (models.yaml#routes.techreview head).
  techreview: { reasoning: 1500, latencyMs: 60_000, model: "deepseek-v4-pro" },
} as const;
type Recorded = keyof typeof CALL_PROFILE;

export function fixtureLine(
  callType: Recorded,
  messages: LlmMessage[],
  tools: LlmTool[],
  call: { name: string; args: unknown } | readonly { name: string; args: unknown }[],
): FixtureLine {
  // V3-03: an answer may carry several tool calls (brief update and the question in one response).
  const calls = Array.isArray(call) ? call : [call as { name: string; args: unknown }];
  const route = ROUTES[callType];
  const p = CALL_PROFILE[callType];
  const model = "model" in p ? p.model : MODEL;
  return {
    v: 1,
    key: requestKey({
      callType,
      modelId: model,
      messages,
      tools,
      temperature: route.temperature,
      maxTokens: route.maxTokens,
    }),
    callType,
    modelId: model,
    request: {
      messages,
      tools: tools.map((t) => ({ name: t.name, schemaHash: schemaHash(t.parameters) })),
      params: { temperature: route.temperature, max_tokens: route.maxTokens },
    },
    response: {
      toolCalls: calls.map((c, i) => ({
        id: i === 0 ? `call_${callType}` : `call_${callType}_${i + 1}`,
        name: c.name,
        args: c.args as Record<string, unknown>,
      })),
      finishReason: "tool-calls",
    },
    usage: {
      promptTokens: estimateTokens(messages) + estimateTokens(tools),
      cachedPromptTokens: 0,
      completionTokens: calls.reduce((n, c) => n + estimateTokens(c.args), 0) + p.reasoning,
    },
    latencyMs: p.latencyMs,
    recordedAt: RECORDED_AT,
  };
}

/** The plan the build gets: finalized like the planner does and compiled (manifest versions written in). */
export function approvedPlan(sc: B2Scenario): SystemPlan {
  const r = compilePlan(finalizePlan(sc.plan, DEFAULT_REGISTRY), DEFAULT_REGISTRY);
  if (!r.ok) throw new Error(`${sc.name}: ${JSON.stringify(r.errors)}`);
  return r.plan;
}

/**
 * build_custom lines of a custom scenario (B2-23): the first round on the real prompt; a fix round on the same prompt
 * with a representative gate report (suite demo answers by order, the report text itself comes from the gates).
 */
function customLines(sc: B2CustomScenario): FixtureLine[] {
  const built = compilePlan(builtPlan(sc), DEFAULT_REGISTRY);
  if (!built.ok) throw new Error(`${sc.name}: ${JSON.stringify(built.errors)}`);
  const tool = defineTool({ name: "submit_custom", description: "custom", input: customInputSchema });
  const base = customMessages(built.plan, built.spec, built.customSlots);
  return sc.rounds.map((round, i) => {
    const slots = built.customSlots.filter((s) => round.items.some((it) => it.id === s.id));
    const check = {
      id: "G0-TS-01",
      status: "fail" as const,
      severity: "blocker" as const,
      message_ru: "Ошибка типов",
      file: slots[0]?.file ?? "",
    };
    const messages =
      i === 0 ? base : [...base, { role: "user" as const, content: customFixText("G0", [check], slots) }];
    return fixtureLine("build_custom", messages, [tool.definition], { name: "submit_custom", args: round });
  });
}

/** Fixture lines of a scenario: interview, system_plan, build_texts, build_design (+ build_custom of B2-23). */
export function fixtureLines(sc: B2Scenario | B2CustomScenario): FixtureLine[] {
  const reg = DEFAULT_REGISTRY;
  const goalsTool = defineTool({ name: "submit_goals", description: "goals", input: goalsAnalysisSchema });
  const planTool = defineTool({ name: "submit_plan", description: "plan", input: plannerPlanSchema });
  const textsTool = defineTool({ name: "submit_texts", description: "texts", input: textsInputSchema });
  const designTool = defineTool({
    name: "submit_design",
    description: "design",
    input: designInputSchema(reg),
  });
  const plan = approvedPlan(sc);
  const afterTexts = mergeTexts(plan, sc.texts);
  return [
    fixtureLine(
      "interview",
      interviewMessages(reg, sc.brief),
      [goalsTool.definition, reportCapabilityGapTool().definition],
      {
        name: "submit_goals",
        args: sc.analysis,
      },
    ),
    fixtureLine(
      "system_plan",
      plannerMessages(reg, {
        brief: sc.brief,
        analysis: sc.analysis,
        answers: [],
        edits: [],
        previousPlan: null,
      }),
      [planTool.definition],
      { name: "submit_plan", args: sc.plan },
    ),
    fixtureLine("build_texts", textsMessages(plan, reg), [textsTool.definition], {
      name: "submit_texts",
      args: sc.texts,
    }),
    fixtureLine("build_design", designMessages(afterTexts, reg), [designTool.definition], {
      name: "submit_design",
      args: sc.design,
    }),
    ...("rounds" in sc ? customLines(sc) : []),
  ];
}

export const serializeLines = (lines: readonly FixtureLine[]): string =>
  `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;

/** The plan after texts and design of a scenario (what the compiled system is built from). */
export function builtPlan(sc: B2Scenario): SystemPlan {
  return mergeDesign(mergeTexts(approvedPlan(sc), sc.texts), sc.design, DEFAULT_REGISTRY);
}
