// B2-21 acceptance (builder v2, specs/agents/builder.yaml#v2) on the recorded answers (tools/fixtures/demo/b2, no
// network, no money): stages plan → texts → design → compile → custom → gates with a checkpoint after each; a failure
// at any stage continues from the last checkpoint without paying for the finished stages again; stage budgets; the
// average build ≤ 15 ₽ by the models.yaml prices. Gates are stubbed here (real G0–G2 — apps/platform-api b2-build-v2).
import { type AppSpec, emptySpec, type SystemPlan } from "@wizard/appspec";
import type { GateReport, GoalScenarioInput } from "@wizard/gates";
import {
  costRub,
  createRegistry,
  createRouter,
  type FixtureLine,
  LlmError,
  type RouteInput,
  type RouteOutput,
  type Router,
} from "@wizard/llm";
import { describe, expect, test } from "vitest";
import {
  type CustomStageFn,
  runBuildV2,
  type StageCheckpoint,
  V2_STAGES,
  type V2Host,
  type V2Outcome,
  type V2Params,
  type V2Stage,
  withOwnerFields,
} from "../src/builder/index.js";
import { approvedPlan, fixtureLines } from "./build-v2-fixtures.js";
import { B2_CUSTOM_SCENARIOS, B2_SCENARIOS, type B2Scenario } from "./build-v2-scenarios.js";

const OPEN = { ruOnly: false, t1Restricted: false };
const reg = createRegistry({ buildDefaultTier: "T1" });
const rub = (milli: number) => (milli / 1000) * reg.rubPerCredit;
const scenario = (name: string) =>
  [...B2_SCENARIOS, ...B2_CUSTOM_SCENARIOS].find((s) => s.name === name) as B2Scenario;

interface Event {
  type: string;
  payload: Record<string, unknown>;
}

/** What survives between runs of one system: draft revisions and the checkpoints of the plan revision. */
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

type Fault = { stage: V2Stage | "gates_report"; on: "throw" } | null;

interface RunRecord {
  events: Event[];
  calls: string[];
  creditsMilli: number;
  gates: { level: string; goalScenarios?: readonly GoalScenarioInput[] }[];
}

const passing = (level: string, version: number, passed = true): GateReport => ({
  level: level as GateReport["level"],
  passed,
  specVersion: version,
  startedAt: "2026-10-06T00:00:00.000Z",
  durationMs: 1,
  checks: passed
    ? []
    : [{ id: "G1-RENDER-01", status: "fail", severity: "blocker", message_ru: "Экран «/» не открылся" }],
  summary: { pass: passed ? 1 : 0, fail: passed ? 0 : 1, warn: 0, skip: 0, error: 0 },
});

