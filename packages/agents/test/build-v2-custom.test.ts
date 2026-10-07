// B2-23 acceptance (builder v2, stage «Дописывание», specs/agents/builder.yaml#v2.stages.custom) on the recorded answers
// tools/fixtures/demo/b2/dental_custom*.jsonl — no network, no money. The limits hold (≤ 2 screens, ≤ 3 functions,
// ≤ 20 ₽, ≤ 2 rounds of fixes); a failed part does not fail the build: the system comes out without it, the client reads
// the replacement and the request goes to «Запросы на развитие». Gates are stubbed here by reading the draft's files
// (real G0–G2 on the same answers — apps/platform-api/test/b2-build-v2.test.ts).
import { type AppSpec, CUSTOM_LIMITS, emptySpec, type SystemPlan } from "@wizard/appspec";
import type { Check, GateReport } from "@wizard/gates";
import { createRegistry, createRouter, type RouteInput, type Router } from "@wizard/llm";
import { type CustomSlot, compilePlan } from "@wizard/modules";
import { describe, expect, test } from "vitest";
import { upperBoundCredits } from "../src/builder/budget.js";
import {
  customInputSchema,
  customIssues,
  customMessages,
  runBuildV2,
  type StageCheckpoint,
  selectCustomSlots,
  type V2Host,
  type V2Outcome,
  type V2Params,
} from "../src/builder/index.js";
import { defineTool } from "../src/core/tool.js";
import { DEFAULT_REGISTRY } from "../src/planner/index.js";
import { approvedPlan, builtPlan } from "./build-v2-fixtures.js";
import { B2_CUSTOM_SCENARIOS, type B2CustomScenario } from "./build-v2-scenarios.js";

const OPEN = { ruOnly: false, t1Restricted: false };
const reg = createRegistry({ buildDefaultTier: "T1" });
const scenario = (name: string) => B2_CUSTOM_SCENARIOS.find((s) => s.name === name) as B2CustomScenario;

interface SystemState {
  version: number;
  spec: AppSpec;
  files: Record<string, string>;
  commits: number;
  checkpoints: Map<string, StageCheckpoint>;
  requests: { category: string; quote: string; offered: string | null }[];
}

const newSystem = (): SystemState => ({
  version: 0,
  spec: emptySpec("Тестовая система"),
  files: {},
  commits: 0,
  checkpoints: new Map(),
  requests: [],
});

/** Stubbed gates: a function on the Convex API fails G0-TS-01 in its file; `extra` adds blockers of the test. */
type GateStub = (level: string, sys: SystemState) => Check[];

const tsCheck: GateStub = (level, sys) =>
  level === "G0"
    ? Object.entries(sys.files)
        .filter(([, src]) => src.includes("ctx.db.query("))
        .map(([file]) => ({
          id: "G0-TS-01",
          status: "fail" as const,
          severity: "blocker" as const,
          message_ru: "Ошибка типов в коде функции",
          file,
          line: 6,
          evidence: "TS2339: Property 'query' does not exist",
        }))
    : [];

function report(level: string, version: number, checks: Check[]): GateReport {
  return {
    level: level as GateReport["level"],
    passed: checks.length === 0,
    specVersion: version,
    startedAt: "2026-10-06T00:00:00.000Z",
    durationMs: 1,
    checks,
    summary: { pass: checks.length ? 0 : 1, fail: checks.length, warn: 0, skip: 0, error: 0 },
  };
}

interface RunRecord {
  calls: string[];
  messages: string[];
  creditsMilli: number;
  gates: { level: string; version: number; files: string[] }[];
  events: { type: string; payload: Record<string, unknown> }[];
}

