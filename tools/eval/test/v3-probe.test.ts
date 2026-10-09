// V3-18: the probe of the v3 route heads (tools/eval/server/probe.mjs) without network and money — the heads and prices
// equal the registry of @wizard/llm (models.yaml), the expected ₽ under the 30 ₽ cap, the pod script's settings and
// validation, the cap stop and the report; probeMain against the real router of @wizard/llm with in-process answers.
// The shape probe (probe-shape.mjs): its request content equals the real prompts and tools of @wizard/agents, the
// images are the shot plan's sizes, the direct diagnostic body equals the gateway's request, shapeMain against the real
// router with a provider that refuses several images (the direct call, masking, the variants of analysis), the cap.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  critiqueTool,
  type SiteModel,
  shotPlan,
  submitTechreview,
} from "../../../packages/agents/src/builder/index.ts";
import { looseObject } from "../../../packages/agents/src/core/loose-json.ts";
import * as llmNs from "../../../packages/llm/src/index.ts";
import {
  CircuitBreaker,
  chatCall,
  createRegistry,
  createRouter,
  estimateInputTokens,
  imageSize,
  type LlmMessage,
  transformBody,
} from "../../../packages/llm/src/index.ts";
import {
  expectedCallRub,
  expectedProbeRub,
  PROBE_CALL_TYPES,
  PROBE_HEADS,
  PROBE_MAX_CAP_RUB,
  parseProbeOutput,
  probeAnnotations,
  probeMain,
  probeScript,
  probeSpendSql,
  renderProbeReport,
} from "../server/probe.mjs";
import {
  expectedShapeRub,
  loadShapeFixture,
  looseJson,
  parseShapeGroups,
  parseShapeOutput,
  renderShapeReport,
  SHAPE_CALL_TYPES,
  SHAPE_CHAINS,
  SHAPE_GROUPS,
  SHAPE_JSON_RULE,
  SHAPE_MODELS,
  SHAPE_ROUTES,
  SHAPE_SHORT,
  SHAPE_VARIANTS,
  shapeAnnotations,
  shapeConfig,
  shapeMain,
  shapeMessages,
  shapePlan,
  shapeScript,
  shapeTokens,
} from "../server/probe-shape.mjs";
import { openAiBody, providerCall } from "../server/provider-call.mjs";
import { SHAPE_PROMPTS_PATH, shapeImages, shapePrompts } from "./probe-shape-fixture.ts";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("v3 probe: heads, prices, the expected ₽", () => {
  test("every v3 call type has its head: the first model of the route's chain at its tier, prices as in models.yaml", () => {
    const reg = createRegistry({ buildDefaultTier: "T1" }, {});
    for (const t of PROBE_CALL_TYPES) {
      const head = PROBE_HEADS[t as keyof typeof PROBE_HEADS];
      const route = reg.routes[t as keyof typeof reg.routes];
      expect(route, t).toBeDefined();
      expect(route.chain[head.tier as "T0" | "T1"]?.[0], t).toBe(head.model);
      const model = reg.models.find((m) => m.id === head.model);
      expect(model?.price.input, t).toBe(head.price.input);
      expect(model?.price.output, t).toBe(head.price.output);
    }
  });

  test("the whole probe is expected well under its cap; research only when live", () => {
    expect(expectedCallRub("interview_v3")).toBeCloseTo((300 * 162 + 1000 * 510) / 1e6, 3);
    expect(expectedCallRub("research")).toBeLessThan(0.05);
    const all = expectedProbeRub();
    expect(all).toBeGreaterThan(1);
    expect(all).toBeLessThan(PROBE_MAX_CAP_RUB / 5);
    expect(expectedProbeRub({ research: false })).toBeLessThan(all);
  });
});

