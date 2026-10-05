// FU-1: packages/llm reads the golden fixtures (M0-21 forum, M0-22 bakery) byte-compatibly and its canonical key matches the reference
// implementation tools/fixtures/lib/format.mjs (contract: docs/reviews/impl-notes/M0-21.md).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  type CanonicalInput,
  canonicalRequest,
  createRouter,
  type FixtureLine,
  type LlmMessage,
  type LlmTool,
  MemoryUsageSink,
  requestKey,
  schemaHash,
} from "../src/index.js";

interface RefRequest {
  messages: readonly LlmMessage[];
  tools: { name: string; schemaHash: string }[];
  params: { temperature: number; max_tokens: number };
}
interface RefLine {
  callType: string;
  modelId: string;
  request: RefRequest;
}
interface RefFormat {
  canonicalRequest(line: RefLine, ctx?: { runId?: string; systemId?: string }): string;
  fixtureKey(line: RefLine, ctx?: { runId?: string; systemId?: string }): string;
}
const ref = (await import(
  new URL("../../../tools/fixtures/lib/format.mjs", import.meta.url).href
)) as RefFormat;

const load = (name: string) => {
  const raw = readFileSync(new URL(`../../../tools/fixtures/demo/${name}.jsonl`, import.meta.url), "utf8");
  const rawLines = raw.split("\n").filter((l) => l !== "");
  return { rawLines, golden: rawLines.map((l) => JSON.parse(l) as FixtureLine) };
};
/** Golden demo fixtures: M0-21 forum (12 calls), M0-22 bakery (10 calls). */
const SUITES = [
  { name: "forum", count: 21, ...load("forum") },
  { name: "bakery", count: 21, ...load("bakery") },
];
const GOLDEN = SUITES.flatMap((suite) => suite.golden);

const OPEN = { ruOnly: false, t1Restricted: false };
const ctx = {
  orgId: "00000000-0000-4000-8000-000000000001",
  runId: "0f0e0d0c-0b0a-4908-8706-050403020100",
  systemId: "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a",
};
const offered = (line: FixtureLine): LlmTool[] =>
  line.request.tools.map((t) => ({ name: t.name, description: t.name, parameters: { type: "object" } }));
const failingFetch: typeof fetch = () => {
  throw new Error("network must not be used in fixture mode");
};

describe.each(SUITES)(
  "golden fixture tools/fixtures/demo/$name (jsonl)",
  ({ name, count, rawLines, golden }) => {
    test("file format: all lines, v=1, keys in contract order, lossless JSON round trip", () => {
      expect(golden).toHaveLength(count);
      golden.forEach((line, i) => {
        expect(JSON.stringify(line)).toBe(rawLines[i]);
        expect(Object.keys(line)).toEqual([
          "v",
          "key",
          "callType",
          "modelId",
          "request",
          "response",
          "usage",
          "latencyMs",
          "recordedAt",
        ]);
        expect(line.v).toBe(1);
        expect(line.key).toMatch(/^[0-9a-f]{64}$/);
        expect(line.response.finishReason).toBe(line.response.toolCalls.length > 0 ? "tool-calls" : "stop");
      });
    });

    test("route() replays all calls in fixture mode with WIZARD_FIXTURE=demo/<name>", async () => {
      const sink = new MemoryUsageSink();
      const router = createRouter({ env: { WIZARD_FIXTURE: `demo/${name}` }, sink, fetch: failingFetch });
      expect(router.mode).toBe("fixture");
      for (const line of golden) {
        const out = await router.route({
          callType: line.callType,
          messages: line.request.messages,
          tools: offered(line),
          orgPolicy: OPEN,
          ctx,
        });
        expect(JSON.stringify(out.result)).toBe(JSON.stringify(line.response));
        expect(out.usage).toEqual({
          inputTokens: line.usage.promptTokens,
          cachedTokens: line.usage.cachedPromptTokens,
          outputTokens: line.usage.completionTokens,
        });
      }
      expect(sink.records).toHaveLength(count);
      expect(sink.records.map((r) => r.callType)).toEqual(golden.map((l) => l.callType));
      expect(sink.records.every((r) => r.status === "ok" && r.latencyMs > 0)).toBe(true);
      // All lines are consumed: one more call of any callType is a miss.
      const first = golden[0] as FixtureLine;
      await expect(
        router.route({
          callType: "interview",
          messages: first.request.messages,
          tools: offered(first),
          orgPolicy: OPEN,
          ctx,
        }),
      ).rejects.toMatchObject({ code: "FIXTURE_MISS" });
    });

    test("demo lookup: a recorded tool call that is not offered now is a miss; extra offered tools are fine", async () => {
      const router = createRouter({ env: { WIZARD_FIXTURE: `demo/${name}` }, sink: new MemoryUsageSink() });
      const first = golden[0] as FixtureLine;
      const extra: LlmTool[] = [
        ...offered(first),
        { name: "ask_questions", description: "", parameters: {} },
      ];
      const out = await router.route({
        callType: "interview",
        messages: [],
        tools: extra,
        orgPolicy: OPEN,
        ctx,
      });
      expect(out.result.toolCalls.map((c) => c.name)).toEqual(["submit_analysis"]);
      await expect(
        router.route({ callType: "interview", messages: [], tools: [], orgPolicy: OPEN, ctx }),
      ).rejects.toMatchObject({ code: "FIXTURE_MISS" });
    });
  },
);