function memHost(
  sys: SystemState,
  sc: string,
  o: { gates?: GateStub; gatesThrowAt?: number } = {},
): { host: V2Host; rec: RunRecord } {
  const rec: RunRecord = { calls: [], messages: [], creditsMilli: 0, gates: [], events: [] };
  const router: Router = createRouter({
    mode: "fixture",
    fixture: { suite: "demo", name: `b2/${sc}` },
    registry: reg,
    sink: { write: async () => {} },
    env: {},
  });
  const gates = o.gates ?? tsCheck;
  const host: V2Host = {
    run: { id: `run-${Math.random().toString(16).slice(2)}` },
    runStep: (_n, fn) => fn(),
    emit: (type, payload) => {
      rec.events.push({ type, payload });
    },
    route: async (input) => {
      const { step: _s, upperBoundCredits: _u, ...rest } = input;
      rec.calls.push(input.callType);
      if (input.callType === "build_custom")
        rec.messages.push(String(input.messages[input.messages.length - 1]?.content ?? ""));
      const out = await router.route({ ...rest, orgPolicy: OPEN, ctx: { orgId: "org" } } as RouteInput);
      rec.creditsMilli += out.creditsMilli;
      return out;
    },
    checkpoints: {
      load: async () => [...sys.checkpoints.values()],
      save: async (cp) => {
        sys.checkpoints.set(cp.stage, structuredClone(cp));
      },
    },
    currentSpec: async () => ({ spec: sys.spec, version: sys.version }),
    commitCompiled: async ({ spec, files }) => {
      sys.version += 1;
      sys.commits += 1;
      sys.spec = spec;
      sys.files = { ...files };
      return { revision: sys.version };
    },
    runGates: async (level) => {
      rec.gates.push({ level, version: sys.version, files: Object.keys(sys.files) });
      if (o.gatesThrowAt !== undefined && rec.gates.length === o.gatesThrowAt)
        throw new Error("runtime не ответил");
      return report(level, sys.version, gates(level, sys));
    },
    goalBrowser: false,
    recordDevelopmentRequest: async (input) => {
      sys.requests.push(input);
    },
  };
  return { host, rec };
}

async function build(
  sys: SystemState,
  sc: string,
  o: Parameters<typeof memHost>[2] & { plan?: SystemPlan; params?: Partial<V2Params> } = {},
) {
  const { host, rec } = memHost(sys, sc, o);
  let out: V2Outcome | null = null;
  let error: unknown = null;
  try {
    out = await runBuildV2(host, {
      plan: o.plan ?? approvedPlan(scenario(sc)),
      planRevision: 1,
      appName: "Тестовая система",
      ...o.params,
    });
  } catch (e) {
    error = e;
  }
  return { out, error, rec };
}

const metricsOf = (rec: RunRecord) =>
  (rec.events.find((e) => e.type === "build_metrics")?.payload.stages ?? {}) as Record<
    string,
    { status: string; costRub: number; calls?: number; fallback?: boolean; note?: string }
  >;
const summary = (out: V2Outcome | null) => (out as { summary_ru: string }).summary_ru;
const SCREEN = "ui/custom/CustomPriceQuiz.tsx";
const FUNCTION = "functions/custom/leads_month.ts";

