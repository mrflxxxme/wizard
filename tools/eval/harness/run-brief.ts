// One harness run (eval.yaml#modes.harness): brief → orchestrator (answers or «по рекомендациям») → card → approve →
// builder on an in-memory host → G0 → G1, with the metrics of eval.yaml#metrics for the pair (brief, model).
import { randomBytes } from "node:crypto";
import {
  type BuildCard,
  type BuildOutcome,
  createMemoryHost,
  executeBuild,
  type InputAnswer,
  type InputRequest,
} from "../../../packages/agents/src/builder/index.ts";
import { createOrchestrator } from "../../../packages/agents/src/orchestrator/index.ts";
import { emptySpec } from "../../../packages/appspec/src/index.ts";
import { type GateContext, type GateReport, runGates } from "../../../packages/gates/src/index.ts";
import {
  createRegistry,
  createRouter,
  decideTier,
  getModel,
  LlmError,
  type LlmMode,
  MemoryUsageSink,
  type OrgPolicy,
  type Registry,
  type RouteInput,
  type RouteOutput,
} from "../../../packages/llm/src/index.ts";
import { createLeakMeter } from "../lib/canary.mjs";
import { round, scoreSpec } from "../lib/score.mjs";
import type { Sql } from "./db.ts";
import { type FixtureChoice, standInScenario } from "./fixtures.ts";
import type { G1Runtime } from "./g1.ts";
import { evalQa, withOwnerCompliance } from "./qa.ts";

export interface Brief {
  id: string;
  segment: "events" | "made_to_order" | "horizontal";
  title: string;
  text: string;
  canaries?: string[];
  answers?: Record<string, string>;
  expected: Record<string, string[]>;
}

export interface RunContext {
  llmMode: LlmMode;
  /** Model override for the build call types (eval.yaml#modes.harness.model_override); undefined = registry default. */
  modelId?: string;
  fixture: FixtureChoice | null;
  fixturesDir?: string;
  db: Sql;
  /** null = G1 is not run (live in CI: generated code never executes outside the sandbox, AGENTS.md). */
  g1: G1Runtime | null;
  env: Record<string, string | undefined>;
  forbiddenForT1: string[];
  /** Wraps the HTTP client of the router (live/record). */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export interface HarnessRun {
  brief: string;
  segment: string;
  model: string;
  tier: string | null;
  mode: "harness";
  llm_mode: LlmMode;
  fixture: string | null;
  skipped?: string;
  /** week0.mjs compatibility (M0-30): valid = g0_pass; attempts = G0 runs up to the first pass; score = coverage. */
  valid: boolean;
  attempts: number;
  score: ReturnType<typeof scoreSpec>;
  outcome: string;
  g0_pass: boolean;
  g0g1_pass: boolean;
  /** G1 was replaced by a pass-through stub (--gates=G0): g0g1_pass is not measured. */
  g1_skipped: boolean;
  coverage: number;
  tokens: { input: number; cached: number; output: number };
  cost_rub: number;
  credits: number;
  minutes: number;
  first_preview_minutes: number | null;
  steps: number;
  questions_asked: number;
  estimate_ratio: number | null;
  budget_exceeded: boolean;
  escalations: number;
  pii_leaks: number;
  pii: { canaryHits: number; forbiddenCalls: number; t1Payloads: number };
  fallback_rate: number;
  fixture_miss: boolean;
  llm_calls: { total: number; T0: number; T1: number; byCallType: Record<string, string> };
  gates: { level: string; passed: boolean; revision: number; failed: string[] }[];
  errors: string[];
}

/** Open org policy with a known region, as for a regular org (models.yaml#routing_algorithm). */
export const EVAL_POLICY: OrgPolicy = { ruOnly: false, t1Restricted: false };
export const BUILD_CALL_TYPES = ["plan", "build_ops", "build_code", "fix"] as const;
/** app.template the platform sets at system creation (M0-21 notes); horizontal systems start without one. */
const TEMPLATE_BY_SEGMENT: Record<string, string | undefined> = {
  events: "event_registration",
  made_to_order: "made_to_order",
};

/** Registry with `modelId` first in its tier for the build call types and that tier as the build default. */
export function registryFor(modelId: string | undefined, env: Record<string, string | undefined>): Registry {
  const base = createRegistry({}, env);
  if (!modelId) return base;
  const m = getModel(base, modelId);
  const routes = structuredClone(base.routes);
  for (const ct of BUILD_CALL_TYPES) {
    const r = routes[ct];
    r.chain[m.tier] = [m.id, ...(r.chain[m.tier] ?? []).filter((x) => x !== m.id)];
  }
  return {
    ...base,
    routes,
    models: base.models.map((x) => (x.id === m.id ? { ...x, enabled: true } : x)),
    buildDefaultTier: m.tier,
  };
}

/** Live/record: every request to a host that is not a T0 provider counts as a T1 payload (fail-safe). */
export function interceptFetch(
  inner: typeof globalThis.fetch,
  reg: Registry,
  env: Record<string, string | undefined>,
  onT1: (payload: string) => void,
): typeof globalThis.fetch {
  const t0 = Object.values(reg.providers)
    .filter((p) => p.tier === "T0")
    .map((p) => (env[p.baseUrlEnv] || p.defaultBaseUrl).replace(/\/+$/, ""))
    .filter(Boolean);
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!t0.some((b) => url.startsWith(b))) {
      const body =
        typeof init?.body === "string"
          ? init.body
          : input instanceof Request
            ? await input.clone().text()
            : init?.body
              ? String(init.body)
              : "";
      onT1(body);
    }
    return inner(input, init);
  };
}