describe("v3 probe: the pod script and its output", () => {
  test("the script: imports of the worker image, the settings as JSON, no secret; refusals in Russian", () => {
    const s = probeScript({ orgId: ORG, capRub: 30 });
    expect(s.split("\n").slice(0, 2)).toEqual([
      'import { CircuitBreaker, createRegistry, createRouter } from "@wizard/llm";',
      'import postgres from "postgres";',
    ]);
    expect(s).toContain(`"orgId":"${ORG}"`);
    expect(s).toContain('"capRub":30');
    expect(s).toContain('"fake":false');
    expect(s).not.toMatch(/API_KEY=|Bearer /);
    expect(() => probeScript({ orgId: "x", capRub: 30 })).toThrow(/id организации/);
    expect(() => probeScript({ orgId: ORG, capRub: 31 })).toThrow(/от 1 до 30/);
    expect(() => probeScript({ orgId: ORG, capRub: 5, callTypes: ["page"] })).toThrow(/неизвестный тип/);
    expect(probeSpendSql({ orgId: ORG })).toContain(`\\set org_id '${ORG}'`);
    expect(() => probeSpendSql({ orgId: "1; drop" })).toThrow(/id организации/);
  });

  test("probeMain with the real router of @wizard/llm: every head answers, T1 calls are scrubbed, the image goes to T0", async () => {
    const lines: string[] = [];
    const { calls, total } = await probeMain(
      { orgId: ORG, capRub: 30, callTypes: PROBE_CALL_TYPES, png: undefined, fake: true },
      {
        createRouter,
        createRegistry,
        CircuitBreaker,
        postgres: null,
        env: {},
        log: (l: string) => lines.push(l),
      },
    );
    expect(calls.map((c: { status: string }) => c.status)).toEqual(PROBE_CALL_TYPES.map(() => "ok"));
    const by = Object.fromEntries(calls.map((c: { callType: string }) => [c.callType, c]));
    expect(by.interview_v3).toMatchObject({ model: "glm-5.3", tier: "T1", scrubbed: true });
    expect(by.brief_extract).toMatchObject({ model: "gigachat-3.5", tier: "T0" });
    expect(by.techreview).toMatchObject({ model: "gpt-oss-120b", tier: "T0" });
    expect(total).toMatchObject({ capRub: 30, stopped: null, fake: true });
    const parsed = parseProbeOutput(lines.join("\n"));
    expect(parsed.calls).toHaveLength(PROBE_CALL_TYPES.length);
    expect(parsed.total.spentRub).toBe(total.spentRub);
  });

  test("the cap: no call starts once the spend reached it", async () => {
    const lines: string[] = [];
    const { calls, total } = await probeMain(
      { orgId: ORG, capRub: 0.05, callTypes: PROBE_CALL_TYPES, fake: true },
      {
        createRouter,
        createRegistry,
        CircuitBreaker,
        postgres: null,
        env: {},
        log: (l: string) => lines.push(l),
      },
    );
    const ran = calls.filter((c: { status: string }) => c.status === "ok").length;
    expect(ran).toBeGreaterThanOrEqual(1);
    expect(ran).toBeLessThan(PROBE_CALL_TYPES.length);
    expect(calls.at(-1)).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/^потолок пробы 0\.05 ₽ достигнут/),
    });
    expect(total.stopped).toMatch(/потолок пробы/);
  });

  test("annotations: one line per route — a notice for an answer, a warning for an error or a skip", () => {
    const lines = probeAnnotations([
      {
        callType: "page_compose",
        status: "ok",
        model: "glm-5.3",
        tier: "T1",
        routeReason: "default_T1",
        scrubbed: true,
        latencyMs: 1200,
        rub: 0.4,
        tried: ["glm-5.3:ok"],
      },
      {
        callType: "techreview",
        status: "error",
        code: "LLM_UNAVAILABLE",
        message: "Модели\nнедоступны",
        tried: ["deepseek-v4-pro:error"],
      },
      { callType: "research", status: "skipped", reason: "WIZARD_RESEARCH_MODE не live" },
    ]);
    expect(lines[0]).toMatch(
      /^::notice title=V3 проба · page_compose::ответила glm-5\.3 \(T1, default_T1\) · маскирование ПДн: да · 1200 мс · /,
    );
    expect(lines[1]).toMatch(
      /^::warning title=V3 проба · techreview::ошибка LLM_UNAVAILABLE: Модели недоступны/,
    );
    expect(lines[2]).toBe("::warning title=V3 проба · research::пропущен: WIZARD_RESEARCH_MODE не live");
    for (const l of lines) expect(l).not.toMatch(/\n/);
  });

  test("the report: answered, skipped, errors and a head that did not answer, in Russian", () => {
    const { text, summary } = renderProbeReport(
      {
        calls: [
          {
            callType: "interview_v3",
            status: "ok",
            model: "glm-5.1",
            tier: "T0",
            routeReason: "fallback_error",
            scrubbed: false,
            latencyMs: 900,
            rub: 0.31,
            tried: ["glm-5.3:error", "glm-5.1:ok"],
          },
          {
            callType: "techreview",
            status: "error",
            code: "LLM_UNAVAILABLE",
            message: "Модели недоступны",
            latencyMs: 10,
            rub: 0,
            tried: [],
          },
          {
            callType: "research",
            status: "skipped",
            reason: "исследование на сервере выключено (WIZARD_RESEARCH_MODE не live)",
          },
        ],
        total: { spentRub: 0.31, capRub: 30, stopped: null, fake: false },
      },
      { date: "2026-10-09", platform: "https://borntobuild.ru" },
    );
    expect(summary).toMatchObject({ total: 2, ready: 1, passed: false, costRub: 0.31, costExact: true });
    expect(text).toContain("**Итог: ответили 1 из 2 (пропущено 1); расход 0,31 ₽.**");
    expect(text).toContain(
      "| interview_v3 | glm-5.3 (T1) | ✅ ответила | glm-5.1 | T0 | fallback_error | нет | 900 | 0,31 ₽ | glm-5.3:error, glm-5.1:ok |",
    );
    expect(text).toContain("- techreview: LLM_UNAVAILABLE — Модели недоступны");
    expect(text).toContain("- research: исследование на сервере выключено");
    expect(text).toContain("- interview_v3: ответила glm-5.1 (T0, fallback_error) вместо glm-5.3");
  });
});