describe("custom code: a part that fails is isolated, the build goes on (acceptance)", () => {
  test("a function still broken after 2 rounds of fixes: out with the screen, without the function; request recorded", async () => {
    const sys = newSystem();
    const r = await build(sys, "dental_custom_broken");
    expect(r.out?.status, JSON.stringify(r.error)).toBe("succeeded");
    // 1 answer + 2 rounds of fixes, never more.
    expect(r.rec.calls.filter((c) => c === "build_custom")).toHaveLength(1 + CUSTOM_LIMITS.rounds);
    // The fix rounds give the model the blocker of its file and ask for that part only.
    expect(r.rec.messages[1]).toContain(`G0-TS-01 ${FUNCTION}:6`);
    expect(r.rec.messages[1]).toContain("заново только части: leads_month");
    // The system: the screen stays, the function is rolled back.
    expect(Object.keys(sys.files)).toContain(SCREEN);
    expect(Object.keys(sys.files)).not.toContain(FUNCTION);
    expect(sys.spec.pages?.map((p) => p.route)).toContain("/custom-price-quiz");
    expect(sys.spec.functions?.some((f) => f.name === "customLeadsMonth") ?? false).toBe(false);
    // The gates stage checks the revision the system comes out with.
    const last = r.rec.gates.slice(-3);
    expect(last.map((g) => g.level)).toEqual(["G0", "G1", "G2"]);
    expect(last.every((g) => g.version === sys.version && !g.files.includes(FUNCTION))).toBe(true);
    // «Запросы на развитие» and the replacement in plain words.
    expect(sys.requests).toEqual([
      {
        category: "other",
        quote:
          "Заявки за месяц: Функция для владельца: сколько заявок пришло за последние 30 дней и сколько из них ещё новые",
        offered:
          "Пока пользуйтесь разделом «Заявки» — он закрывает основную задачу; «Заявки за месяц» команда посмотрит отдельно.",
      },
    ]);
    expect(summary(r.out)).toContain("Дописано под вашу задачу: «Подбор лечения».");
    expect(summary(r.out)).toContain(
      "«Заявки за месяц» не прошло автоматическую проверку — система собрана без этой части. Пока пользуйтесь разделом «Заявки»",
    );
    expect(summary(r.out)).toContain("Мы записали это в запросы на развитие.");
    // ≤ 20 ₽ and the stage metric says what happened.
    const m = metricsOf(r.rec).custom;
    expect(m).toMatchObject({
      status: "done",
      fallback: true,
      note: "дописано 1 из 2, раундов исправления 2",
    });
    expect(m?.costRub).toBeGreaterThan(0);
    expect(m?.costRub).toBeLessThanOrEqual(CUSTOM_LIMITS.budgetRub);
    // The failed part is kept as an outOfScope entry in the stage checkpoint (the approved plan is not changed).
    expect(sys.checkpoints.get("custom")?.data).toMatchObject({
      items: [
        { id: "price_quiz", status: "done" },
        { id: "leads_month", status: "failed", reason: "gates" },
      ],
      outOfScope: [
        { category: "custom_logic", module: "leads", request: expect.stringContaining("Заявки за месяц") },
      ],
    });

    // A repeated build of the same plan reuses the custom stage and the gates: no model call, same revision.
    const again = await build(sys, "dental_custom_broken");
    expect(again.out).toMatchObject({ status: "succeeded", revision: sys.version });
    expect(again.rec.calls).toEqual([]);
    expect(sys.requests).toHaveLength(1);
  });

  test("a blocker no part can be blamed for: no fix round, every custom part rolled back, the build goes on", async () => {
    const sys = newSystem();
    const render: GateStub = (level, s) =>
      level === "G1" && Object.keys(s.files).some((f) => f.includes("/custom/"))
        ? [{ id: "G1-BUILD-01", status: "fail", severity: "blocker", message_ru: "Сборка интерфейса упала" }]
        : [];
    const r = await build(sys, "dental_custom", { gates: render });
    expect(r.out?.status).toBe("succeeded");
    expect(r.rec.calls.filter((c) => c === "build_custom")).toHaveLength(1);
    expect(Object.keys(sys.files).some((f) => f.includes("/custom/"))).toBe(false);
    expect(sys.spec.pages?.some((p) => p.route === "/custom-price-quiz")).toBe(false);
    // compile, custom, rollback.
    expect(sys.commits).toBe(3);
    expect(sys.requests.map((q) => q.quote.split(":")[0])).toEqual(["Подбор лечения", "Заявки за месяц"]);
    expect(sys.requests[0]?.offered).toBe(
      "Пока система работает без «Подбор лечения»; команда посмотрит запрос и предложит решение.",
    );
    expect(summary(r.out)).not.toContain("Дописано под вашу задачу");
    expect(summary(r.out)).toContain("«Подбор лечения» не прошло автоматическую проверку");
  });

  test("an infrastructure failure in the gates after the custom stage: the retry reuses compile and custom", async () => {
    const sys = newSystem();
    // The custom stage runs G0, G1, G2 (calls 1–3); the gates stage's G0 is call 4.
    const failed = await build(sys, "dental_custom", { gatesThrowAt: 4 });
    expect(failed.error).toBeTruthy();
    const retry = await build(sys, "dental_custom");
    expect(retry.out?.status).toBe("succeeded");
    const reused = retry.rec.events
      .filter((e) => e.type === "build_stage" && e.payload.status === "reused")
      .map((e) => e.payload.stage);
    expect(reused).toEqual(["plan", "texts", "design", "photos", "compile", "custom"]);
    expect(retry.rec.calls).toEqual([]);
    expect(sys.commits).toBe(2);
    expect(Object.keys(sys.files)).toEqual(expect.arrayContaining([SCREEN, FUNCTION]));
  });
});