/** A V2Host over the fixture router of a scenario, with an optional fault at one stage. */
function memHost(
  sys: SystemState,
  sc: string,
  o: {
    fault?: Fault;
    route?: (input: RouteInput) => Promise<RouteOutput>;
    goalBrowser?: boolean;
    /** Org policy: «Только РФ» routes every call to T0 (glm-5.1 — the dearer prices). */
    ruOnly?: boolean;
  } = {},
): { host: V2Host; rec: RunRecord } {
  const rec: RunRecord = { events: [], calls: [], creditsMilli: 0, gates: [] };
  const router: Router = createRouter({
    mode: "fixture",
    fixture: { suite: "demo", name: `b2/${sc}` },
    registry: reg,
    sink: { write: async () => {} },
    env: {},
  });
  const fault = o.fault ?? null;
  const host: V2Host = {
    run: { id: `run-${Math.random().toString(16).slice(2)}` },
    runStep: (_n, fn) => fn(),
    emit: (type, payload) => {
      rec.events.push({ type, payload });
    },
    route: async (input) => {
      const { step: _s, upperBoundCredits: _u, ...rest } = input;
      const full = {
        ...rest,
        orgPolicy: { ...OPEN, ruOnly: !!o.ruOnly },
        ctx: { orgId: "org" },
      } as RouteInput;
      if (fault?.stage === "texts" && input.callType === "build_texts")
        throw new LlmError("LLM_UNAVAILABLE", "все модели недоступны");
      if (fault?.stage === "design" && input.callType === "build_design")
        throw new LlmError("LLM_UNAVAILABLE", "все модели недоступны");
      if (fault?.stage === "custom" && input.callType === "build_custom")
        throw new LlmError("LLM_UNAVAILABLE", "все модели недоступны");
      rec.calls.push(input.callType);
      const out = o.route ? await o.route(full) : await router.route(full);
      rec.creditsMilli += out.creditsMilli;
      return out;
    },
    checkpoints: {
      load: async () => [...sys.checkpoints.values()],
      save: async (cp) => {
        if (fault?.stage === "plan" && cp.stage === "plan") throw new Error("база недоступна");
        sys.checkpoints.set(cp.stage, structuredClone(cp));
      },
    },
    currentSpec: async () => ({ spec: sys.spec, version: sys.version }),
    commitCompiled: async ({ spec, files }) => {
      if (fault?.stage === "compile") throw new Error("хранилище файлов недоступно");
      sys.version += 1;
      sys.commits += 1;
      sys.spec = spec;
      sys.files = { ...files };
      return { revision: sys.version };
    },
    runGates: async (level, ov) => {
      rec.gates.push({ level, ...(ov?.goalScenarios ? { goalScenarios: ov.goalScenarios } : {}) });
      if (fault?.stage === "gates" && level === "G1") throw new Error("runtime G1 не ответил");
      return passing(level, sys.version, !(fault?.stage === "gates_report" && level === "G1"));
    },
    goalBrowser: o.goalBrowser ?? false,
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

const stagesOf = (rec: RunRecord, status: string) =>
  rec.events
    .filter((e) => e.type === "build_stage" && e.payload.status === status)
    .map((e) => e.payload.stage as string);

/** The dental plan with a custom screen and function (B2-23; recorded answers tools/fixtures/demo/b2/dental_custom). */
const withCustom = (): SystemPlan => approvedPlan(scenario("dental_custom"));

describe("builder v2: stages, events, checkpoints", () => {
  test("clean build: stages in order with plain labels and «осталось», one revision, gates G0–G2", async () => {
    const sys = newSystem();
    const { out, rec } = await build(sys, "dental");
    expect(out?.status).toBe("succeeded");
    if (out?.status !== "succeeded") return;
    expect(stagesOf(rec, "done")).toEqual(["plan", "texts", "design", "photos", "compile", "gates"]);
    expect(stagesOf(rec, "skipped")).toEqual(["custom"]);
    const started = rec.events.filter((e) => e.type === "build_stage" && e.payload.status === "started");
    expect(started.map((e) => e.payload.label_ru)).toEqual([
      "Сверяю план",
      "Пишу тексты",
      "Подбираю оформление",
      "Подбираю фото",
      "Собираю экраны и данные",
      "Проверяю, что всё работает",
    ]);
    const left = rec.events
      .filter((e) => e.type === "build_stage")
      .map((e) => e.payload.remainingSec as number);
    expect(left.every((x, i) => i === 0 || x <= (left[i - 1] as number))).toBe(true);
    expect(left.at(-1)).toBe(0);
    expect(rec.events.every((e) => e.type !== "build_stage" || e.payload.total === V2_STAGES.length)).toBe(
      true,
    );
    expect(rec.calls).toEqual(["build_texts", "build_design"]);
    expect(rec.gates.map((g) => g.level)).toEqual(["G0", "G1", "G2"]);
    expect(sys.commits).toBe(1);
    expect(out.revision).toBe(1);
    // The texts and design of the recorded answers are in the compiled system.
    expect(sys.files["ui/pages/Home.tsx"]).toContain("Лечим зубы бережно и без боли");
    expect(sys.spec.theme).toMatchObject({ preset: "calm", headingFont: "PT Serif" });
    expect([...sys.checkpoints.keys()].sort()).toEqual([...V2_STAGES].sort());
    const metrics = rec.events.find((e) => e.type === "build_metrics")?.payload as {
      stages: Record<string, unknown>;
    };
    expect(metrics.stages).toMatchObject({
      pipeline: "modules",
      status: "succeeded",
      goals: { checked: false },
    });
  });

  test("goal scenarios of the plan go to G1 only when the host has a browser (B2-24)", async () => {
    const off = await build(newSystem(), "dental");
    expect(off.rec.gates.find((g) => g.level === "G1")?.goalScenarios).toBeUndefined();
    const on = await build(newSystem(), "dental", { goalBrowser: true });
    const g1 = on.rec.gates.find((g) => g.level === "G1");
    expect(g1?.goalScenarios?.length).toBeGreaterThan(0);
    expect(g1?.goalScenarios?.map((s) => s.id)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^GS-/)]),
    );
  });

  test("G2 findings only the owner can fix (operator of personal data) do not fail the build; the summary says so", async () => {
    const sys = newSystem();
    const { host, rec } = memHost(sys, "dental");
    const g2: GateReport = {
      ...passing("G2", 1, false),
      checks: [
        {
          id: "G2-PII-06",
          status: "fail",
          severity: "blocker",
          message_ru: "Не указано: название оператора ПДн",
        },
      ],
    };
    const out = await runBuildV2(
      { ...host, runGates: async (level) => (level === "G2" ? g2 : passing(level, sys.version)) },
      { plan: approvedPlan(scenario("dental")), planRevision: 1 },
    );
    expect(out.status).toBe("succeeded");
    expect((out as { summary_ru: string }).summary_ru).toContain("данные оператора персональных данных");
    const other = await runBuildV2(
      {
        ...memHost(newSystem(), "dental").host,
        runGates: async (level) =>
          level === "G2"
            ? {
                ...g2,
                checks: [
                  ...g2.checks,
                  {
                    id: "G2-PERM-01",
                    status: "fail",
                    severity: "blocker",
                    message_ru: "Гость видит чужие заявки",
                  },
                ],
              }
            : passing(level, 1),
      },
      { plan: approvedPlan(scenario("dental")), planRevision: 1 },
    );
    expect(other).toMatchObject({ status: "failed", code: "GATES_FAILED" });
    expect((other as { message_ru: string }).message_ru).toContain("Гость видит чужие заявки");
    expect(rec.calls).toEqual(["build_texts", "build_design"]);
  });

  test("a repeated build of the same plan reuses every stage and pays nothing", async () => {
    const sys = newSystem();
    const first = await build(sys, "dental");
    expect(first.out?.status).toBe("succeeded");
    const again = await build(sys, "dental");
    expect(again.out?.status).toBe("succeeded");
    expect(again.rec.calls).toEqual([]);
    expect(again.rec.creditsMilli).toBe(0);
    expect(sys.commits).toBe(1);
    expect(stagesOf(again.rec, "reused")).toEqual([
      "plan",
      "texts",
      "design",
      "photos",
      "compile",
      "custom",
      "gates",
    ]);
  });

  test("checkpoints of another plan are ignored", async () => {
    const sys = newSystem();
    await build(sys, "dental");
    const other = approvedPlan(scenario("dental"));
    other.goals = [
      { id: other.goals[0]?.id ?? "leads", statement: "Пациенты оставляют заявки, мы их не теряем" },
      ...other.goals.slice(1),
    ];
    const r = await build(sys, "dental", { plan: other });
    expect(r.out?.status).toBe("succeeded");
    expect(r.rec.calls).toEqual(["build_texts", "build_design"]);
    expect(stagesOf(r.rec, "reused")).toEqual([]);
  });
});