const SHAPE_ORG = "22222222-2222-4222-8222-222222222222";
type ShapeResult = {
  group: string;
  callType: string;
  model: string;
  variant: string;
  status: string;
  verdict: string;
  code?: string;
  reason?: string;
  tried?: string[];
  diag?: { http?: number; note?: string; skipped?: string; rub?: number };
};
const fx = () => ({ ...loadShapeFixture(), short: SHAPE_SHORT, jsonRule: SHAPE_JSON_RULE });
const variant = (g: string, id: string) =>
  SHAPE_VARIANTS[g as keyof typeof SHAPE_VARIANTS].find((v: { id: string }) => v.id === id);
/** The tools' own checks, as the pod loads them from @wizard/agents. */
const realTools = async () => ({ critic: critiqueTool, techreview: submitTechreview, looseObject });

describe("v3 shape probe: the request content", () => {
  test("the prompts and tools are the real ones of @wizard/agents (WIZARD_UPDATE_PROBE_SHAPE=1 rewrites the file)", async () => {
    const real = await shapePrompts();
    if (process.env.WIZARD_UPDATE_PROBE_SHAPE === "1")
      writeFileSync(SHAPE_PROMPTS_PATH, `${JSON.stringify(real, null, 1)}\n`);
    expect(JSON.parse(readFileSync(SHAPE_PROMPTS_PATH, "utf8"))).toEqual(JSON.parse(JSON.stringify(real)));
    expect(real.critic.tool).toEqual(critiqueTool.definition);
    expect(real.techreview.tool).toEqual(submitTechreview.definition);
    // The legend names all six shots; the digest ×2 is about twice the fixture build's.
    expect(real.critic.user).toContain("2. / при 1440 px — вся страница");
    const [d1 = 0, d2 = 0] = real.techreview.digestChars;
    expect(d1).toBeGreaterThan(3000);
    expect(d2 / d1).toBeGreaterThan(1.7);
    expect(d2 / d1).toBeLessThan(2.3);
    expect(real.techreview.repair.tool.content).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
  }, 120_000);

  test("the images: the JPEGs of the critic's shot plan for a three-page site (≤ 2 per call), < 400 KB", () => {
    const images = shapeImages();
    const site = {
      pages: [
        { route: "/", kind: "home" },
        { route: "/services", kind: "catalog" },
        { route: "/contacts", kind: "contacts" },
      ],
    } as unknown as SiteModel;
    const plan = shotPlan(site);
    expect(images.map((i) => [i.route, i.width, i.kind])).toEqual(
      plan.map((s) => [s.route, s.width, s.kind]),
    );
    for (const [i, im] of images.entries()) {
      expect(imageSize({ mime: im.mime, data: im.data })).toEqual(im.px);
      expect(im.px).toEqual({ width: plan[i]?.maxWidth, height: plan[i]?.maxHeight });
    }
    expect(images.reduce((s, i) => s + i.data.length, 0)).toBeLessThan(400_000);
  });

  test("chains, prices, image rules and route limits equal the registry; the token estimate equals @wizard/llm", () => {
    const reg = createRegistry({ buildDefaultTier: "T1" }, {});
    for (const g of SHAPE_GROUPS) {
      const route =
        reg.routes[SHAPE_CALL_TYPES[g as keyof typeof SHAPE_CALL_TYPES] as keyof typeof reg.routes];
      expect(route.chain.T0, g).toEqual(SHAPE_CHAINS[g as keyof typeof SHAPE_CHAINS]);
      expect(SHAPE_ROUTES[g as keyof typeof SHAPE_ROUTES]).toEqual({
        maxTokens: route.maxTokens,
        timeoutMs: route.timeoutMs,
      });
    }
    for (const [id, m] of Object.entries(SHAPE_MODELS)) {
      const def = reg.models.find((x) => x.id === id);
      expect(def?.price, id).toEqual(m.price);
      expect(def?.image, id).toEqual((m as { image?: unknown }).image);
    }
    const f = fx();
    for (const it of shapePlan()) {
      const v = variant(it.group, it.variant);
      const req = shapeMessages(f, it.group, v);
      const model = reg.models.find((x) => x.id === it.model);
      const px = f.images.slice(0, v.images ?? 0).map((i: { px: unknown }) => i.px);
      expect(
        shapeTokens(req.messages, req.tool ? [req.tool] : [], px, model?.image),
        `${it.model} ${it.variant}`,
      ).toBe(estimateInputTokens(req.messages as LlmMessage[], req.tool ? [req.tool] : [], model));
    }
  });

  test("the direct diagnostic call sends exactly the gateway's request (AI SDK body + transformBody)", async () => {
    const f = fx();
    for (const [g, id] of [
      ["critic", "prod"],
      ["critic", "json6"],
      ["techreview", "repair"],
      ["techreview", "auto"],
    ] as const) {
      const v = variant(g, id);
      const req = shapeMessages(f, g, v);
      let sent: unknown = null;
      const capture = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        sent = body;
        // With toolChoice required AI SDK 7 refuses an answer without a tool call (ToolChoiceViolationError).
        const message = body.tools
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c",
                  type: "function",
                  function: { name: body.tools[0].function.name, arguments: "{}" },
                },
              ],
            }
          : { role: "assistant", content: "да" };
        return new Response(
          JSON.stringify({
            id: "x",
            object: "chat.completion",
            created: 1,
            model: "m",
            choices: [{ index: 0, message, finish_reason: body.tools ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      const route = SHAPE_ROUTES[g];
      await chatCall({
        bodyProfile: "cloudru",
        baseURL: "https://fm.example/v1",
        apiKey: "k",
        modelName: "moonshotai/Kimi-K2.6",
        messages: req.messages as LlmMessage[],
        ...(req.tool ? { tools: [req.tool] } : {}),
        toolChoice: req.toolChoice ?? "auto",
        temperature: 0.1,
        maxTokens: route.maxTokens,
        signal: AbortSignal.timeout(5000),
        fetch: capture,
        reasoning: "low",
      });
      const mine = transformBody(
        "cloudru",
        openAiBody({
          model: "moonshotai/Kimi-K2.6",
          messages: req.messages,
          tools: req.tool ? [req.tool] : undefined,
          toolChoice: req.toolChoice,
          temperature: 0.1,
          maxTokens: route.maxTokens,
        }),
        "low",
      );
      expect(JSON.parse(JSON.stringify(mine)), `${g} ${id}`).toEqual(sent);
    }
  });

  test("providerCall: the provider's text with keys masked, the answer in brief, a network error by its code", async () => {
    const key = "cloudru-secret-key-0123456789";
    const refuse = (async () =>
      new Response(
        `{"error":{"message":"At most 1 image(s) may be provided in one request. key=${key} Authorization: Bearer abc.def.ghi sk-live-1234567890abcdef ${"Q".repeat(60)}"}}`,
        { status: 400 },
      )) as unknown as typeof fetch;
    const r = await providerCall({
      url: "https://fm.example/v1/chat/completions",
      key,
      body: {},
      fetch: refuse,
    });
    expect(r).toMatchObject({ status: 400, ok: false });
    expect(r.note).toContain("At most 1 image(s) may be provided in one request.");
    expect(r.note).not.toContain(key);
    expect(r.note).not.toMatch(/abc\.def\.ghi|1234567890abcdef|Q{40}/);
    expect(r.note.length).toBeLessThanOrEqual(300);
    const ok = await providerCall({
      url: "u",
      key,
      body: {},
      fetch: (async () =>
        new Response(
          JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "да" } }] }),
        )) as unknown as typeof fetch,
    });
    expect(ok.note).toBe('finish=stop text="да"');
    const down = await providerCall({
      url: "u",
      key,
      body: {},
      fetch: (async () => {
        throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
      }) as unknown as typeof fetch,
    });
    expect(down).toMatchObject({ status: 0, ok: false, error: "ECONNRESET" });
  });
});

