import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  briefHash,
  canonicalRequest,
  createRouter,
  type FixtureLine,
  type LlmMessage,
  type LlmTool,
  loadAllowedBriefHashes,
  MemoryUsageSink,
  requestKey,
  schemaHash,
} from "../src/index.js";
import { type Stub, startStub } from "./stub-server.js";

const OPEN = { ruOnly: false, t1Restricted: false };
const ctx = { orgId: "00000000-0000-4000-8000-000000000001" };
const TOOLS: LlmTool[] = [{ name: "apply_ops", description: "Apply ops", parameters: { type: "object" } }];
const EVAL_BRIEF = (
  JSON.parse(
    readFileSync(
      new URL("../../../tools/eval/briefs/ev-01-forum-registration.json", import.meta.url),
      "utf8",
    ),
  ) as {
    text: string;
  }
).text;

let dir: string;
let stub: Stub;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "llm-fixtures-"));
  stub = await startStub();
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await stub.close();
});

const line = (callType: FixtureLine["callType"], text: string, tools: string[], key = "k"): FixtureLine => ({
  v: 1,
  key,
  callType,
  modelId: "glm-5.3",
  request: {
    messages: [],
    tools: tools.map((name) => ({ name, schemaHash: "x" })),
    params: { temperature: 0, max_tokens: 1 },
  },
  response: { text, toolCalls: [], finishReason: "stop" },
  usage: { promptTokens: 1000, cachedPromptTokens: 0, completionTokens: 100 },
  latencyMs: 5,
  recordedAt: "2026-09-30T00:00:00.000Z",
});