describe("failure at any stage → continue from the last checkpoint without paying again (acceptance)", () => {
  const cases: { stage: V2Stage | "gates_report"; plan?: () => SystemPlan; reusedAfter: string[] }[] = [
    { stage: "plan", reusedAfter: [] },
    { stage: "texts", reusedAfter: ["plan"] },
    { stage: "design", reusedAfter: ["plan", "texts"] },
    { stage: "compile", reusedAfter: ["plan", "texts", "design", "photos"] },
    { stage: "custom", plan: withCustom, reusedAfter: ["plan", "texts", "design", "photos", "compile"] },
    { stage: "gates", reusedAfter: ["plan", "texts", "design", "photos", "compile", "custom"] },
    { stage: "gates_report", reusedAfter: ["plan", "texts", "design", "photos", "compile", "custom"] },
  ];

  test.each(cases.map((c) => [c.stage, c] as const))("fault at %s", async (_s, c) => {
    const plan = c.plan?.() ?? approvedPlan(scenario("dental"));
    const sc = c.plan ? "dental_custom" : "dental";
    const clean = await build(newSystem(), sc, { plan });
    expect(clean.out?.status).toBe("succeeded");

    const sys = newSystem();
    const failed = await build(sys, sc, { plan, fault: { stage: c.stage, on: "throw" } });
    if (c.stage === "gates_report") {
      expect(failed.out).toMatchObject({ status: "failed", code: "GATES_FAILED", retryable: true });
      expect((failed.out as { message_ru: string }).message_ru).toContain("Экран «/» не открылся");
    } else expect(failed.error).toBeTruthy();
    expect(failed.rec.events.some((e) => e.type === "build_metrics")).toBe(true);

    const retry = await build(sys, sc, { plan });
    expect(retry.out?.status, JSON.stringify(retry.error)).toBe("succeeded");
    expect(stagesOf(retry.rec, "reused")).toEqual(c.reusedAfter);
    // Every model call is paid once over both runs: the same credits as a clean build.
    expect(failed.rec.creditsMilli + retry.rec.creditsMilli).toBe(clean.rec.creditsMilli);
    expect([...failed.rec.calls, ...retry.rec.calls].sort()).toEqual([...clean.rec.calls].sort());
    // One compiled revision unless the commit itself failed (+ one with the custom parts on top of it).
    expect(sys.commits).toBe(c.plan ? 2 : 1);
  });
});