describe("v3 shape probe: the plan, the cap, the pod script", () => {
  test("the build shapes of every model first, then the digest ×2 and the second turn, the analysis last", () => {
    const plan = shapePlan();
    const ids = plan.map(
      (x: { group: string; model: string; variant: string }) => `${x.group}:${x.model}:${x.variant}`,
    );
    expect(ids.slice(0, 6)).toEqual([
      "critic:kimi-k2.6:prod",
      "critic:qwen3.6-35b:prod",
      "techreview:gpt-oss-120b:prod",
      "techreview:gigachat-3.5:prod",
      "techreview:deepseek-v4-pro:prod",
      "techreview:kimi-k2.6:prod",
    ]);
    expect(ids.slice(6, 10)).toEqual([
      "techreview:gpt-oss-120b:x2",
      "techreview:deepseek-v4-pro:x2",
      "techreview:gpt-oss-120b:repair",
      "techreview:deepseek-v4-pro:repair",
    ]);
    expect(plan.slice(10).every((x: { when?: string }) => x.when)).toBe(true);
    expect(shapePlan(["techreview"]).every((x: { group: string }) => x.group === "techreview")).toBe(true);
    expect(parseShapeGroups("")).toBeNull();
    expect(parseShapeGroups("techreview,critic")).toEqual(["critic", "techreview"]);
    expect(() => parseShapeGroups("critic,page")).toThrow(/--shape/);
  });

  test("the expected ₽: the build shapes well under the cap; every build shape refused and every analysis answering — about the cap", () => {
    const e = expectedShapeRub();
    expect(e.base).toBeGreaterThan(5);
    expect(e.base).toBeLessThan(15);
    expect(e.worst).toBeGreaterThan(e.base);
    expect(e.worst).toBeLessThan(32);
    expect(e.upper).toBeGreaterThan(e.worst);
    const critic = expectedShapeRub({ groups: ["critic"] });
    const review = expectedShapeRub({ groups: ["techreview"] });
    expect(critic.base + review.base).toBeCloseTo(e.base, 1);
    // One group at a time keeps the whole analysis under the cap.
    expect(critic.worst).toBeLessThan(25);
    expect(review.worst).toBeLessThan(25);
    const plan = shapePlan();
    const stage = (id: string) => plan.findIndex((x: { variant: string }) => x.variant === id);
    expect(stage("img1")).toBeLessThan(stage("auto6"));
    expect(stage("json")).toBeLessThan(stage("req1"));
  });

  test("the script: the @wizard/llm namespace, the settings as JSON, no secret; refusals in Russian", () => {
    const s = shapeScript({ orgId: SHAPE_ORG, capRub: 30, groups: ["critic"] });
    expect(s.split("\n").slice(0, 3)).toEqual([
      'import * as llm from "@wizard/llm";',
      'import postgres from "postgres";',
      'import { pathToFileURL } from "node:url";',
    ]);
    expect(s).toContain(`"orgId":"${SHAPE_ORG}"`);
    expect(s).toContain('"capRub":30');
    expect(s).not.toMatch(/API_KEY=|Bearer [A-Za-z0-9]/);
    expect(s.length).toBeLessThan(450_000);
    // The embedded functions are self-contained: nothing of a module scope (or of the test runner's rewrite) leaks in.
    expect(s).not.toContain("__vite_ssr");
    expect(() => shapeScript({ orgId: "x", capRub: 30 })).toThrow(/id организации/);
    expect(() => shapeScript({ orgId: SHAPE_ORG, capRub: 31 })).toThrow(/от 1 до 30/);
    expect(() => shapeScript({ orgId: SHAPE_ORG, capRub: 5, groups: ["page"] })).toThrow(/группы/);
  });
});

