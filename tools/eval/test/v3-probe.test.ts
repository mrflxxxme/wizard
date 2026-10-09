// V3-18: the probe of the v3 route heads (tools/eval/server/probe.mjs) without network and money — the heads and prices
// equal the registry of @wizard/llm (models.yaml), the expected ₽ under the 30 ₽ cap, the pod script's settings and
// validation, the cap stop and the report; probeMain against the real router of @wizard/llm with in-process answers.
import { describe, expect, test } from "vitest";
import { CircuitBreaker, createRegistry, createRouter } from "../../../packages/llm/src/index.ts";
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
    expect(by.techreview).toMatchObject({ model: "deepseek-v4-pro", tier: "T0" });
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
      { callType: "page_compose", status: "ok", model: "glm-5.3", tier: "T1", routeReason: "default_T1", scrubbed: true, latencyMs: 1200, rub: 0.4, tried: ["glm-5.3:ok"] },
      { callType: "techreview", status: "error", code: "LLM_UNAVAILABLE", message: "Модели\nнедоступны", tried: ["deepseek-v4-pro:error"] },
      { callType: "research", status: "skipped", reason: "WIZARD_RESEARCH_MODE не live" },
    ]);
    expect(lines[0]).toMatch(/^::notice title=V3 проба · page_compose::ответила glm-5\.3 \(T1, default_T1\) · маскирование ПДн: да · 1200 мс · /);
    expect(lines[1]).toMatch(/^::warning title=V3 проба · techreview::ошибка LLM_UNAVAILABLE: Модели недоступны/);
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
