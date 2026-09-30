import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RouteOutput, Router, RouterOptions } from "@wizard/llm";
import postgres from "postgres";
import { parse } from "yaml";
import { createPlatformApi, type PlatformApi, type PlatformApiOptions } from "../src/app.js";
import {
  type BuildHost,
  type BuildParams,
  type GateReport,
  type InterviewHost,
  type InterviewOutput,
  type RunExecutors,
  RunFailure,
} from "../src/runs/types.js";

export const ROOT = resolve(import.meta.dirname, "../../..");
export const BASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";

export const loadYaml = (rel: string): Record<string, unknown> =>
  parse(readFileSync(join(ROOT, rel), "utf8")) as Record<string, unknown>;

/** A throwaway database per test file (platform schema is fixed, so databases isolate parallel runs). */
export async function createTestDb(
  tag: string,
  o: { migrator?: boolean } = {},
): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `wz_api_${tag}_${randomBytes(4).toString("hex")}`;
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  if (o.migrator) {
    // As scripts/db.mjs does for the dev database: wizard_owner (draft migrator) may create app_* schemas.
    for (const role of ["wizard_owner", "wizard_runtime"])
      await admin.unsafe(`DO $$ BEGIN
        CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$`);
    await admin.unsafe(`GRANT CREATE ON DATABASE ${name} TO wizard_owner`);
  }
  const u = new URL(BASE_URL);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    async drop() {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export interface TestApi extends PlatformApi {
  artifactsDir: string;
  req(
    method: string,
    path: string,
    init?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<Res>;
  dispose(): Promise<void>;
}

export interface Res {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked against api.yaml schemas
  body: any;
  text: string;
}

export async function startApi(url: string, opts: PlatformApiOptions = {}): Promise<TestApi> {
  const artifactsDir = opts.config?.artifactsDir ?? mkdtempSync(join(tmpdir(), "wz-api-"));
  const api = await createPlatformApi({
    ...opts,
    config: { dbUrl: url, artifactsDir, authMode: "dev", ...opts.config },
    log: opts.log ?? (process.env.WZ_TEST_LOG ? (m, e) => console.error(m, e) : () => {}),
  });
  const req: TestApi["req"] = async (method, path, init = {}) => {
    const headers: Record<string, string> = { host: "localhost:4000", ...init.headers };
    let body: BodyInit | undefined;
    if (init.body instanceof FormData) body = init.body;
    else if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["content-type"] = "application/json";
    }
    const res = await api.fetch(
      new Request(`http://localhost:4000/api/v1${path}`, { method, headers, body }),
    );
    const text = await res.text();
    let parsed: unknown = text;
    if ((res.headers.get("content-type") ?? "").includes("application/json")) parsed = JSON.parse(text);
    return { status: res.status, headers: res.headers, body: parsed, text };
  };
  return {
    ...api,
    artifactsDir,
    req,
    async dispose() {
      await api.close();
      if (!opts.config?.artifactsDir) rmSync(artifactsDir, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function waitRun(api: TestApi, runId: string, statuses: string[], ms = 10_000) {
  return waitFor(async () => {
    const r = await api.req("GET", `/runs/${runId}`);
    return statuses.includes(r.body.status) ? r.body : undefined;
  }, ms);
}

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

export function parseSse(text: string): SseFrame[] {
  return text
    .split("\n\n")
    .filter((b) => b.trim() !== "")
    .map((block) => {
      const f: SseFrame = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) f.comment = line.slice(1).trim();
        else {
          const i = line.indexOf(":");
          const k = line.slice(0, i);
          const v = line.slice(i + 1).replace(/^ /, "");
          if (k === "id" || k === "event") f[k] = v;
          else if (k === "data") f.data = f.data === undefined ? v : `${f.data}\n${v}`;
        }
      }
      return f;
    });
}

// ------------------------------------------------------------------------------------------------
// Fakes: orchestrator, builder, gates, router.

const aborted = (s: AbortSignal) =>
  new Promise<void>((r) => (s.aborted ? r() : s.addEventListener("abort", () => r(), { once: true })));

const golden = () => loadYaml("tools/fixtures/golden/forum.yaml");

export function fakeCard(cap = 40): Record<string, unknown> {
  return {
    ...(golden().card as Record<string, unknown>),
    estimate: { credits: { min: 10, expected: 20, max: 30 }, minutes: { expected: 8 } },
    cap: { credits: cap },
  };
}

export const fakeInterview = async (host: InterviewHost): Promise<InterviewOutput> => {
  const { trigger } = host.context;
  await host.route({
    callType: "interview",
    messages: [{ role: "user", content: "…" }],
    step: "orchestrate",
  });
  if (trigger === "create")
    return {
      kind: "questions",
      text: "Пара уточнений",
      questions: golden().questions as Record<string, unknown>[],
      analysis: { title: "Форум", forks: [] },
      notice: { categories: ["phone_ru"] },
    };
  if (trigger === "answers") return { kind: "card", text: "Карточка готова", card: fakeCard() };
  const last = [...host.context.messages].reverse().find((m) => m.role === "user")?.text ?? "";
  if (last.includes("измен")) return { kind: "card", text: "Вот правка", card: fakeCard(20) };
  if (last.includes("подожди")) await aborted(host.signal);
  return { kind: "answer", text: "Понял" };
};

export function passingReport(level: "G0" | "G1" | "G2", specVersion: number, passed = true): GateReport {
  return {
    level,
    passed,
    specVersion,
    startedAt: new Date().toISOString(),
    durationMs: 12,
    summary: { pass: passed ? 3 : 2, fail: passed ? 0 : 1, warn: 1, skip: 0, error: 0 },
    checks: [
      { id: "G0-SPEC-01", status: "pass", severity: "blocker", message_ru: "Спека валидна" },
      { id: "G0-TYPES-01", status: "pass", severity: "blocker", message_ru: "Типы сходятся" },
      {
        id: "G0-BUILD-01",
        status: passed ? "pass" : "fail",
        severity: "blocker",
        message_ru: passed ? "Сборка прошла" : "Ошибка сборки",
        file: "ui/Landing.tsx",
        line: 3,
        fixHint: "Проверьте импорт",
      },
      { id: "G0-A11Y-01", status: "warn", severity: "warning", message_ru: "Нет подписи у кнопки" },
    ],
  };
}

export interface FakeBuildOpts {
  spec: "forum" | "bakery";
  g0Pass?: boolean;
  /** Ask for a decision (escalation) before finishing. */
  askInput?: boolean;
  /** Block until released (restart / cancel tests). */
  gate?: Promise<void>;
}

export function fakeExecutors(o: FakeBuildOpts & { bundle?: boolean } = { spec: "forum" }): RunExecutors {
  return {
    interviewTurn: fakeInterview,
    build: (host, params) => fakeBuild(host, params, o),
    gates: async (level, ctx) => passingReport(level, ctx.specVersion, o.g0Pass ?? true),
    ...(o.bundle !== false
      ? { onG0Passed: async (a) => ({ bundleKey: `${a.systemKey}/${a.revision}` }) }
      : {}),
  };
}

export async function fakeBuild(host: BuildHost, p: BuildParams, o: FakeBuildOpts) {
  type SpecToOps = {
    specToOps(spec: unknown, o: { author: string }): unknown[];
    batchOps(ops: unknown[]): unknown[][];
  };
  const lib = (await import(join(ROOT, "tools/fixtures/lib/spec-to-ops.mjs"))) as SpecToOps;
  const spec = JSON.parse(readFileSync(join(ROOT, `specs/appspec/examples/${o.spec}.json`), "utf8"));
  const batches = lib.batchOps(lib.specToOps(spec, { author: "agent" }));
  await host.emit("plan_ready", {
    steps: [
      { id: "P1", kind: "ops", title: "Данные и роли" },
      { id: "P2", kind: "code", title: "Экраны" },
    ],
  });
  await host.emit("step_started", { step: "ops", label_ru: "Собираю модель данных", attempt: 1 });
  await host.route({ callType: "build_ops", messages: [{ role: "user", content: "…" }], step: "ops" });
  for (const [i, ops] of (p.mode === "create" ? batches : []).entries()) {
    const { version } = await host.store.getSpec();
    const r = await host.runStep(`apply_ops_${i}`, () =>
      host.store.applyOps(ops, version, `${host.run.id}:ops_${i}:1`),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
  }
  await host.emit("step_finished", { step: "ops", durationMs: 5 });
  await host.emit("agent_message", { agent: "builder", messageId: "m1", text: "Пишу экраны", delta: false });
  if (o.spec === "forum") {
    for (const f of ["ui/Landing.tsx", "functions/registerTicket.ts"])
      await host.store.writeFile(f, readFileSync(join(ROOT, "specs/runtime/examples", f), "utf8"));
  } else await host.store.writeFile("ui/Home.tsx", "export default function Home() { return null; }\n");
  await host.store.commitFiles();
  if (o.gate) await Promise.race([o.gate, aborted(host.signal)]);
  const report = await host.runGates("G0");
  if (o.askInput && p.mode === "create") {
    const ans = await host.needsInput({
      decisionId: "escalation",
      prompt_ru: "Не получается исправить ошибку. Что делаем?",
      options: [
        { id: "retry", label: "Попробовать ещё", recommended: true },
        { id: "rephrase", label: "Переформулировать", freeText: true },
        { id: "rollback", label: "Откатить" },
      ],
    });
    if (ans.choice === "rollback") return { status: "cancelled" as const, summary_ru: "Откатили" };
  }
  if (!report.passed) throw new RunFailure("GATES_FAILED", "Проверки не пройдены");
  return { summary_ru: "Система собрана" };
}

/** Router stub: fixed usage, emits model_switched (internal) on the first call. */
export function fakeRouterFactory(creditsMilli = 100): (opts: RouterOptions) => Router {
  return (opts) => {
    let first = true;
    return {
      mode: "fixture",
      registry: {} as Router["registry"],
      async route(): Promise<RouteOutput> {
        if (first) {
          first = false;
          opts.onEvent?.({
            type: "model_switched",
            fromModel: "glm-5.3",
            toModel: "qwen3",
            reason: "fallback_error",
          });
        }
        return {
          tier: "T0",
          model: "fixture",
          result: { text: "ok", toolCalls: [], finishReason: "stop" },
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          creditsCharged: creditsMilli / 1000,
          creditsMilli,
          routeReason: "default_T0",
          scrubbed: false,
          ruFallback: false,
        };
      },
    };
  };
}