function writeFixture(suite: string, name: string, lines: FixtureLine[]): void {
  mkdirSync(join(dir, suite), { recursive: true });
  writeFileSync(join(dir, suite, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
}

const failingFetch: typeof fetch = () => {
  throw new Error("network must not be used in fixture mode");
};

describe("canonical request (eval.yaml#fixtures.canonical_request)", () => {
  test("sorted keys; uuid, dates, runId/systemId and trailing spaces normalized", () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const a = canonicalRequest({
      callType: "plan",
      modelId: "glm-5.3",
      messages: [
        {
          role: "user",
          content: `run ${runId} at 2026-09-30T10:00:00Z   \nid 22222222-2222-4222-8222-222222222222`,
        },
      ],
      tools: TOOLS,
      temperature: 0.2,
      maxTokens: 4000,
      runId,
    });
    expect(a).toContain("run <runId> at <date>\\nid <uuid:1>");
    expect(a.indexOf('"callType"')).toBeLessThan(a.indexOf('"max_tokens"'));
    expect(a).toContain(`"schemaHash":"${schemaHash({ type: "object" })}"`);
    const b = requestKey({
      callType: "plan",
      modelId: "glm-5.3",
      messages: [
        { role: "user", content: "run <runId> at 2031-01-01\nid 33333333-3333-4333-8333-333333333333" },
      ],
      tools: TOOLS,
      temperature: 0.2,
      maxTokens: 4000,
    });
    const c = requestKey({
      callType: "plan",
      modelId: "glm-5.3",
      messages: [
        {
          role: "user",
          content: "run <runId> at 2026-09-30T10:00:00Z   \nid 44444444-4444-4444-8444-444444444444",
        },
      ],
      tools: TOOLS,
      temperature: 0.2,
      maxTokens: 4000,
    });
    expect(b).toBe(c);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("fixture provider", () => {
  test("suite=demo: by (callType, ordinal), recorded tool calls must be offered; usage-based credits; no network", async () => {
    writeFixture("demo", "forum", [
      line("interview", "первый", ["ask"]),
      {
        ...line("plan", "план", ["submit_plan"]),
        response: { toolCalls: [{ id: "c1", name: "submit_plan", args: {} }], finishReason: "tool-calls" },
      },
      line("interview", "второй", ["ask"]),
    ]);
    const sink = new MemoryUsageSink();
    const router = createRouter({
      mode: "fixture",
      fixture: { suite: "demo", name: "forum", dir },
      sink,
      env: {},
      fetch: failingFetch,
    });
    const ask: LlmTool[] = [{ name: "ask", description: "", parameters: {} }];
    const r1 = await router.route({
      callType: "interview",
      messages: [{ role: "user", content: "a" }],
      tools: ask,
      orgPolicy: OPEN,
      ctx,
    });
    const r2 = await router.route({
      callType: "interview",
      messages: [{ role: "user", content: "b" }],
      tools: ask,
      orgPolicy: OPEN,
      ctx,
    });
    expect([r1.result.text, r2.result.text]).toEqual(["первый", "второй"]);
    expect(r1.tier).toBe("T1");
    expect(sink.records[0]).toMatchObject({
      mode: "fixture",
      inputTokens: 1000,
      outputTokens: 100,
      billable: true,
    });
    expect(r1.creditsMilli).toBeGreaterThan(0);
    // the recorded answer calls submit_plan, which is not offered → miss
    await expect(
      router.route({
        callType: "plan",
        messages: [{ role: "user", content: "c" }],
        tools: ask,
        orgPolicy: OPEN,
        ctx,
      }),
    ).rejects.toMatchObject({ code: "FIXTURE_MISS" });
    // exhausted → miss
    await expect(
      router.route({
        callType: "interview",
        messages: [{ role: "user", content: "d" }],
        tools: ask,
        orgPolicy: OPEN,
        ctx,
      }),
    ).rejects.toMatchObject({ code: "FIXTURE_MISS", details: { callType: "interview", lastMessage: "d" } });
  });

  test("free (B2-02 demo replay): recorded answers cost 0 ₽ and no credits; free needs fixture mode", async () => {
    writeFixture("demo", "free", [line("interview", "записано", ["ask"])]);
    const sink = new MemoryUsageSink();
    const router = createRouter({
      mode: "fixture",
      free: true,
      fixture: { suite: "demo", name: "free", dir },
      sink,
      env: {},
      fetch: failingFetch,
    });
    const r = await router.route({
      callType: "interview",
      messages: [{ role: "user", content: "a" }],
      tools: [{ name: "ask", description: "", parameters: {} }],
      orgPolicy: OPEN,
      ctx,
    });
    expect(r.result.text).toBe("записано");
    expect([r.creditsMilli, r.creditsCharged]).toEqual([0, 0]);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      mode: "fixture",
      costRub: 0,
      creditsMilli: 0,
      inputTokens: 1000,
    });
    expect(() => createRouter({ mode: "live", free: true, sink, env: {} })).toThrow(/free routing/);
  });

  test("suite=unit: by sha256 key in record order; miss → FIXTURE_MISS without network; lenient mode", async () => {
    const messages: LlmMessage[] = [{ role: "user", content: "Собери форму" }];
    const key = requestKey({
      callType: "plan",
      modelId: "glm-5.3",
      messages,
      temperature: 0.2,
      maxTokens: 4000,
    });
    writeFixture("unit", "k", [
      line("plan", "раз", [], key),
      line("plan", "два", [], key),
      line("card", "карта", [], "other"),
    ]);
    const mk = (lenient: boolean) =>
      createRouter({
        mode: "fixture",
        fixture: { suite: "unit", name: "k", dir, lenient },
        sink: new MemoryUsageSink(),
        env: {},
        fetch: failingFetch,
      });
    const router = mk(false);
    expect((await router.route({ callType: "plan", messages, orgPolicy: OPEN, ctx })).result.text).toBe(
      "раз",
    );
    expect((await router.route({ callType: "plan", messages, orgPolicy: OPEN, ctx })).result.text).toBe(
      "два",
    );
    const miss = router.route({
      callType: "card",
      messages: [{ role: "user", content: "x".repeat(500) }],
      orgPolicy: OPEN,
      ctx,
    });
    await expect(miss).rejects.toMatchObject({ code: "FIXTURE_MISS" });
    await miss.catch((e: { details: { lastMessage: string } }) =>
      expect(e.details.lastMessage.length).toBe(200),
    );
    const lenient = mk(true);
    expect(
      (
        await lenient.route({
          callType: "card",
          messages: [{ role: "user", content: "?" }],
          orgPolicy: OPEN,
          ctx,
        })
      ).result.text,
    ).toBe("карта");
  });

  test("routing works identically in fixture mode (T0 for forbidden callTypes)", async () => {
    const messages: LlmMessage[] = [{ role: "user", content: "Поддержка" }];
    const key = requestKey({
      callType: "support",
      modelId: "kimi-k2.6",
      messages,
      temperature: 0.2,
      maxTokens: 4000,
    });
    writeFixture("unit", "support", [{ ...line("support", "ok", [], key), modelId: "kimi-k2.6" }]);
    const router = createRouter({
      mode: "fixture",
      fixture: { suite: "unit", name: "support", dir },
      sink: new MemoryUsageSink(),
      env: {},
    });
    const out = await router.route({ callType: "support", messages, orgPolicy: OPEN, ctx });
    expect([out.tier, out.model, out.routeReason]).toEqual(["T0", "kimi-k2.6", "callType_forbidden_T1"]);
  });
});

describe("record mode (eval.yaml#fixtures.rules, L3-07)", () => {
  test("refuses briefs that are not in tools/eval/briefs or demo", () => {
    expect(() =>
      createRouter({
        mode: "record",
        fixture: { suite: "eval", name: "x", dir, brief: "Произвольный бриф партнёра" },
        env: {},
      }),
    ).toThrow(expect.objectContaining({ code: "RECORD_NOT_ALLOWED" }));
    expect(() =>
      createRouter({ mode: "record", fixture: { suite: "eval", name: "x", dir }, env: {} }),
    ).toThrow(expect.objectContaining({ code: "RECORD_NOT_ALLOWED" }));
    expect(loadAllowedBriefHashes().has(briefHash(EVAL_BRIEF))).toBe(true);
  });

  test("appends tools/fixtures/<suite>/<name>.jsonl; T0 requests stored after scrub; replay by the scrubbed key", async () => {
    const recorder = createRouter({
      mode: "record",
      fixture: { suite: "eval", name: "ev-01", dir, brief: EVAL_BRIEF },
      env: stub.env(),
      sink: new MemoryUsageSink(),
      sleep: async () => {},
    });
    const messages: LlmMessage[] = [
      { role: "user", content: `${EVAL_BRIEF}\nКонтакт: rec.canary@example.ru, +7 916 555-44-33` },
    ];
    // interview with PII → T0; the request still goes out raw to T0, but the fixture keeps only the scrubbed form.
    const live = await recorder.route({
      callType: "interview",
      messages,
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    expect(live.tier).toBe("T0");
    expect(stub.requests.at(-1)?.raw).toContain("rec.canary@example.ru");
    const file = readFileSync(join(dir, "eval", "ev-01.jsonl"), "utf8");
    expect(file).not.toContain("rec.canary@example.ru");
    expect(file).not.toContain("555-44-33");
    expect(file).not.toMatch(/test-cloudru|authorization/i);
    const rec = JSON.parse(file.trim()) as FixtureLine;
    expect(rec).toMatchObject({ v: 1, callType: "interview", modelId: "glm-5.1" });
    expect(JSON.stringify(rec.request.messages)).toContain("[EMAIL_1]");
    expect(rec.usage).toEqual({ promptTokens: 1000, cachedPromptTokens: 400, completionTokens: 200 });

    const replay = createRouter({
      mode: "fixture",
      fixture: { suite: "eval", name: "ev-01", dir },
      sink: new MemoryUsageSink(),
      env: {},
      fetch: failingFetch,
    });
    const out = await replay.route({ callType: "interview", messages, tools: TOOLS, orgPolicy: OPEN, ctx });
    expect(out.result).toEqual(live.result);
    expect(out.creditsMilli).toBe(live.creditsMilli);
  });
});
