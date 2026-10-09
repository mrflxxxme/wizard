// V3-11 acceptance (build harness v3, specs/agents/builder-v3.md §3 C6, product.yaml D77_v3 (8)–(11)) on recorded
// answers (v3-harness-fixtures.ts: suite demo in a temporary dir, usage priced by models.yaml; no network, no money) and
// a virtual clock: the feature list from the brief's scenarios («must» first), the skeleton preview ≤ 5 min with zero
// model calls before it, scenarios one by one with a browser check (a failing one is rolled back), stop rules by
// scenarios, time (30 min), the cap (500 ₽) and the target (300 ₽) for «should», what is left in «Запросы на развитие»,
// checkpoints after each stage and scenario (a repeated build resumes and does not pay again), non-blocking questions
// answered in the brief and applied at the next step, the ready notice, hooks V3-13…15 skipped by default.
import { type AppSpec, emptySpec, type SystemBriefInput, systemBriefSchema } from "@wizard/appspec";
import type { GateReport, GoalScenarioInput } from "@wizard/gates";
import { createRegistry, createRouter, LlmError, type RouteInput } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import {
  briefNiche,
  DESIGN_CSS_FILE,
  runBuildV3,
  type ScenarioCheckInput,
  type ScenarioCheckResult,
  V3_STAGES,
  type V3BriefVersion,
  type V3Checkpoint,
  type V3Host,
  type V3Outcome,
  type V3Params,
  type V3ReadyNotice,
  type V3StageHook,
} from "../src/builder/index.js";
import type { DevelopmentRequestInput } from "../src/gaps.js";
import {
  CLINIC_MUST,
  CLINIC_SHOULD,
  clinicBrief,
  type FakeComposerOptions,
  fakeComposer,
  pageComposeMessages,
  v3Lines,
  writeFixture,
} from "./v3-harness-fixtures.js";

const OPEN = { ruOnly: false, t1Restricted: false };
const reg = createRegistry({ buildDefaultTier: "T1" });
const rub = (milli: number) => (milli / 1000) * reg.rubPerCredit;
const MIN = 60_000;
const SYSTEM_ID = "sys-clinic";

/** What survives between runs of one system: brief versions, draft revisions, checkpoints, requests, notices. */
interface Sys {
  briefs: V3BriefVersion[];
  version: number;
  spec: AppSpec;
  files: Record<string, string>;
  commits: string[];
  checkpoints: Map<string, V3Checkpoint>;
  requests: DevelopmentRequestInput[];
  notices: V3ReadyNotice[];
}

const newSys = (brief: SystemBriefInput = clinicBrief()): Sys => ({
  briefs: [{ version: 1, brief: systemBriefSchema.parse(brief) }],
  version: 0,
  spec: emptySpec("Клиника"),
  files: {},
  commits: [],
  checkpoints: new Map(),
  requests: [],
  notices: [],
});

const passing = (level: string, version: number, passed = true): GateReport => ({
  level: level as GateReport["level"],
  passed,
  specVersion: version,
  startedAt: "2026-10-08T00:00:00.000Z",
  durationMs: 1,
  checks: passed
    ? []
    : [{ id: "G1-RENDER-01", status: "fail", severity: "blocker", message_ru: "Страница «/» не открылась" }],
  summary: { pass: passed ? 1 : 0, fail: passed ? 0 : 1, warn: 0, skip: 0, error: 0 },
});

interface Rec {
  events: { type: string; payload: Record<string, unknown> }[];
  calls: string[];
  creditsMilli: number;
  checks: ScenarioCheckInput[];
  gates: { level: string; goalScenarios?: readonly GoalScenarioInput[] }[];
  callsAtPreview: number | null;
  asked: string[];
}

interface HostOptions {
  composer?: FakeComposerOptions;
  /** Latency of a model call by callType, ms (virtual clock). */
  latency?: Partial<Record<string, number>>;
  check?: (input: ScenarioCheckInput) => ScenarioCheckResult;
  /** Called after each browser check (e.g. the owner edits the brief meanwhile). */
  afterCheck?: (input: ScenarioCheckInput, sys: Sys) => void;
  gateFails?: (level: string) => boolean;
  hooks?: V3Host["hooks"];
  goalBrowser?: boolean;
  /** Recorded answers: pages (page_compose answers), heavier usage, the art director's answer. */
  lines?: { pages?: number; completionTokens?: number; artDirection?: boolean };
}