describe("custom code: limits (₽, rounds, screens, functions)", () => {
  /** ₽ upper bound of the first build_custom call of a scenario (the wallet's check, the dearest model of the route). */
  function firstCallUbRub(sc: B2CustomScenario): number {
    const built = compilePlan(builtPlan(sc), DEFAULT_REGISTRY);
    if (!built.ok) throw new Error("plan");
    const tool = defineTool({ name: "submit_custom", description: "x", input: customInputSchema });
    const msgs = customMessages(built.plan, built.spec, built.customSlots);
    return upperBoundCredits("build_custom", msgs, [tool.definition], reg) * reg.rubPerCredit;
  }

  test("a stage budget below the first call: no call, the parts go to the requests, the build succeeds", async () => {
    const sys = newSystem();
    const r = await build(sys, "dental_custom", { params: { budgets: { custom: 1 } } });
    expect(r.out?.status).toBe("succeeded");
    expect(r.rec.calls).not.toContain("build_custom");
    expect(sys.commits).toBe(1);
    expect(sys.requests).toHaveLength(2);
    expect(summary(r.out)).toContain("«Подбор лечения» не уложилось в бюджет дописывания");
  });

  test("the budget fits one answer but not a fix: the broken part is dropped, the good one stays", async () => {
    const sc = scenario("dental_custom_broken");
    const ub = firstCallUbRub(sc);
    expect(ub).toBeLessThan(CUSTOM_LIMITS.budgetRub);
    const sys = newSystem();
    const r = await build(sys, sc.name, {
      params: { budgets: { custom: Math.ceil(ub * 100) / 100 + 0.01 } },
    });
    expect(r.out?.status).toBe("succeeded");
    expect(r.rec.calls.filter((c) => c === "build_custom")).toHaveLength(1);
    expect(Object.keys(sys.files)).toContain(SCREEN);
    expect(Object.keys(sys.files)).not.toContain(FUNCTION);
    expect(sys.checkpoints.get("custom")?.data.items).toEqual([
      { id: "price_quiz", kind: "screen", title: "Подбор лечения", status: "done" },
      { id: "leads_month", kind: "function", title: "Заявки за месяц", status: "failed", reason: "budget" },
    ]);
    expect(metricsOf(r.rec).custom?.costRub).toBeLessThanOrEqual(Math.ceil(ub * 100) / 100 + 0.01);
  });

  test("the stage is not counted in the 15 ₽ of the build: the default budgets build both parts", async () => {
    const r = await build(newSystem(), "dental_custom", { params: { budgets: { total: 8 } } });
    expect(r.out?.status).toBe("succeeded");
    expect(metricsOf(r.rec).custom).toMatchObject({ status: "done", calls: 1 });
  });

  test("≤ 2 screens and ≤ 3 functions: the rest is not built (the plan schema refuses more; the stage holds anyway)", () => {
    const slot = (id: string, kind: "screen" | "function"): CustomSlot => ({
      id,
      kind,
      title: id,
      name: `custom_${id}`,
      file: kind === "screen" ? `ui/custom/${id}.tsx` : `functions/custom/${id}.ts`,
      budgetRub: 1,
    });
    const slots = [
      slot("s1", "screen"),
      slot("f1", "function"),
      slot("s2", "screen"),
      slot("s3", "screen"),
      slot("f2", "function"),
      slot("f3", "function"),
      slot("f4", "function"),
    ];
    const { build: ok, over } = selectCustomSlots(slots);
    expect(ok.map((s) => s.id)).toEqual(["s1", "f1", "s2", "f2", "f3"]);
    expect(over.map((s) => s.id)).toEqual(["s3", "f4"]);
  });

  test("submit_custom writes only the parts asked: no other part, no missing one, roles of the spec, right kind", () => {
    const sc = scenario("dental_custom");
    const built = compilePlan(builtPlan(sc), DEFAULT_REGISTRY);
    if (!built.ok) throw new Error("plan");
    const fn = built.customSlots.filter((s) => s.kind === "function");
    const issues = customIssues(built, fn, {
      items: [
        { id: "price_quiz", roles: ["guest"], code: "export default function X() { return null; }" },
        { id: "leads_month", roles: ["boss"], kind: "mutation", code: "export default query({ args: {} })" },
      ],
    });
    expect(issues.map((i) => i.code)).toEqual(["UNKNOWN_PART", "UNKNOWN_ROLE", "KIND_MISMATCH"]);
    expect(customIssues(built, built.customSlots, { items: [sc.rounds[0]?.items[0] as never] })).toEqual([
      expect.objectContaining({ code: "MISSING_PART" }),
    ]);
  });
});
