// In-memory BuildHost (tests, eval harness): AppSpec revisions via applyOps, a staged file tree, gates through
// @wizard/gates runGates, events collected in order. platform-api provides the durable host (M0-26).
import { type AppSpec, applyOps, LruIdempotencyStore } from "@wizard/appspec";
import { type GateContext, type GateReport, type RuntimeHandle, runGates } from "@wizard/gates";
import type { OrgPolicy, RouteInput, RouteOutput } from "@wizard/llm";
import type postgres from "postgres";
import { runBuild } from "./builder.js";
import type {
  BuilderGateLevel,
  BuilderQa,
  BuildHost,
  BuildOutcome,
  BuildParams,
  HostRouteInput,
  InputAnswer,
  InputRequest,
  OrchestratorAnswer,
} from "./types.js";

export interface RecordedEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface MemoryRevision {
  version: number;
  kind: "ops" | "files";
  ops?: readonly unknown[];
  files?: string[];
}

type RouteLike =
  | ((input: RouteInput) => Promise<RouteOutput>)
  | { route(input: RouteInput): Promise<RouteOutput> };
type GateFn = (ctx: GateContext) => Promise<GateReport>;

export interface MemoryHostOptions {
  spec: AppSpec;
  version?: number;
  files?: Iterable<[string, string]>;
  /** A @wizard/llm Router or a route() function. */
  route: RouteLike;
  orgPolicy?: OrgPolicy | null;
  orgId?: string;
  runId?: string;
  systemId?: string;
  /** Needed by the default gate runner (@wizard/gates runGates): migrator connection and a unique system key. */
  db?: postgres.Sql;
  systemKey?: string;
  milestone?: string;
  /** G1 on a real runtime (apps/runtime createRuntimeApp in test mode) and the DB role it switches to. */
  runtime?: RuntimeHandle;
  runtimeRole?: string;
  /** Per-level gate override (e.g. a G1 stub until M0-11). */
  gates?: Partial<Record<BuilderGateLevel, GateFn>>;
  qa?: BuilderQa;
  answer?: (req: InputRequest) => InputAnswer | Promise<InputAnswer>;
  askOrchestrator?: (q: { question: string; options?: string[] }) => Promise<OrchestratorAnswer>;
  managesBudget?: boolean;
  signal?: AbortSignal;
}

export interface MemoryHost {
  host: BuildHost;
  events: RecordedEvent[];
  revisions: MemoryRevision[];
  /** Route inputs in call order (as the host received them). */
  calls: HostRouteInput[];
  state(): { spec: AppSpec; version: number; files: Map<string, string> };
}

const NO_QA: BuilderQa = {
  generate: async () => [],
  explain: async () => [],
};