/** A V3Host over a fixture router and a virtual clock. */
function memHost(sys: Sys, o: HostOptions = {}) {
  const rec: Rec = {
    events: [],
    calls: [],
    creditsMilli: 0,
    checks: [],
    gates: [],
    callsAtPreview: null,
    asked: [],
  };
  const clock = { t: 0 };
  const brief = sys.briefs.at(-1)?.brief ?? systemBriefSchema.parse(clinicBrief());
  const composer = fakeComposer(o.composer);
  const dir = writeFixture(
    "clinic",
    v3Lines({
      brief: { goals: brief.goals, audience: brief.audience },
      niche: briefNiche(brief),
      seed: SYSTEM_ID,
      artDirection: o.lines?.artDirection ?? false,
      pages: o.lines?.pages ?? 30,
      ...(o.lines?.completionTokens ? { completionTokens: o.lines.completionTokens } : {}),
      prompt: pageComposeMessages({ brief, design: {} as never }, brief.scenarios[0] as never),
    }),
  );
  const router = createRouter({
    mode: "fixture",
    fixture: { suite: "demo", name: "v3/clinic", dir },
    registry: reg,
    sink: { write: async () => {} },
    env: {},
  });
  const latency: Partial<Record<string, number>> = {
    page_compose: 60_000,
    art_direction: 18_000,
    ...o.latency,
  };
  const host: V3Host = {
    run: { id: `run-${Math.random().toString(16).slice(2)}` },
    systemId: SYSTEM_ID,
    runStep: (_n, fn) => fn(),
    emit: (type, payload) => {
      rec.events.push({ type, payload });
    },
    route: async (input) => {
      const { step: _s, upperBoundCredits: _u, ...rest } = input;
      rec.calls.push(input.callType);
      clock.t += latency[input.callType] ?? 0;
      const out = await router.route({ ...rest, orgPolicy: OPEN, ctx: { orgId: "org" } } as RouteInput);
      rec.creditsMilli += out.creditsMilli;
      return out;
    },
    brief: async () => sys.briefs.at(-1) ?? null,
    checkpoints: {
      load: async () => [...sys.checkpoints.values()].map((c) => structuredClone(c)),
      save: async (cp) => {
        sys.checkpoints.set(cp.key, JSON.parse(JSON.stringify(cp)) as V3Checkpoint);
      },
    },
    currentSpec: async () => ({ spec: sys.spec, version: sys.version }),
    commit: async ({ spec, files, summary_ru }) => {
      clock.t += 1000;
      sys.version += 1;
      sys.spec = spec;
      sys.files = { ...files };
      sys.commits.push(summary_ru);
      return { revision: sys.version };
    },
    runGates: async (level, ov) => {
      clock.t += 30_000;
      rec.gates.push({ level, ...(ov?.goalScenarios ? { goalScenarios: ov.goalScenarios } : {}) });
      return passing(level, sys.version, !o.gateFails?.(level));
    },
    composer,
    preview: async () => {
      clock.t += 15_000;
      rec.callsAtPreview = rec.calls.length;
      return { ok: true, problems: [] };
    },
    checkScenario: async (input) => {
      clock.t += 20_000;
      rec.checks.push(input);
      const r = o.check?.(input) ?? { ok: true, problems: [], browser: true };
      o.afterCheck?.(input, sys);
      return r;
    },
    goalBrowser: o.goalBrowser ?? false,
    ...(o.hooks ? { hooks: o.hooks } : {}),
    questions: {
      ask: async (q) => {
        rec.asked.push(q.id);
      },
    },
    recordDevelopmentRequest: async (input) => {
      sys.requests.push(input);
    },
    notifyReady: async (n) => {
      sys.notices.push(n);
    },
  };
  return { host, rec, clock, composer };
}

async function build(sys: Sys, o: HostOptions & { params?: Partial<V3Params> } = {}) {
  const { host, rec, clock, composer } = memHost(sys, o);
  let out: V3Outcome | null = null;
  let error: unknown = null;
  try {
    out = await runBuildV3(host, { now: () => clock.t, appName: "Клиника", ...o.params });
  } catch (e) {
    error = e;
  }
  return { out, error, rec, clock, composer };
}

const stagesOf = (rec: Rec, status: string) =>
  rec.events
    .filter((e) => e.type === "build_stage" && e.payload.status === status)
    .map((e) => e.payload.stage as string);
const ok = (out: V3Outcome | null) => {
  if (out?.status !== "succeeded") throw new Error(`build: ${JSON.stringify(out)}`);
  return out;
};
const scenarioCalls = (composer: ReturnType<typeof fakeComposer>) =>
  composer.log.filter((l) => l.kind === "scenario").map((l) => l.id);