describe("stage budgets (₽)", () => {
  test("a call that does not fit the stage budget stops the build before any call, with a clear reason", async () => {
    const sys = newSystem();
    const r = await build(sys, "dental", { params: { budgets: { texts: 0.5 } } });
    expect(r.out).toMatchObject({ status: "failed", code: "STAGE_BUDGET_EXCEEDED", retryable: false });
    expect((r.out as { message_ru: string }).message_ru).toMatch(/Пишу тексты.*0\.5 ₽|до 0\.5 ₽/);
    expect(r.rec.calls).toEqual([]);
    expect(sys.checkpoints.has("plan")).toBe(true);
  });

  test("the whole build budget counts the stages paid by earlier runs", async () => {
    const r = await build(newSystem(), "dental", { params: { budgets: { total: 1 } } });
    expect(r.out).toMatchObject({ status: "failed", code: "STAGE_BUDGET_EXCEEDED" });
    expect((r.out as { message_ru: string }).message_ru).toContain("сборку (до 1 ₽)");
  });

  test.each([
    ["T1 (glm-5.3)", false, "glm-5.3"],
    ["«Только РФ», T0 (glm-5.1)", true, "glm-5.1"],
  ] as const)(
    "on the recorded answers the average build ≤ 15 ₽ by the models.yaml prices, interview and plan included — %s",
    async (_t, ruOnly, modelId) => {
      const model = reg.models.find((m) => m.id === modelId);
      if (!model) throw new Error(modelId);
      const totals: number[] = [];
      for (const sc of B2_SCENARIOS) {
        const r = await build(newSystem(), sc.name, { ruOnly });
        expect(r.out?.status).toBe("succeeded");
        // The interview turn and the planner are paid before the approval (their runs); same recorded answers.
        const beforeRub = fixtureLines(sc)
          .filter((l: FixtureLine) => l.callType === "interview" || l.callType === "system_plan")
          .reduce(
            (s, l) =>
              s +
              costRub(model.price, {
                inputTokens: l.usage.promptTokens,
                cachedTokens: l.usage.cachedPromptTokens,
                outputTokens: l.usage.completionTokens,
              }),
            0,
          );
        const buildRub = rub(r.rec.creditsMilli);
        expect(buildRub).toBeCloseTo((r.out as { costRub: number }).costRub, 1);
        totals.push(buildRub + beforeRub);
      }
      const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
      expect(avg).toBeLessThanOrEqual(15);
      expect(Math.max(...totals)).toBeLessThanOrEqual(15);
    },
  );
});