export function createMemoryHost(o: MemoryHostOptions): MemoryHost {
  let spec = o.spec;
  let version = o.version ?? 0;
  const committed = new Map<string, string>(o.files ?? []);
  const staged = new Map<string, string>();
  const events: RecordedEvent[] = [];
  const revisions: MemoryRevision[] = [];
  const calls: HostRouteInput[] = [];
  const idem = new LruIdempotencyStore();
  const runId = o.runId ?? "run-memory";
  const route = typeof o.route === "function" ? o.route : o.route.route.bind(o.route);
  let inputs = 0;

  const emit = (type: string, payload: Record<string, unknown>) => {
    events.push({ seq: events.length + 1, type, payload });
  };

  const defaultGate = (level: BuilderGateLevel): GateFn => {
    const custom = o.gates?.[level];
    if (custom) return custom;
    return (ctx) => runGates(level, ctx);
  };

  const host: BuildHost = {
    run: { id: runId },
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.managesBudget ? { managesBudget: true } : {}),
    ...(o.askOrchestrator ? { askOrchestrator: o.askOrchestrator } : {}),
    qa: o.qa ?? NO_QA,
    emit,
    runStep: (_name, fn) => fn(),
    async route(input) {
      calls.push(input);
      const { step, upperBoundCredits: _ub, ...rest } = input;
      return route({
        ...rest,
        orgPolicy: o.orgPolicy ?? { ruOnly: false, t1Restricted: false },
        ctx: {
          orgId: o.orgId ?? "00000000-0000-4000-8000-000000000001",
          runId,
          ...(o.systemId ? { systemId: o.systemId } : {}),
          ...(step ? { step } : {}),
        },
        ...(o.signal ? { signal: o.signal } : {}),
      });
    },
    async runGates(level, overrides) {
      emit("gate_started", { level, revision: version });
      const t0 = Date.now();
      const files = new Map(committed);
      for (const [p, c] of staged) files.set(p, c);
      const gate = defaultGate(level);
      if (!o.gates?.[level] && !o.db) throw new Error(`memory host: db is required for ${level}`);
      const ctx: GateContext = {
        spec,
        prevSpec: null,
        specVersion: version,
        files,
        env: "draft",
        systemKey: o.systemKey ?? "memory",
        db: o.db as postgres.Sql,
        milestone: o.milestone ?? "M0",
        ...(o.runtime ? { runtime: o.runtime } : {}),
        ...(o.runtimeRole ? { runtimeRole: o.runtimeRole } : {}),
        ...(overrides?.checks ? { checks: overrides.checks } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      };
      const report = await gate(ctx);
      const failed = report.checks.filter((c) => c.status === "fail" || c.status === "error");
      emit("gate_result", {
        level,
        passed: report.passed,
        revision: version,
        durationMs: Math.max(0, Date.now() - t0),
        failedChecks: failed.slice(0, 20).map((c) => ({
          id: c.id,
          message_ru: c.message_ru,
          ...(c.file ? { file: c.file } : {}),
          ...(c.line ? { line: c.line } : {}),
        })),
        totalChecks: report.checks.length,
      });
      return report;
    },
    async needsInput(req) {
      inputs += 1;
      const inputId = `${req.decisionId}-${inputs}`;
      emit("needs_input", {
        inputId,
        kind: "decision",
        decisionId: req.decisionId,
        prompt_ru: req.prompt_ru,
        options: req.options,
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      });
      if (!o.answer) throw new Error(`memory host: no answer for ${req.decisionId}`);
      const ans = await o.answer(req);
      emit("input_received", { inputId, choice: ans.choice });
      return ans;
    },
    store: {
      async getSpec() {
        return { spec, version };
      },
      async applyOps(ops, expectedVersion, idemKey) {
        const r = applyOps(spec, ops, expectedVersion, {
          currentVersion: version,
          env: "draft",
          author: "agent",
          runId,
          store: idem,
          ...(idemKey ? { idempotencyKey: idemKey } : {}),
        });
        if (r.ok && r.version !== version) {
          spec = r.spec;
          version = r.version;
          revisions.push({ version, kind: "ops", ops });
        }
        return r;
      },
      async writeFile(path, content) {
        staged.set(path, content);
      },
      async readFile(path) {
        return staged.get(path) ?? committed.get(path) ?? null;
      },
      async listFiles(prefix = "") {
        const all = new Set([...committed.keys(), ...staged.keys()]);
        return [...all].filter((p) => p.startsWith(prefix)).sort();
      },
      async commitFiles() {
        if (staged.size === 0) return null;
        const paths = [...staged.keys()].sort();
        for (const [p, c] of staged) committed.set(p, c);
        staged.clear();
        version += 1;
        revisions.push({ version, kind: "files", files: paths });
        return { revision: version };
      },
    },
  };

  return {
    host,
    events,
    revisions,
    calls,
    state: () => {
      const files = new Map(committed);
      for (const [p, c] of staged) files.set(p, c);
      return { spec, version, files };
    },
  };
}

/** runBuild framed by run_started and run_finished/run_failed, as the platform does around its executor. */
export async function executeBuild(m: MemoryHost, params: BuildParams): Promise<BuildOutcome> {
  const base = m.state().version;
  const estimate = params.card.estimate?.credits.expected;
  m.host.emit("run_started", {
    kind: "build",
    mode: params.mode,
    baseRevision: base,
    credits: { estimate: estimate ?? params.cap, cap: params.cap },
  });
  const out = await runBuild(m.host, params);
  if (out.status === "failed")
    m.host.emit("run_failed", {
      code: out.code,
      message_ru: out.message_ru,
      retryable: out.retryable,
      lastGoodRevision: null,
    });
  else
    m.host.emit("run_finished", {
      status: out.status,
      resultRevision: out.status === "succeeded" ? out.resultRevision : null,
      creditsUsed: out.creditsUsed,
      summary_ru: out.summary_ru,
      prodUrl: null,
    });
  return out;
}
