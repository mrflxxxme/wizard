// M3-02 (runtime.yaml#ai_actions, data-boundary.yaml#tests «runtime_ai_*, support: при любых входах tier=T0»,
// models.yaml#credits.runtime_ai): AI actions never reach T1 — by the policy, by the router guard even under a
// registry that routes them to T1, and by routeRuntimeAi's own check; multimodal calls are T0 only; generate output is
// plain text; the fixture file is the generator's output.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  assertTierAllowed,
  createRegistry,
  createRouter,
  decideTier,
  type LlmMessage,
  MemoryUsageSink,
  normalizeAiValue,
  type OrgPolicy,
  type Registry,
  type RouteOutput,
  type Router,
  routeRuntimeAi,
  runtimeAiMessages,
  toPlainText,
} from "../src/index.js";
import {
  buildLines,
  FIXTURE_PATH,
  loadScenarios,
  scenarioAttachments,
  serialize,
} from "./gen-runtime-ai-fixtures.js";

const ORG = "00000000-0000-4000-8000-0000000000c1";
const SYSTEM = "00000000-0000-4000-8000-0000000000c2";
const ENV = {
  ZAI_BASE_URL: "http://mock.local/zai",
  ZAI_API_KEY: "k",
  CLOUDRU_BASE_URL: "http://mock.local/cloudru",
  CLOUDRU_API_KEY: "k",
  YANDEX_API_KEY: "k",
  YANDEX_FOLDER_ID: "f",
};
const RUNTIME = ["runtime_ai_extract", "runtime_ai_generate"] as const;
const POLICIES: (OrgPolicy | null | undefined)[] = [
  undefined,
  null,
  { ruOnly: false, t1Restricted: false },
  { ruOnly: true, t1Restricted: false },
  { ruOnly: false, t1Restricted: true },
  { ruOnly: false, t1Restricted: null },
];
const HINTS = [undefined, false, true] as const;
const PAYLOADS = ["Опиши заказ", "Клиент: Иван Петров, +7 916 123-45-67, паспорт 4510 123456"];
const file = loadScenarios();
const byName = (n: string) => {
  const s = file.scenarios.find((x) => x.name === n);
  if (!s) throw new Error(n);
  return s;
};