const minutes = (ms: number) => round(ms / 60_000, 3);

export async function runBrief(brief: Brief, c: RunContext): Promise<HarnessRun> {
  const now = c.now ?? Date.now;
  const t0 = now();
  const reg = registryFor(c.modelId, c.env);
  const sink = new MemoryUsageSink();
  const meter = createLeakMeter({ canaries: brief.canaries ?? [], forbiddenForT1: c.forbiddenForT1 });
  const errors: string[] = [];
  let fixtureMiss = false;
  const runId = `eval-${randomBytes(6).toString("hex")}`;
  const orgId = "00000000-0000-4000-8000-00000000e7a1";

  const fixture =
    c.llmMode === "fixture" && c.fixture
      ? { suite: c.fixture.suite, name: c.fixture.name, ...(c.fixturesDir ? { dir: c.fixturesDir } : {}) }
      : c.llmMode === "record"
        ? {
            suite: "eval" as const,
            name: brief.id,
            brief: brief.text,
            ...(c.fixturesDir ? { dir: c.fixturesDir } : {}),
          }
        : undefined;
  const router = createRouter({
    mode: c.llmMode,
    registry: reg,
    sink,
    env: c.env,
    ...(fixture ? { fixture } : {}),
    ...(c.llmMode !== "fixture"
      ? { fetch: interceptFetch(c.fetch ?? globalThis.fetch, reg, c.env, (p) => meter.inspectT1(p)) }
      : {}),
  });

  // Fixture mode sends nothing over HTTP: the T1 payload is what the router would send — the scrubbed messages
  // and tool definitions of the same policy decision (decideTier), inspected for canaries and dropped.
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    try {
      const out = await router.route(input);
      if (c.llmMode === "fixture" && out.tier === "T1") {
        const d = decideTier(
          {
            callType: input.callType as never,
            messages: input.messages,
            ...(input.containsPiiHint !== undefined ? { containsPiiHint: input.containsPiiHint } : {}),
            ...(input.orgPolicy !== undefined ? { orgPolicy: input.orgPolicy } : {}),
          },
          reg,
        );
        meter.inspectT1(JSON.stringify({ messages: d.scrubbedMessages, tools: input.tools ?? [] }));
      }
      return out;
    } catch (e) {
      if (e instanceof LlmError && e.code === "FIXTURE_MISS") fixtureMiss = true;
      throw e;
    }
  };

  // ---- orchestrator ----
  let n = 0;
  const orch = createOrchestrator({
    route,
    orgPolicy: EVAL_POLICY,
    ctx: { orgId, runId },
    org: { plan: "free" },
    registry: reg,
    newId: () => `m${++n}`,
  });
  const scenario =
    c.llmMode === "fixture" && c.fixture?.standIn
      ? standInScenario(c.fixture.name, brief)
      : { text: brief.text, answers: brief.answers ?? {} };
  const answers = scenario.answers;
  let questionsAsked = 0;
  let handoff: Awaited<ReturnType<typeof orch.approve>>["handoff"];
  try {
    let r = await orch.submitBrief(orch.newSession(), scenario.text);
    for (const q of r.session.questions) {
      if (r.failure || r.session.state !== "asking") break;
      const optionId = answers[q.forkId];
      if (optionId && q.options.some((o) => o.id === optionId)) {
        r = await orch.answer(r.session, { questionId: q.id, optionId });
      }
    }
    if (!r.failure && r.session.state === "asking") {
      r = await orch.restByRecommendation(r.session);
    }
    questionsAsked = r.session.questions.length;
    if (r.failure) errors.push(`оркестратор: ${r.failure.code} ${r.failure.cause ?? ""}`.trim());
    else if (r.session.state !== "awaiting_approval")
      errors.push(`оркестратор: состояние ${r.session.state}`);
    else {
      const a = await orch.approve(r.session);
      handoff = a.handoff;
      if (!handoff) errors.push("оркестратор: карточка не одобрена");
    }
  } catch (e) {
    errors.push(`оркестратор: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ---- builder + gates ----
  const gateTimes: { level: string; passed: boolean; at: number }[] = [];
  let outcome: BuildOutcome | null = null;
  let mem: ReturnType<typeof createMemoryHost> | null = null;
  let escalationAnswers = 0;
  if (handoff) {
    const card = handoff.card as { title?: string; estimate?: { credits?: { expected?: number } } };
    const start = emptySpec((card.title ?? brief.title).slice(0, 80));
    const template = TEMPLATE_BY_SEGMENT[brief.segment];
    if (template) start.app.template = template;
    const timed =
      (level: "G0" | "G1", extra: Partial<GateContext> = {}) =>
      async (ctx: GateContext): Promise<GateReport> => {
        const spec = level === "G1" ? withOwnerCompliance(ctx.spec) : ctx.spec;
        const rep = await runGates(level, { ...ctx, spec, ...extra });
        gateTimes.push({ level, passed: rep.passed, at: now() });
        return rep;
      };
    // eval.yaml#metrics.escalations: auto-answer retry once, then give up (rollback); budget → stop.
    const answer = (req: InputRequest): InputAnswer => {
      if (req.decisionId === "budget") return { choice: "stop" };
      escalationAnswers += 1;
      return { choice: escalationAnswers === 1 ? "retry" : "rollback" };
    };
    mem = createMemoryHost({
      spec: start,
      route,
      orgPolicy: EVAL_POLICY,
      orgId,
      runId,
      db: c.db,
      systemKey: `ev${randomBytes(5).toString("hex")}`,
      milestone: "M0",
      gates: {
        G0: timed("G0"),
        G1: c.g1 ? timed("G1", { runtime: c.g1.rt, runtimeRole: c.g1.role }) : g1Skipped,
      },
      qa: evalQa(route, { orgPolicy: EVAL_POLICY, ctx: { orgId, runId } }),
      answer,
    });
    try {
      outcome = await executeBuild(mem, {
        card: handoff.card as BuildCard,
        cap: handoff.cap,
        mode: "create",
      });
      if (outcome.status === "failed") errors.push(`строитель: ${outcome.code} ${outcome.message_ru}`);
      else if (outcome.status === "cancelled") errors.push(`строитель: отменено (${outcome.reason})`);
    } catch (e) {
      errors.push(`строитель: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const tEnd = gateTimes.at(-1)?.at ?? now();

  // ---- metrics ----
  const events = mem?.events ?? [];
  const gates = events
    .filter((e) => e.type === "gate_result")
    .map((e) => ({
      level: String(e.payload.level),
      passed: e.payload.passed === true,
      revision: Number(e.payload.revision),
      failed: ((e.payload.failedChecks as { id: string; message_ru: string }[] | undefined) ?? []).map(
        (x) => `${x.id}: ${x.message_ru}`,
      ),
    }));
  const finalVersion = mem?.state().version ?? -1;
  const last = (level: string) => gates.filter((g) => g.level === level).at(-1);
  const g0 = last("G0");
  const g1 = last("G1");
  const g0Pass = !!g0?.passed && g0.revision === finalVersion;
  const g0g1Pass = !!c.g1 && g0Pass && !!g1?.passed && g1.revision === finalVersion;
  const g0Runs = gates.filter((g) => g.level === "G0");
  const firstPass = g0Runs.findIndex((g) => g.passed);
  const firstPreview = gateTimes.find((g) => g.level === "G0" && g.passed);

  const records = sink.records;
  for (const r of records) if (r.tier === "T1") meter.recordT1Call(r.callType);
  const ok = records.filter((r) => r.status === "ok");
  const byCallType: Record<string, string> = {};
  for (const r of ok)
    byCallType[r.callType] = [byCallType[r.callType], `${r.tier}:${r.routeReason}`].filter(Boolean).join(",");
  const credits = records.reduce((s, r) => s + r.creditsMilli, 0) / 1000;
  const expected = (handoff?.card as { estimate?: { credits?: { expected?: number } } } | undefined)?.estimate
    ?.credits?.expected;

  const buildModels = ok.filter((r) => (BUILD_CALL_TYPES as readonly string[]).includes(r.callType));
  const model = c.modelId ?? mostCommon(buildModels.map((r) => r.modelId)) ?? defaultBuildModel(reg);
  const tier = getModel(reg, model).tier;
  const spec = mem ? mem.state().spec : null;
  const score = scoreSpec(spec, brief.expected);
  const leak = meter.snapshot();

  return {
    brief: brief.id,
    segment: brief.segment,
    model,
    tier,
    mode: "harness",
    llm_mode: c.llmMode,
    fixture: c.llmMode === "fixture" && c.fixture ? `${c.fixture.suite}/${c.fixture.name}` : null,
    valid: g0Pass,
    attempts: firstPass >= 0 ? firstPass + 1 : Math.max(1, g0Runs.length),
    score,
    outcome: outcome ? outcome.status + (outcome.status === "failed" ? `:${outcome.code}` : "") : "no_build",
    g0_pass: g0Pass,
    g0g1_pass: g0g1Pass,
    g1_skipped: !c.g1,
    coverage: score.total,
    tokens: {
      input: records.reduce((s, r) => s + r.inputTokens, 0),
      cached: records.reduce((s, r) => s + r.cachedTokens, 0),
      output: records.reduce((s, r) => s + r.outputTokens, 0),
    },
    cost_rub: round(
      records.reduce((s, r) => s + r.costRub, 0),
      4,
    ),
    credits: round(credits, 3),
    minutes: minutes(tEnd - t0),
    first_preview_minutes: firstPreview ? minutes(firstPreview.at - t0) : null,
    steps: outcome?.steps ?? 0,
    questions_asked: questionsAsked,
    estimate_ratio: expected ? round(credits / expected, 3) : null,
    budget_exceeded:
      events.some((e) => e.type === "budget_exceeded") ||
      (outcome?.status === "cancelled" && outcome.reason === "budget_stop") ||
      (outcome?.status === "failed" && outcome.code === "BUDGET_STOPPED"),
    escalations: events.filter((e) => e.type === "needs_input").length,
    pii_leaks: leak.pii_leaks,
    pii: { canaryHits: leak.canaryHits, forbiddenCalls: leak.forbiddenCalls, t1Payloads: leak.t1Payloads },
    fallback_rate: ok.length
      ? round(ok.filter((r) => r.routeReason.startsWith("fallback_")).length / ok.length)
      : 0,
    fixture_miss: fixtureMiss,
    llm_calls: {
      total: ok.length,
      T0: ok.filter((r) => r.tier === "T0").length,
      T1: ok.filter((r) => r.tier === "T1").length,
      byCallType,
    },
    gates,
    errors,
  };
}

/** G1 stand-in for --gates=G0: passes without checks so the builder finishes after G0 (nothing is executed). */
async function g1Skipped(ctx: GateContext): Promise<GateReport> {
  return {
    level: "G1",
    passed: true,
    specVersion: ctx.specVersion,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    checks: [],
    summary: { pass: 0, fail: 0, warn: 0, skip: 1, error: 0 },
  };
}

/** The model the router tries first for build_ops at the registry's build default tier. */
export function defaultBuildModel(reg: Registry): string {
  const id = reg.routes.build_ops?.chain[reg.buildDefaultTier]?.[0];
  if (!id) throw new Error(`models.yaml: нет модели build_ops для ${reg.buildDefaultTier}`);
  return id;
}

function mostCommon(xs: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