describe("harness v3: features, skeleton preview, algorithms ahead of models", () => {
  test("clean build: must then should, preview ≤ 5 min with zero model calls before it, all scenarios checked", async () => {
    const sys = newSys();
    const { out, rec, composer } = await build(sys);
    const r = ok(out);
    // The feature list from the brief: «must» in brief order, then «should».
    expect(scenarioCalls(composer)).toEqual([...CLINIC_MUST, ...CLINIC_SHOULD]);
    // Brief, design (the owner's direction), backend and skeleton: no model call; the preview right after them.
    expect(rec.callsAtPreview).toBe(0);
    expect(r.previewMs).not.toBeNull();
    expect(r.previewMs as number).toBeLessThanOrEqual(5 * MIN);
    // Then the scenarios: one page_compose answer each; each one checked in a browser on its own revision.
    expect(rec.calls).toEqual(Array(6).fill("page_compose"));
    expect(rec.checks.map((c) => c.scenario.id)).toEqual([...CLINIC_MUST, ...CLINIC_SHOULD]);
    expect(new Set(rec.checks.map((c) => c.revision)).size).toBe(6);
    expect(rec.checks.find((c) => c.scenario.id === "s_book")?.goalScenarios.map((g) => g.id)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^GS-booking-/)]),
    );
    expect(r.stop.reason).toBe("done");
    expect(r.stop.message_ru).toBe("Все сценарии брифа готовы и проверены (6 из 6).");
    expect(r.scenarios.every((s) => s.status === "passed")).toBe(true);
    expect(r.summary_ru).toContain("готово 6 из 6 сценариев");
    // Economics: by the models.yaml prices within the target of a build.
    expect(rub(rec.creditsMilli)).toBeLessThanOrEqual(300);
    expect(r.costRub).toBeCloseTo(rub(rec.creditsMilli), 1);
    expect(r.durationMs).toBeLessThanOrEqual(30 * MIN);
  });

  test("stages in order with plain labels, hooks V3-13…15 reported as skipped, gates G0–G2 on the last revision", async () => {
    const sys = newSys();
    const { out, rec } = await build(sys);
    ok(out);
    expect(stagesOf(rec, "started")).toEqual([
      "brief",
      "design",
      "backend",
      "skeleton",
      "scenarios",
      "gates",
    ]);
    expect(stagesOf(rec, "done")).toEqual(["brief", "design", "backend", "skeleton", "scenarios", "gates"]);
    expect(stagesOf(rec, "skipped")).toEqual(["critic", "template_gate", "techreview"]);
    const stageEvents = rec.events.filter((e) => e.type === "build_stage");
    expect(stageEvents.every((e) => e.payload.total === V3_STAGES.length)).toBe(true);
    expect(stageEvents.find((e) => e.payload.stage === "skeleton")?.payload.label_ru).toBe(
      "Собираю каркас страниц",
    );
    const left = stageEvents.map((e) => e.payload.remainingSec as number);
    expect(left.at(-1)).toBe(0);
    expect(rec.gates.map((g) => g.level)).toEqual(["G0", "G1", "G2"]);
    // Scenario progress for the chat: «Сценарий k из n», a line per scenario with the spend «потрачено X ₽ из 500 ₽».
    const steps = rec.events.filter(
      (e) => e.type === "step_started" && String(e.payload.step).startsWith("scenario:"),
    );
    expect(steps[0]?.payload.label_ru).toMatch(
      /^Сценарий 1 из 6: Когда посетитель выбирает услугу и время — система/,
    );
    const lines = rec.events.filter((e) => e.type === "agent_message").map((e) => String(e.payload.text));
    expect(lines.some((t) => /^Готово: .*потрачено \d+ ₽ из 500 ₽\.$/.test(t))).toBe(true);
    // The system: the backend of the brief's plan, the design system file, the public pages registered in the spec.
    expect(sys.files[DESIGN_CSS_FILE]).toContain("@theme");
    expect(sys.files["functions/booking/busySlots.ts"]).toBeDefined();
    const routes = (sys.spec.pages ?? []).map((p) => p.route);
    expect(routes).toEqual(expect.arrayContaining(["/", "/booking", "/services", "/s-doctors", "/cabinet"]));
    expect(sys.spec.pages?.find((p) => p.route === "/")?.roles).toContain("guest");
    expect(sys.spec.theme?.accent).toMatch(/^#[0-9A-Fa-f]{6}$/);
    // Checkpoints: every stage and every scenario.
    expect([...sys.checkpoints.keys()].sort()).toEqual(
      [
        ...V3_STAGES,
        ...[...CLINIC_MUST, ...CLINIC_SHOULD].map((id) => `scenario:${id}`),
        "questions",
        "draft",
      ].sort(),
    );
    // The ready notice.
    expect(sys.notices).toHaveLength(1);
    expect(sys.notices[0]).toMatchObject({ scenariosDone: 6, scenariosTotal: 6, revision: sys.version });
    const metrics = rec.events.find((e) => e.type === "build_metrics")?.payload as {
      stages: Record<string, unknown>;
    };
    expect(metrics.stages).toMatchObject({ pipeline: "v3", status: "succeeded", stop: "done" });
  });

  test("no direction in the brief: the art director is the only paid call before the preview", async () => {
    const sys = newSys(clinicBrief({ archetype: null }));
    const { out, rec } = await build(sys, { lines: { artDirection: true } });
    const r = ok(out);
    expect(rec.calls.slice(0, (rec.callsAtPreview ?? 0) + 1)).toEqual(["art_direction", "page_compose"]);
    expect(rec.callsAtPreview).toBe(1);
    expect(r.previewMs as number).toBeLessThanOrEqual(5 * MIN);
    expect(sys.checkpoints.get("design")?.data).toMatchObject({
      source: "model",
      styleName: "Спокойная клиника",
    });
  });

  test("a skeleton that calls a model breaks the contract: the build fails before any spend", async () => {
    const { out, rec } = await build(newSys(), { composer: { skeletonCallsModel: true } });
    expect(out).toMatchObject({ status: "failed", code: "INTERNAL", retryable: false });
    expect(rec.calls).toEqual([]);
  });
});