/** OpenAI-compatible mock: records every request; T1 (zai) and T0 (cloudru, yandex) answer at once. */
function mockFetch(answer: (body: Record<string, unknown>) => Record<string, unknown>) {
  const calls: { provider: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ provider: u.includes("/zai") ? "zai" : u.includes("cloudru") ? "cloudru" : "yandex", body });
    return new Response(
      JSON.stringify({
        id: "c",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: answer(body), finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** A registry that (wrongly) routes the runtime AI calls to T1 first: the router must still never call T1. */
function hostileRegistry(): Registry {
  const reg = createRegistry({ buildDefaultTier: "T1" });
  const t1 = { defaultTier: "T1" as const };
  return {
    ...reg,
    routes: {
      ...reg.routes,
      runtime_ai_extract: {
        ...reg.routes.runtime_ai_extract,
        ...t1,
        chain: { T1: ["glm-5.3"], T0: ["glm-5.3", "gpt-oss-120b"] },
      },
      runtime_ai_generate: {
        ...reg.routes.runtime_ai_generate,
        ...t1,
        chain: { T1: ["glm-5.3"], T0: ["gigachat-3.5"] },
      },
    },
  };
}

describe("tier: runtime AI actions are T0 only", () => {
  test("decideTier: each runtime_ai_* × org policy × containsPiiHint × payload → T0", () => {
    const reg = createRegistry({ buildDefaultTier: "T1" });
    let n = 0;
    for (const callType of RUNTIME)
      for (const orgPolicy of POLICIES)
        for (const containsPiiHint of HINTS)
          for (const text of PAYLOADS) {
            const d = decideTier(
              {
                callType,
                messages: [{ role: "user", content: text }],
                ...(containsPiiHint !== undefined ? { containsPiiHint } : {}),
                ...(orgPolicy !== undefined ? { orgPolicy } : {}),
              },
              reg,
            );
            expect(d.tier, `${callType} ${JSON.stringify(orgPolicy)} ${containsPiiHint}`).toBe("T0");
            n++;
          }
    expect(n).toBe(2 * 6 * 3 * 2);
  });

  test("router under a registry routing them to T1: 0 requests to T1, the answer comes from T0", async () => {
    const m = mockFetch((body) =>
      body.tools
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "fill_fields", arguments: JSON.stringify({ category: "billing" }) },
              },
            ],
          }
        : { role: "assistant", content: "Готово" },
    );
    const sink = new MemoryUsageSink();
    const router = createRouter({
      mode: "live",
      env: ENV,
      fetch: m.fetch,
      registry: hostileRegistry(),
      sink,
      sleep: async () => {},
    });
    for (const name of ["classify_payment", "reply_payment"]) {
      const s = byName(name);
      const out = await routeRuntimeAi(router, {
        action: s.action,
        record: s.record,
        orgPolicy: { ruOnly: false, t1Restricted: false },
        ctx: { orgId: ORG, systemId: SYSTEM },
      });
      expect(out.tier).toBe("T0");
    }
    expect(m.calls.filter((c) => c.provider === "zai")).toHaveLength(0);
    expect(sink.records.length).toBeGreaterThan(0);
    for (const r of sink.records) {
      expect(r.tier).toBe("T0");
      expect(["runtime_ai_extract", "runtime_ai_generate"]).toContain(r.callType);
    }
  });

  test("guard: a T1 attempt of a T0-only call throws T1_FORBIDDEN before any request", () => {
    const msgs: LlmMessage[] = [{ role: "user", content: "x" }];
    for (const ct of [...RUNTIME, "support"] as const)
      expect(() => assertTierAllowed(ct, "T1", msgs)).toThrowError(/только на моделях в РФ/);
    expect(() => assertTierAllowed("runtime_ai_extract", "T0", msgs)).not.toThrow();
    expect(() => assertTierAllowed("interview", "T1", msgs)).not.toThrow();
  });

  test("routeRuntimeAi refuses a T1 answer (defence in depth): no values come back", async () => {
    const s = byName("reply_payment");
    const fake: Pick<Router, "route"> = {
      route: async () =>
        ({
          tier: "T1",
          model: "glm-5.3",
          result: { text: "секрет", toolCalls: [], finishReason: "stop" },
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
          creditsCharged: 0,
          creditsMilli: 0,
          routeReason: "default_T1",
          scrubbed: true,
          ruFallback: false,
        }) satisfies RouteOutput,
    };
    await expect(
      routeRuntimeAi(fake, { action: s.action, record: s.record, ctx: { orgId: ORG } }),
    ).rejects.toMatchObject({ code: "T1_FORBIDDEN" });
  });
});

describe("multimodal: images and PDF only on T0", () => {
  const png = file.png;
  const withImage: LlmMessage[] = [
    { role: "user", content: "Что на фото?", attachments: [{ mime: "image/png", data: png }] },
  ];

  test("decideTier: an attachment forces T0 for any callType and policy (pii_hint)", () => {
    const reg = createRegistry({ buildDefaultTier: "T1" });
    for (const callType of ["interview", "build_code", "qa_explain", "import_mapping"] as const) {
      const d = decideTier(
        {
          callType,
          messages: withImage,
          containsPiiHint: false,
          orgPolicy: { ruOnly: false, t1Restricted: false },
        },
        reg,
      );
      expect(d.tier, callType).toBe("T0");
      expect(() => assertTierAllowed(callType, "T1", withImage)).toThrowError(/только на моделях в РФ/);
    }
  });

  test("live: the image goes to the T0 provider as image_url, a PDF as a file part; nothing to T1", async () => {
    const m = mockFetch(() => ({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "fill_fields", arguments: '{"serial":"SN-1"}' } },
      ],
    }));
    const router = createRouter({ mode: "live", env: ENV, fetch: m.fetch, sink: new MemoryUsageSink() });
    const s = byName("photo_serial");
    const out = await routeRuntimeAi(router, {
      action: s.action,
      record: s.record,
      attachments: [
        { mime: "image/png", data: png },
        { mime: "application/pdf", data: Buffer.from("%PDF-1.4\n").toString("base64") },
      ],
      ctx: { orgId: ORG },
    });
    expect(out.tier).toBe("T0");
    expect(out.values).toEqual({ serial: "SN-1" });
    expect(m.calls.every((c) => c.provider !== "zai")).toBe(true);
    const parts = JSON.stringify(m.calls[0]?.body.messages);
    expect(parts).toContain(`data:image/png;base64,${png}`);
    expect(parts).toContain("data:application/pdf;base64,");
  });

  test("fixture key and stored line never hold the file bytes", () => {
    const line = buildLines().find((l) => JSON.stringify(l.request).includes("image/png"));
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).not.toContain(png);
    expect(JSON.stringify(line)).toMatch(/sha256:[0-9a-f]{64}/);
  });
});