describe("v3 shape probe: shapeMain with the real router of @wizard/llm (in-process answers)", () => {
  const deps = (lines: string[]) => ({
    llm: llmNs,
    postgres: null,
    env: {},
    providerCall,
    openAiBody,
    shapeMessages,
    shapeTokens,
    looseJson,
    loadTools: realTools,
    log: (l: string) => lines.push(l),
  });
  const refusal = {
    model: "Kimi",
    minImages: 2,
    message:
      "At most 1 image(s) may be provided in one request. Authorization: Bearer sk-live-1234567890abcdef",
  };

  test("a provider that refuses several images: the router's code, the provider's words, the variants of analysis", async () => {
    const lines: string[] = [];
    const cfg = shapeConfig({ orgId: SHAPE_ORG, capRub: 30, fake: true, fakeFail: [refusal] });
    const { results, total } = await shapeMain(cfg, deps(lines));
    const by = (g: string, m: string, v: string) =>
      (results as ShapeResult[]).find((r) => r.group === g && r.model === m && r.variant === v);
    // kimi refuses six images: the build shape fails with the gateway's code, the direct call has the provider's words.
    expect(by("critic", "kimi-k2.6", "prod")).toMatchObject({
      status: "error",
      verdict: "error",
      code: "LLM_UNAVAILABLE",
      tried: ["kimi-k2.6:error:HTTP_400"],
      diag: { http: 400 },
    });
    const note = by("critic", "kimi-k2.6", "prod")?.diag?.note ?? "";
    expect(note).toContain("At most 1 image(s) may be provided in one request.");
    expect(note).not.toContain("1234567890abcdef");
    // The analysis: one image passes, with a tool too; six fail with or without a tool; JSON text with six fails.
    expect(by("critic", "kimi-k2.6", "img1")?.verdict).toBe("ok");
    expect(by("critic", "kimi-k2.6", "img6")?.verdict).toBe("error");
    expect(by("critic", "kimi-k2.6", "req1")?.verdict).toBe("ok");
    expect(by("critic", "kimi-k2.6", "req0")?.verdict).toBe("unneeded");
    expect(by("critic", "kimi-k2.6", "auto6")?.verdict).toBe("error");
    expect(by("critic", "kimi-k2.6", "json6")?.verdict).toBe("error");
    // qwen takes the build shape: its analysis is not needed; the techreview answers with valid arguments.
    expect(by("critic", "qwen3.6-35b", "prod")?.verdict).toBe("ok");
    expect(by("critic", "qwen3.6-35b", "img1")?.verdict).toBe("unneeded");
    // A variant that depends on a variant not run is not needed either.
    expect(by("critic", "qwen3.6-35b", "req0")?.verdict).toBe("unneeded");
    for (const m of SHAPE_CHAINS.techreview) expect(by("techreview", m, "prod")?.verdict, m).toBe("ok");
    expect(by("techreview", "deepseek-v4-pro", "x2")?.verdict).toBe("ok");
    expect(by("techreview", "gpt-oss-120b", "repair")?.verdict).toBe("ok");
    expect(by("techreview", "kimi-k2.6", "json")?.verdict).toBe("unneeded");
    expect(total).toMatchObject({
      capRub: 30,
      stopped: null,
      fake: true,
      checks: "проверка аргументов — @wizard/agents",
    });
    const parsed = parseShapeOutput(lines.join("\n"));
    expect(parsed.results).toHaveLength(results.length);
    expect(parsed.total.spentRub).toBe(total.spentRub);

    // Annotations: one per call type and model; kimi's critic a warning with the provider's words once.
    const ann = shapeAnnotations(results);
    expect(ann).toHaveLength(6);
    const kimi = ann.find((l: string) => l.includes("critic_visual · kimi-k2.6")) ?? "";
    expect(kimi).toMatch(
      /^::warning title=V3 форма · critic_visual · kimi-k2\.6::как в сборке: ❌ LLM_UNAVAILABLE \[kimi-k2\.6:error:HTTP_400\]/,
    );
    expect(kimi).toContain("напрямую HTTP 400 «");
    expect(kimi).toContain("«то же»");
    expect(kimi).toContain("1 JPEG: ✅");
    expect(kimi).not.toContain("required без картинок");
    expect(ann.find((l: string) => l.includes("critic_visual · qwen3.6-35b"))).toMatch(
      /^::notice title=V3 форма · critic_visual · qwen3\.6-35b::как в сборке: ✅/,
    );
    for (const l of ann) expect(l).not.toMatch(/\n/);

    const { text, summary } = renderShapeReport(
      { results, total },
      { date: "2026-10-09", platform: "https://borntobuild.ru" },
    );
    expect(summary).toMatchObject({ passed: false, prodOk: 5, prodTotal: 6, costExact: false });
    expect(text).toContain("**Итог: как в сборке прошли 5 из 6 моделей;");
    expect(text).toContain("## critic_visual · kimi-k2.6");
    expect(text).toMatch(
      /\| как в сборке \| ❌ LLM_UNAVAILABLE \[kimi-k2\.6:error:HTTP_400\], [\d,]+ с \| — \| kimi-k2\.6:error:HTTP_400 \| —\/— \| напрямую HTTP 400 «.*At most 1 image/,
    );
  }, 60_000);

  test("a model that answers text instead of the tool: one billed answer of the gateway, JSON text works", async () => {
    const lines: string[] = [];
    const cfg = shapeConfig({
      orgId: SHAPE_ORG,
      capRub: 30,
      groups: ["techreview"],
      fake: true,
      fakeFail: [{ model: "DeepSeek", text: '```json\n{"findings":[]}\n```' }],
    });
    const { results, total } = await shapeMain(cfg, deps(lines));
    const by = (v: string) =>
      (results as (ShapeResult & { unrecordedRub?: number; textJson?: string })[]).find(
        (r) => r.model === "deepseek-v4-pro" && r.variant === v,
      );
    // Under toolChoice required AI SDK 7 throws ToolChoiceViolationError after the answer; the gateway turns it back
    // into the text answer (one billed attempt) so callTool can repair it or take the JSON text (textArgs).
    expect(by("prod")).toMatchObject({ status: "ok", verdict: "no_tool", textJson: "годится" });
    expect(by("prod")?.diag).toBeUndefined();
    expect(by("prod")?.unrecordedRub ?? 0).toBe(0);
    expect(total.unrecordedRub ?? 0).toBe(0);
    expect(by("auto")).toMatchObject({ status: "ok", verdict: "no_tool", textJson: "годится" });
    expect(by("json")?.verdict).toBe("ok");
    const line =
      shapeAnnotations(results).find((l: string) => l.includes("techreview · deepseek-v4-pro")) ?? "";
    expect(line).toMatch(/^::warning /);
    expect(line).not.toContain("NETWORK");
    expect(line).toContain("без вызова инструмента (finish stop");
    expect(line).toContain("JSON в тексте годится");
  });

  test("the cap: no call starts when its upper bound would pass it", async () => {
    const lines: string[] = [];
    const cfg = shapeConfig({ orgId: SHAPE_ORG, capRub: 3, groups: ["techreview"], fake: true });
    const { results, total } = await shapeMain(cfg, deps(lines));
    const rs = results as ShapeResult[];
    expect(rs.filter((r) => r.status === "ok").length).toBeGreaterThanOrEqual(1);
    expect(rs.some((r) => r.status === "skipped" && /^потолок пробы 3 ₽/.test(r.reason ?? ""))).toBe(true);
    expect(total.stopped).toMatch(/потолок пробы/);
    expect(total.spentRub).toBeLessThanOrEqual(3);
  });

  test("without @wizard/agents in the pod the arguments are checked by the schema's required keys", async () => {
    const lines: string[] = [];
    const cfg = shapeConfig({ orgId: SHAPE_ORG, capRub: 30, groups: ["techreview"], fake: true });
    const { results, total } = await shapeMain(cfg, {
      ...deps(lines),
      loadTools: async () => {
        throw new Error("Cannot find module");
      },
    });
    expect(total.checks).toMatch(/по обязательным ключам схемы \(@wizard\/agents: Cannot find module\)/);
    expect(
      (results as ShapeResult[]).filter((r) => r.variant === "prod").every((r) => r.verdict === "ok"),
    ).toBe(true);
  });
});