describe("harness v3: browser check, stop rules, «Запросы на развитие»", () => {
  test("a scenario that fails the browser check is rolled back; the build goes on; it goes to the requests", async () => {
    const sys = newSys();
    const { out, rec } = await build(sys, {
      check: (c) =>
        c.scenario.id === "s_lead"
          ? { ok: false, problems: ["Форма заявки не отправилась"], browser: true }
          : { ok: true, problems: [], browser: true },
    });
    const r = ok(out);
    expect(r.scenarios.find((s) => s.id === "s_lead")).toMatchObject({
      status: "failed",
      reason: "не прошёл проверку в браузере: Форма заявки не отправилась",
    });
    expect(r.scenarios.filter((s) => s.status === "passed")).toHaveLength(5);
    expect(r.stop.message_ru).toContain("Готово 5 из 6 сценариев");
    // Rolled back: the lead page of the scenario is not in the system, the next scenarios are.
    expect(Object.values(sys.files).some((src) => src.includes("сохраняет заявку"))).toBe(false);
    expect(Object.values(sys.files).some((src) => src.includes("показывает услуги с ценами"))).toBe(true);
    expect(sys.requests).toEqual([
      expect.objectContaining({
        category: "other",
        quote: expect.stringContaining("посетитель оставляет заявку на консультацию"),
      }),
    ]);
    expect(rec.calls).toHaveLength(6);
  });

  test("time: scenarios stop before the 30-minute cap; the rest goes to the requests with a Russian reason", async () => {
    const sys = newSys();
    const { out, clock, composer } = await build(sys, { latency: { page_compose: 8 * MIN } });
    const r = ok(out);
    expect(r.stop.reason).toBe("time");
    expect(r.stop.message_ru).toMatch(
      /^Доводку сценариев остановил: вышло время сборки \(30 мин\)\. Готово 3 из 6/,
    );
    expect(scenarioCalls(composer)).toEqual(["s_book", "s_lead", "s_prices"]);
    expect(clock.t).toBeLessThanOrEqual(30 * MIN);
    expect(r.scenarios.filter((s) => s.status === "stopped").map((s) => s.reason)).toEqual(
      Array(3).fill("не успели: вышло время сборки"),
    );
    expect(sys.requests.map((q) => q.quote)).toHaveLength(3);
    // The build still ends with the gates and the notice: the owner gets a working system.
    expect(sys.notices).toHaveLength(1);
  });

  test("budget: «must» stop at the cap, the spend never passes it; the reason names the cap", async () => {
    const sys = newSys();
    const { out, rec } = await build(sys, {
      lines: { completionTokens: 12_000 },
      composer: { calls: 2 },
      params: { limits: { capRub: 60 } },
    });
    const r = ok(out);
    expect(r.stop.reason).toBe("budget");
    expect(r.stop.message_ru).toMatch(
      /следующий шаг вышел бы за потолок сборки 60 ₽ \(потрачено \d+ ₽ из 60 ₽\)/,
    );
    expect(rub(rec.creditsMilli)).toBeLessThanOrEqual(60);
    const passed = r.scenarios.filter((s) => s.status === "passed").length;
    expect(passed).toBeGreaterThan(0);
    expect(passed).toBeLessThan(6);
    expect(sys.requests.length).toBe(6 - passed);
  });

  test("target: «should» scenarios are not brought up beyond the target; «must» ones are all done", async () => {
    const sys = newSys();
    const { out, rec, composer } = await build(sys, {
      lines: { completionTokens: 12_000 },
      composer: { calls: 2 },
      params: { limits: { capRub: 200, targetRub: 70 } },
    });
    const r = ok(out);
    expect(scenarioCalls(composer)).toEqual([...CLINIC_MUST]);
    expect(r.stop.reason).toBe("target");
    expect(r.stop.message_ru).toMatch(
      /^Желательные сценарии не доводил, чтобы уложиться в целевые 70 ₽.*Обязательные готовы: 4 из 4/,
    );
    expect(r.scenarios.filter((s) => s.priority === "should").every((s) => s.status === "stopped")).toBe(
      true,
    );
    expect(rub(rec.creditsMilli)).toBeLessThanOrEqual(200);
  });
});