describe("fixture mode (no network): tools/fixtures/unit/runtime-ai.jsonl", () => {
  test("the committed fixture file is the generator's output", () => {
    expect(readFileSync(FIXTURE_PATH, "utf8")).toBe(serialize(buildLines()));
  });

  const router = () =>
    createRouter({
      mode: "fixture",
      env: {},
      fixture: { suite: "unit", name: "runtime-ai" },
      sink: new MemoryUsageSink(),
      fetch: (() => {
        throw new Error("network in fixture mode");
      }) as unknown as typeof globalThis.fetch,
    });

  test("extract: values normalized to the target fields (enum by label, out-of-range int dropped)", async () => {
    const r = router();
    const a = byName("classify_payment");
    const out = await routeRuntimeAi(r, { action: a.action, record: a.record, ctx: { orgId: ORG } });
    expect(out).toMatchObject({
      tier: "T0",
      model: "gpt-oss-120b",
      values: { category: "billing", priority: 2 },
    });
    expect(out.creditsMilli).toBeGreaterThan(0);
    const b = byName("classify_login");
    const out2 = await routeRuntimeAi(r, { action: b.action, record: b.record, ctx: { orgId: ORG } });
    expect(out2.values).toEqual({ category: "tech" });
    expect(out2.skipped).toEqual(["priority"]);
  });

  test("generate: the text is plain text — markup kept verbatim as characters, never interpreted", async () => {
    const a = byName("reply_payment");
    const out = await routeRuntimeAi(router(), { action: a.action, record: a.record, ctx: { orgId: ORG } });
    expect(out.tier).toBe("T0");
    expect(out.values.reply).toBe(a.response.text);
  });

  test("multimodal extract from the fixture (attachment keyed by hash)", async () => {
    const a = byName("photo_serial");
    const attachments = scenarioAttachments(file, a);
    const out = await routeRuntimeAi(router(), {
      action: a.action,
      record: a.record,
      ...(attachments ? { attachments } : {}),
      ctx: { orgId: ORG },
    });
    expect(out.values).toEqual({ serial: "SN-12345" });
  });
});

describe("plain text and values", () => {
  test("toPlainText: control characters out, fences and quotes dropped, length cut", () => {
    expect(toPlainText("```\nПривет\n```")).toBe("Привет");
    expect(toPlainText("«Готово»")).toBe("Готово");
    expect(toPlainText("a\u0000b\r\nc")).toBe("ab\nc");
    expect(toPlainText("<b>жирный</b>")).toBe("<b>жирный</b>");
    expect(toPlainText("абвгд", 3)).toBe("абв");
  });

  test("normalizeAiValue per field type", () => {
    expect(normalizeAiValue({ name: "d", label: "Дата", type: "date" }, "2026-02-30")).toBeUndefined();
    expect(normalizeAiValue({ name: "d", label: "Дата", type: "date" }, "2026-02-28")).toBe("2026-02-28");
    expect(normalizeAiValue({ name: "m", label: "Сумма", type: "money" }, "1 200,456")).toBe(1200.46);
    expect(normalizeAiValue({ name: "b", label: "Флаг", type: "bool" }, "да")).toBe(true);
    expect(
      normalizeAiValue({ name: "u", label: "Сайт", type: "url" }, "javascript:alert(1)"),
    ).toBeUndefined();
    expect(normalizeAiValue({ name: "e", label: "Почта", type: "email" }, "a@b.ru")).toBe("a@b.ru");
  });

  test("messages carry labels and values as data; attachments only on the user message", () => {
    const a = byName("photo_serial");
    const msgs = runtimeAiMessages({
      action: a.action,
      record: a.record,
      attachments: scenarioAttachments(file, a),
    });
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[1]).toMatchObject({ role: "user", attachments: [{ mime: "image/png" }] });
    expect(JSON.parse((msgs[1] as { content: string }).content)).toMatchObject({
      action: "read_photo",
      record: { Тема: "Не включается терминал" },
    });
  });
});
