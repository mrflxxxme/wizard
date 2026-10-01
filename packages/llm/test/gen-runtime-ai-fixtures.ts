// Generates tools/fixtures/unit/runtime-ai.jsonl (suite=unit, lookup by request key — eval.yaml#fixtures.lookup) from
// tools/fixtures/unit/runtime-ai.scenarios.json: the request is built by the same runtimeAiMessages/fillFieldsTool the
// platform sends, the model is the first T0 model of the route. AI actions run on real records, so the record mode of
// the router (repository briefs only) does not apply: the answers are scripted here (AGENTS.md: fixtures by script).
// Run: pnpm --filter @wizard/platform-api exec tsx ../../packages/llm/test/gen-runtime-ai-fixtures.ts
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRegistry,
  type FixtureLine,
  fillFieldsTool,
  type LlmAttachment,
  type LlmResult,
  type RuntimeAiAction,
  requestKey,
  runtimeAiCallType,
  runtimeAiMessages,
  schemaHash,
  withoutAttachmentBytes,
} from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const SCENARIOS_PATH = join(ROOT, "tools/fixtures/unit/runtime-ai.scenarios.json");
export const FIXTURE_PATH = join(ROOT, "tools/fixtures/unit/runtime-ai.jsonl");

export interface Scenario {
  name: string;
  action: RuntimeAiAction;
  record: { label: string; value: string }[];
  attachments?: { mime: LlmAttachment["mime"]; png?: boolean }[];
  response: LlmResult;
  usage: FixtureLine["usage"];
}

export interface ScenarioFile {
  png: string;
  scenarios: Scenario[];
}

export const loadScenarios = (): ScenarioFile =>
  JSON.parse(readFileSync(SCENARIOS_PATH, "utf8")) as ScenarioFile;

export function scenarioAttachments(f: ScenarioFile, s: Scenario): LlmAttachment[] | undefined {
  return s.attachments?.map((a) => ({ mime: a.mime, data: f.png }));
}

export function buildLines(f: ScenarioFile = loadScenarios()): FixtureLine[] {
  const reg = createRegistry({ buildDefaultTier: "T1" });
  return f.scenarios.map((s) => {
    const callType = runtimeAiCallType(s.action.kind);
    const route = reg.routes[callType];
    const modelId = route.chain.T0?.[0] as string;
    const attachments = scenarioAttachments(f, s);
    const messages = runtimeAiMessages({
      action: s.action,
      record: s.record,
      ...(attachments ? { attachments } : {}),
    });
    const tools = s.action.kind === "extract" ? [fillFieldsTool(s.action.outputs)] : [];
    const key = requestKey({
      callType,
      modelId,
      messages,
      tools,
      temperature: route.temperature,
      maxTokens: route.maxTokens,
    });
    return {
      v: 1,
      key,
      callType,
      modelId,
      request: {
        messages: withoutAttachmentBytes(messages),
        tools: tools.map((t) => ({ name: t.name, schemaHash: schemaHash(t.parameters) })),
        params: { temperature: route.temperature, max_tokens: route.maxTokens },
      },
      response: s.response,
      usage: s.usage,
      latencyMs: 800,
      recordedAt: "2026-10-01T00:00:00.000Z",
    };
  });
}

export const serialize = (lines: FixtureLine[]): string =>
  lines.map((l) => `${JSON.stringify(l)}\n`).join("");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(FIXTURE_PATH, serialize(buildLines()));
  console.log(`written ${FIXTURE_PATH}`);
}