describe("harness v3: checkpoints — a repeated build resumes and does not pay again", () => {
  test("models down on the third scenario → the repeat reuses skeleton and two scenarios; Σ = a clean build", async () => {
    const clean = await build(newSys());
    const cleanRub = rub(clean.rec.creditsMilli);

    const sys = newSys();
    const down = new LlmError("LLM_UNAVAILABLE", "все модели недоступны");
    const first = await build(sys, { composer: { fail: (id) => (id === "s_prices" ? down : null) } });
    expect(first.out).toBeNull();
    expect(first.error).toBe(down);
    expect(first.rec.calls).toEqual(["page_compose", "page_compose"]);
    expect(sys.checkpoints.has("scenario:s_book")).toBe(true);
    expect(sys.checkpoints.has("scenario:s_prices")).toBe(false);
    const metrics = first.rec.events.find((e) => e.type === "build_metrics")?.payload as {
      stages: Record<string, unknown>;
    };
    expect(metrics.stages).toMatchObject({ status: "failed" });

    const second = await build(sys);
    const r = ok(second.out);
    expect(scenarioCalls(second.composer)).toEqual(["s_prices", "s_remind", ...CLINIC_SHOULD]);
    expect(second.composer.log.some((l) => l.kind === "skeleton")).toBe(false);
    expect(stagesOf(second.rec, "reused")).toEqual(expect.arrayContaining(["brief", "design", "skeleton"]));
    expect(second.rec.calls).toHaveLength(4);
    expect(r.scenarios.filter((s) => s.reused).map((s) => s.id)).toEqual(["s_book", "s_lead"]);
    expect(rub(first.rec.creditsMilli + second.rec.creditsMilli)).toBeCloseTo(cleanRub, 2);
    expect(r.scenarios.every((s) => s.status === "passed")).toBe(true);
    // The repeated system has every scenario's page, the reused ones included.
    expect(Object.values(sys.files).some((src) => src.includes("сохраняет заявку"))).toBe(true);
  });

  test("gates fail → GATES_FAILED retryable; the repeat starts from the gates without a single model call", async () => {
    const sys = newSys();
    const first = await build(sys, { gateFails: (l) => l === "G1" });
    expect(first.out).toMatchObject({ status: "failed", code: "GATES_FAILED", retryable: true });
    expect((first.out as { message_ru: string }).message_ru).toContain("Страница «/» не открылась");
    expect(sys.notices).toHaveLength(0);
    const second = await build(sys);
    ok(second.out);
    expect(second.rec.calls).toEqual([]);
    expect(second.rec.checks).toEqual([]);
    expect(sys.notices).toHaveLength(1);
  });

  test("a brief edit invalidates only what it touches: a new «must» scenario is built, the rest reused", async () => {
    const sys = newSys();
    ok((await build(sys)).out);
    const b = clinicBrief();
    const extra = {
      id: "s_gift",
      actor: "visitor" as const,
      when: "посетитель покупает подарочный сертификат",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["оформляет сертификат"],
    };
    sys.briefs.push({
      version: 2,
      brief: systemBriefSchema.parse({ ...b, scenarios: [...(b.scenarios ?? []), extra] }),
    });
    const second = await build(sys);
    const r = ok(second.out);
    expect(scenarioCalls(second.composer)).toEqual(["s_gift"]);
    expect(r.scenarios.find((s) => s.id === "s_gift")?.status).toBe("passed");
  });
});