describe("canonical key = reference tools/fixtures/lib/format.mjs (eval|unit suites)", () => {
  const toRef = (input: CanonicalInput): RefLine => ({
    callType: input.callType,
    modelId: input.modelId,
    request: {
      messages: input.messages,
      tools: (input.tools ?? []).map((t) => ({
        name: t.name,
        schemaHash: "schemaHash" in t ? t.schemaHash : schemaHash(t.parameters),
      })),
      params: { temperature: input.temperature, max_tokens: input.maxTokens },
    },
  });
  const refCtx = (input: CanonicalInput) => ({ runId: input.runId, systemId: input.systemId });

  test("golden lines: requestKey = recorded key = reference key", () => {
    for (const line of GOLDEN) {
      const input: CanonicalInput = {
        callType: line.callType,
        modelId: line.modelId,
        messages: line.request.messages,
        tools: line.request.tools,
        temperature: line.request.params.temperature,
        maxTokens: line.request.params.max_tokens,
      };
      expect(requestKey(input)).toBe(line.key);
      expect(ref.fixtureKey(line)).toBe(line.key);
    }
  });

  const runId = "0F0E0D0C-0B0A-4908-8706-050403020100";
  const systemId = "sys-forum-1";
  const TOOLS: LlmTool[] = [
    {
      name: "apply_ops",
      description: "Apply ops",
      parameters: { type: "object", properties: { b: {}, a: {} } },
    },
    { name: "write_file", description: "Write", parameters: { required: ["path"], type: "object" } },
  ];
  const samples: Array<[string, CanonicalInput]> = [
    [
      "uuids (any case), dates, runId/systemId, trailing spaces and tabs",
      {
        callType: "build_ops",
        modelId: "glm-5.3",
        messages: [
          {
            role: "system",
            content: "Ты строитель.  \t\nsystem sys-forum-1, run 0F0E0D0C-0B0A-4908-8706-050403020100\t",
          },
          {
            role: "user",
            content:
              "id 3f2504e0-4f89-41d3-9a0c-0305e82c3301 и 3F2504E0-4F89-41D3-9A0C-0305E82C3301, 2026-09-30, 2026-09-30T10:15:00.123+03:00 ",
          },
        ],
        tools: TOOLS,
        temperature: 0.2,
        maxTokens: 8000,
        runId,
        systemId,
      },
    ],
    [
      "word boundaries: dates/uuids glued to letters or after an escaped newline stay as is",
      {
        callType: "fix",
        modelId: "glm-5.3",
        messages: [
          {
            role: "user",
            content:
              'Дата:\n2026-09-30\nv2026-01-01 x3f2504e0-4f89-41d3-9a0c-0305e82c3301\t\n"2026-09-30T00:00Z"\r\n\\2026-02-02',
          },
        ],
        temperature: 0,
        maxTokens: 4000,
      },
    ],
    [
      "tool calls and tool results with nested objects, unsorted keys and undefined fields",
      {
        callType: "build_code",
        modelId: "deepseek-v4-flash",
        messages: [
          { role: "user", content: "Собери экран" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_1",
                name: "write_file",
                args: {
                  z: 1,
                  path: "src/a.ts",
                  body: "created 2026-09-30 by 0f0e0d0c-0b0a-4908-8706-050403020100  ",
                },
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
            toolName: "write_file",
            content: {
              ok: true,
              meta: {
                when: "2026-09-30T10:00:00Z",
                ref: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                skip: undefined,
              },
              list: [3, "b ", null],
            },
          },
          { role: "assistant", content: "готово" },
        ],
        tools: TOOLS,
        temperature: 0.2,
        maxTokens: 8000,
        runId,
      },
    ],
    [
      "precomputed schemaHash, unicode and empty messages",
      {
        callType: "qa_generate",
        modelId: "glm-5.3",
        messages: [{ role: "user", content: "Проверь «форму» — 😀   конец" }],
        tools: [{ name: "submit_checks", schemaHash: "golden" }],
        temperature: 0.1,
        maxTokens: 2000,
      },
    ],
  ];

  test.each(samples)("%s", (_name, input) => {
    expect(canonicalRequest(input)).toBe(ref.canonicalRequest(toRef(input), refCtx(input)));
    expect(requestKey(input)).toBe(ref.fixtureKey(toRef(input), refCtx(input)));
  });
});