describe("texts and design stages", () => {
  const scripted =
    (answers: Record<string, unknown>): ((input: RouteInput) => Promise<RouteOutput>) =>
    async (input) => {
      const name = input.tools?.[0]?.name ?? "";
      return {
        tier: "T1",
        model: "glm-5.3",
        result: {
          toolCalls: [{ id: "c", name, args: answers[name] as Record<string, unknown> }],
          finishReason: "tool-calls",
        },
        usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 200 },
        creditsCharged: 0.06,
        creditsMilli: 60,
        routeReason: "default_T1",
        scrubbed: true,
        ruFallback: false,
      };
    };

  test("invented numbers in the texts → repairs, then the planner's texts stay (fallback, not a failure)", async () => {
    const sc = scenario("dental");
    const sys = newSystem();
    const r = await build(sys, "dental", {
      route: scripted({
        submit_texts: {
          sections: [
            {
              index: 1,
              content: {
                title: "Скидка 50% на всё",
                subtitle: "Перезвоним за 15 минут",
                cta: "Оставить заявку",
              },
            },
          ],
        },
        submit_design: sc.design,
      }),
    });
    expect(r.out?.status).toBe("succeeded");
    expect(r.rec.calls.filter((c) => c === "build_texts")).toHaveLength(3);
    expect(sys.files["ui/pages/Home.tsx"]).toContain("Лечим зубы без боли");
    expect(sys.files["ui/pages/Home.tsx"]).not.toContain("50%");
    const m = r.rec.events.find((e) => e.type === "build_metrics")?.payload.stages as Record<
      string,
      { fallback?: boolean }
    >;
    expect(m.texts?.fallback).toBe(true);
  });

  test("the client's brand colour survives the design stage", async () => {
    const sc = scenario("dental");
    const plan = approvedPlan(sc);
    plan.design = {
      ...plan.design,
      accent: "#C2185B",
      direction: { ...plan.design.direction, notes: "Фирменный цвет клиента" },
    };
    const sys = newSystem();
    const r = await build(sys, "dental", { plan });
    expect(r.out?.status).toBe("succeeded");
    expect(sys.spec.theme?.accent).toBe("#C2185B");
    expect(sys.spec.theme?.preset).toBe("calm");
  });

  test("custom parts are written on top of the compiled draft (B2-23); the gates check that revision", async () => {
    const sys = newSystem();
    const r = await build(sys, "dental_custom", { plan: withCustom() });
    expect(r.out).toMatchObject({ status: "succeeded", revision: 2 });
    expect(Object.keys(sys.files)).toEqual(
      expect.arrayContaining(["ui/custom/CustomPriceQuiz.tsx", "functions/custom/leads_month.ts"]),
    );
    expect(sys.spec.pages?.find((p) => p.route === "/custom-price-quiz")).toMatchObject({
      file: "ui/custom/CustomPriceQuiz.tsx",
      roles: ["guest", "owner"],
    });
    expect(sys.spec.functions?.find((f) => f.name === "customLeadsMonth")).toMatchObject({
      kind: "query",
      roles: ["owner"],
    });
    expect(sys.requests).toEqual([]);
    expect(r.rec.calls).toEqual(["build_texts", "build_design", "build_custom"]);
    expect((r.out as { summary_ru: string }).summary_ru).toContain(
      "Дописано под вашу задачу: «Подбор лечения», «Заявки за месяц».",
    );
  });

  test("a custom stage of B2-23 plugs in through params.custom", async () => {
    const custom: CustomStageFn = async ({ plan, budgetRub }) => ({
      data: { built: plan.custom.map((c) => c.id) },
      costMilli: 0,
      notes_ru: [`Дописано в пределах ${budgetRub} ₽`],
    });
    const r = await build(newSystem(), "dental", { plan: withCustom(), params: { custom } });
    expect((r.out as { summary_ru: string }).summary_ru).toContain("Дописано в пределах 20 ₽");
  });

  test("owner-only compliance fields of the draft survive a rebuild", () => {
    const spec = emptySpec("A");
    const cur: AppSpec = {
      ...emptySpec("A"),
      compliance: { operatorName: "ИП Пример", consentTemplateId: "x" },
    };
    expect(withOwnerFields({ ...spec, compliance: { consentTemplateId: "y" } }, cur).compliance).toEqual({
      consentTemplateId: "y",
      operatorName: "ИП Пример",
    });
  });
});