describe("harness v3: non-blocking questions, the brief re-read, hooks", () => {
  test("questions are asked without a stop; the owner's answer in the brief applies at the next step", async () => {
    const sys = newSys();
    const brief = sys.briefs[0]?.brief;
    if (!brief) throw new Error("brief");
    const { out, rec, composer } = await build(sys, {
      afterCheck: (c, s) => {
        // While the first scenario was being checked the owner answered «who works» in the brief panel.
        if (c.scenario.id !== "s_book" || s.briefs.length > 1) return;
        s.briefs.push({
          version: 2,
          brief: {
            ...brief,
            qa: [
              ...brief.qa,
              {
                q: "Кто, кроме вас, будет работать в системе?",
                a: "Несколько сотрудников",
                recommended: "Я и администратор",
                chosen: "option",
              },
            ],
          },
        });
      },
    });
    const r = ok(out);
    // Asked during the build (no needs_input), the build went on with the recommended option.
    expect(rec.asked).toEqual(["plan_roles", "plan_booking_confirm"]);
    expect(rec.events.some((e) => e.type === "needs_input")).toBe(false);
    const asked = rec.events.find((e) => e.payload.messageId === "v3q_plan_roles")?.payload.text as string;
    expect(asked).toContain("Пока собираю с вариантом «Я и администратор»");
    // The first scenario was composed on brief v1; the next ones see v2 and the system with the staff role.
    expect(composer.log.filter((l) => l.kind === "scenario").map((l) => l.briefVersion)).toEqual([
      1, 2, 2, 2, 2, 2,
    ]);
    expect(
      rec.events.some((e) => String(e.payload.text ?? "").startsWith("Учёл ваш ответ: «Кто, кроме вас")),
    ).toBe(true);
    expect(sys.spec.roles.map((x) => x.name)).toContain("staff");
    expect(r.summary_ru).toContain("Основа системы пересобрана с учётом ваших ответов.");
    // A repeated build does not ask again.
    const again = await build(sys);
    expect(again.rec.asked).toEqual([]);
  });

  test("a brief that names its staff gets no question about who works", async () => {
    const { rec } = await build(newSys(clinicBrief({ roles: true })));
    expect(rec.asked).toEqual(["plan_booking_confirm"]);
  });

  test("hooks plug in without touching the loop: budget, files, notes; techreview blockers fail the build", async () => {
    const seen: { stage: string; budgetRub: number }[] = [];
    const critic: V3StageHook = async (ctx) => {
      seen.push({ stage: "critic", budgetRub: ctx.budgetRub });
      return {
        status: "done",
        files: new Map([
          ["ui/pages/Home.tsx", "export default function Page() { return <main>Правка критика</main>; }\n"],
        ]),
        notes: ["Критик поправил первый экран."],
      };
    };
    const sys = newSys();
    const { out } = await build(sys, { hooks: { critic } });
    const r = ok(out);
    expect(seen).toEqual([{ stage: "critic", budgetRub: 40 }]);
    expect(sys.files["ui/pages/Home.tsx"]).toContain("Правка критика");
    expect(r.summary_ru).toContain("Критик поправил первый экран.");
    expect(r.stages.critic?.status).toBe("done");
    expect(r.stages.techreview?.status).toBe("skipped");

    const techreview: V3StageHook = async () => ({
      status: "done",
      blockers: ["Права: клиент видит чужие записи"],
    });
    const failed = await build(newSys(), { hooks: { techreview } });
    expect(failed.out).toMatchObject({ status: "failed", code: "GATES_FAILED" });
    expect((failed.out as { message_ru: string }).message_ru).toContain("Права: клиент видит чужие записи");
  });

  test("the final G1 gets the goal scenarios of the done brief scenarios when the host has a browser", async () => {
    const { rec } = await build(newSys(), { goalBrowser: true });
    const g1 = rec.gates.find((g) => g.level === "G1");
    expect(g1?.goalScenarios?.map((g) => g.id)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^GS-booking-/), expect.stringMatching(/^GS-leads-/)]),
    );
  });
});
