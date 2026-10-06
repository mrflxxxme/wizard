// G1 orchestration (specs/quality/gates.yaml#G1): ephemeral schema + seed + runtime, PC-*/SC-* checks,
// G1-AC-COVER, G1-FN-01; milestone rule; time budget; cleanup in finally.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSpec, USERS_ENTITY } from "@wizard/appspec";
import { buildSystem, writeArtifact } from "@wizard/build";
import { CHECK_BY_ID, type CheckDef, G1_TIME_BUDGET_MS, resolveMilestone } from "../catalog.js";
import { clip, type Finding, isPassed, summarize, toChecks } from "../report.js";
import type { Check, GateContext, GateReport } from "../types.js";
import {
  acceptanceChecks,
  generateConsentChecks,
  generatePermissionChecks,
  isLaterMilestone,
  selectG1,
} from "./checks.js";
import { type Actor, G1Env } from "./env.js";
import { minimalArgs } from "./fnargs.js";
import { Prober } from "./probes.js";
import { type RenderContext, renderPages } from "./render/index.js";
import { runScenario, validateScenario } from "./scenario.js";
import { fieldPiiCategory, generateSeed, seedDlp, ValueGen } from "./seed.js";
import type { QaCheck, Seed } from "./types.js";

export interface G1Options {
  timeBudgetMs?: number;
  /** Injection point for tests. */
  deps?: { buildSystem?: typeof buildSystem };
  /** G1-RENDER-01 observer of every page render (tests). */
  onRender?: RenderContext["onRender"];
  /** G1-RENDER-01 ceiling per page × role (default RENDER_TIMEOUT_MS). */
  renderTimeoutMs?: number;
}

const def = (id: string): CheckDef => CHECK_BY_ID.get(id) as CheckDef;

/** All checks G1 runs for a spec: selected PC probes, consent probes, SC-<AC>; QA checks override by id. */
export function g1Checks(spec: AppSpec, qa: readonly QaCheck[] = []): QaCheck[] {
  const derived = [
    ...selectG1(spec, [...generatePermissionChecks(spec), ...generateConsentChecks(spec)]),
    ...acceptanceChecks(spec),
  ];
  const byId = new Map<string, QaCheck>();
  for (const c of derived) byId.set(c.id, c);
  for (const c of qa) if (c.level === "G1") byId.set(c.id, c);
  return [...byId.values()];
}

/** seed key for G1: sha256(systemId + specVersion) (qa.yaml#seed.generator). */
export const g1SeedKey = (systemKey: string, specVersion: number) =>
  createHash("sha256").update(`${systemKey}${specVersion}`).digest("hex");

function entry(
  c: QaCheck,
  status: Check["status"],
  message_ru: string,
  extra: { evidence?: string; fixHint?: string; path?: string } = {},
): Check {
  const out: Check = {
    id: c.id,
    status: c.advisory && status === "fail" ? "warn" : status,
    severity: c.advisory ? "warning" : def(c.kind === "permission" && !c.acId ? "G1-PERM" : "G1-AC").severity,
    message_ru: clip(message_ru, 300),
  };
  if (c.acId) out.acId = c.acId;
  if (extra.path) out.path = extra.path;
  if (extra.evidence) out.evidence = clip(extra.evidence, 500);
  if (extra.fixHint) out.fixHint = clip(extra.fixHint, 300);
  return out;
}

export async function runG1(ctx: GateContext, opts: G1Options = {}): Promise<GateReport> {
  const started = Date.now();
  const startedAt = (ctx.now ?? new Date(started)).toISOString();
  const deadline = started + (opts.timeBudgetMs ?? G1_TIME_BUDGET_MS);
  const milestone = resolveMilestone(ctx.milestone);
  const spec = ctx.spec;
  const now = ctx.now ?? new Date();
  const checks = g1Checks(spec, ctx.checks ?? []);
  const results = new Map<string, Check>();
  type Outcome =
    | { kind: "findings"; findings: Finding[] }
    | { kind: "skip" | "error"; reason_ru: string; evidence?: string };
  let fnOutcome: Outcome = { kind: "skip", reason_ru: "Не запускалась" };
  const renderOn = !isLaterMilestone("M1", milestone);
  let renderOutcome: Outcome = renderOn
    ? { kind: "error", reason_ru: "не запускалась" }
    : { kind: "skip", reason_ru: "Проверка включается с этапа M1" };

  // Milestone rule and static validity first: they need no runtime.
  const runnable: QaCheck[] = [];
  for (const c of checks) {
    if (isLaterMilestone(c.milestone, milestone)) {
      results.set(c.id, entry(c, "skip", `Проверка включается с этапа ${c.milestone}`));
      continue;
    }
    if (c.scenario) {
      const errs = validateScenario(spec, c.scenario);
      if (errs.length) {
        results.set(
          c.id,
          entry(c, "error", "Не удалось проверить автоматически: сценарий проверки составлен с ошибкой", {
            evidence: `check_invalid: ${errs.slice(0, 5).join("; ")}`,
          }),
        );
        continue;
      }
    }
    runnable.push(c);
  }

  const failAll = (reason: string, evidence?: string) => {
    for (const c of runnable)
      if (!results.has(c.id))
        results.set(c.id, entry(c, "error", `Не удалось проверить: ${reason}`, evidence ? { evidence } : {}));
    fnOutcome = { kind: "error", reason_ru: reason };
    if (renderOn) renderOutcome = { kind: "error", reason_ru: reason };
  };

  const runtime = ctx.runtime;
  if (!runtime) failAll("нет запущенного runtime для сценариев");
  else if (!ctx.db) failAll("нет подключения к базе данных");
  else {
    const runId = randomBytes(4).toString("hex");
    const env = new G1Env(ctx.db, runtime, spec, ctx.systemKey, runId, ctx.runtimeRole ?? "wizard_runtime");
    const artifacts = mkdtempSync(join(tmpdir(), "wz-g1-"));
    try {
      await env.migrate();
      let artifactDir: string | null = null;
      if ((spec.functions ?? []).length > 0) {
        const built = await (opts.deps?.buildSystem ?? buildSystem)({ spec, files: ctx.files, env: "draft" });
        if (!built.ok)
          throw new G1SetupError("система не собирается", built.errors.map((e) => e.message_ru).join("; "));
        artifactDir = writeArtifact(artifacts, randomBytes(6).toString("hex"), 1, built).dir;
      }
      await env.load(artifactDir);
      // QA seed hints of the scenarios that run (qa.yaml#seed.rules MAY), merged in check order.
      const hints = runnable.flatMap((c) => c.scenario?.seedHints ?? []);
      const seed = generateSeed(spec, g1SeedKey(ctx.systemKey, ctx.specVersion), { now, hints });
      const dlp = seedDlp(spec, seed);
      if (dlp.length)
        throw new G1SetupError(
          "начальные данные похожи на персональные (SEED_PII)",
          dlp
            .slice(0, 5)
            .map((f) => `${f.path}: ${f.kind}`)
            .join("; "),
        );
      const spec0 = (await env.request(env.anonymous(), "GET", "/_wizard/spec")).body as {
        compliance?: { policyVersion?: string; consentTextHash?: string };
      } | null;
      const consent =
        spec0?.compliance?.policyVersion && spec0.compliance.consentTextHash
          ? { policyVersion: spec0.compliance.policyVersion, textHash: spec0.compliance.consentTextHash }
          : null;
      const piiNames = new Set(
        spec.entities.flatMap((e) =>
          e.fields.filter((f) => fieldPiiCategory(f) !== "none").map((f) => f.name),
        ),
      );
      const timeLeft = () => deadline - Date.now() > 0 && !ctx.signal?.aborted;
      const overBudget = (c: QaCheck) =>
        results.set(
          c.id,
          entry(
            c,
            "error",
            ctx.signal?.aborted
              ? "Не удалось проверить: проверка остановлена"
              : "Не удалось проверить: превышено время G1 (120 с)",
          ),
        );

      // Permission probes on the seed (fresh rows per probe, so probes do not disturb each other).
      await env.reset(seed);
      const actors = await seedActors(env, spec, seed);
      const prober = new Prober(env, { seed, gen: new ValueGen(now, 100_000), consent, actors });
      for (const c of runnable.filter((x) => x.kind === "permission")) {
        if (!timeLeft()) {
          overBudget(c);
          continue;
        }
        try {
          const r = await prober.run(c);
          results.set(c.id, entry(c, r.status, r.message_ru, r));
        } catch (e) {
          results.set(
            c.id,
            entry(c, "error", "Не удалось проверить: внутренняя ошибка", {
              evidence: String((e as Error).message),
            }),
          );
        }
      }

      // Scenarios: each on a freshly reset copy of the seed (or empty, seed: none).
      for (const c of runnable.filter((x) => x.scenario)) {
        if (!timeLeft()) {
          overBudget(c);
          continue;
        }
        const sc = c.scenario as NonNullable<QaCheck["scenario"]>;
        const scSeed = sc.seed === "none" ? null : seed;
        await env.reset(scSeed);
        const r = await runScenario(env, sc, { seed: scSeed, consent, now, piiNames });
        results.set(c.id, entry(c, r.status, r.message_ru, r.evidence ? { evidence: r.evidence } : {}));
      }

      // G1-FN-01 on the seed.
      if (timeLeft()) {
        await env.reset(seed);
        fnOutcome = {
          kind: "findings",
          findings: await publicQueries(env, spec, ctx.files, seed, await seedActors(env, spec, seed), now),
        };
      } else fnOutcome = { kind: "error", reason_ru: "превышено время G1 (120 с)" };

      // G1-RENDER-01 (since M1) on the seed: every page × each of its roles.
      if (renderOn) {
        if (timeLeft()) {
          await env.reset(seed);
          renderOutcome = await renderPages({
            env,
            spec,
            files: ctx.files,
            seed,
            actors: await seedActors(env, spec, seed),
            timeLeft: () => (ctx.signal?.aborted ? 0 : deadline - Date.now()),
            workDir: artifacts,
            ...(opts.onRender ? { onRender: opts.onRender } : {}),
            ...(opts.renderTimeoutMs ? { timeoutMs: opts.renderTimeoutMs } : {}),
          });
        } else renderOutcome = { kind: "error", reason_ru: "превышено время G1 (120 с)" };
      }
    } catch (e) {
      if (e instanceof G1SetupError) failAll(e.message, e.evidence);
      else failAll("не удалось подготовить окружение проверки", String((e as Error)?.message ?? e));
    } finally {
      await env.drop().catch(() => {});
      rmSync(artifacts, { recursive: true, force: true });
    }
  }

  const out: Check[] = checks.map((c) => results.get(c.id) as Check).filter(Boolean);
  out.push(...coverage(spec, checks, results, milestone));
  out.push(...toChecks(def("G1-FN-01"), fnOutcome));
  out.push(...toChecks(def("G1-RENDER-01"), renderOutcome));
  return {
    level: "G1",
    passed: isPassed(out),
    specVersion: ctx.specVersion,
    startedAt,
    durationMs: Date.now() - started,
    checks: out,
    summary: summarize(out),
  };
}

class G1SetupError extends Error {
  constructor(
    message: string,
    readonly evidence?: string,
  ) {
    super(message);
  }
}

/** A and B (seed users with sessions) per login role; an anonymous actor per public role. */
export async function seedActors(env: G1Env, spec: AppSpec, seed: Seed): Promise<Map<string, Actor[]>> {
  const out = new Map<string, Actor[]>();
  for (const r of spec.roles) {
    if (r.access === "public") out.set(r.name, [env.anonymous(r.name)]);
    else
      out.set(
        r.name,
        await Promise.all(seed.users.filter((u) => u.role === r.name).map((u) => env.login(u.id, u.role))),
      );
  }
  return out;
}

/** G1-AC-COVER: every current AC has ≥1 check with status ≠ error; later ACs count as covered. */
function coverage(spec: AppSpec, checks: QaCheck[], results: Map<string, Check>, milestone: string): Check[] {
  const d = def("G1-AC-COVER");
  const missing: Finding[] = [];
  // D75: an uncovered scenario or constraint AC is QA's miss — a warning; permission ACs are covered by probes.
  const advisory: Finding[] = [];
  for (const [i, ac] of (spec.acceptance ?? []).entries()) {
    if (isLaterMilestone(ac.check.milestone, milestone)) continue;
    const mine = checks.filter((c) => c.acId === ac.id).map((c) => results.get(c.id));
    if (!mine.some((r) => r && r.status !== "error" && r.status !== "skip")) {
      (ac.check.type === "permission" ? missing : advisory).push({
        message_ru: `Критерий ${ac.id} «${ac.text}» не проверяется автоматически`,
        path: `/acceptance/${i}`,
        fixHint: "QA должен сформировать исполнимую проверку для этого критерия",
      });
    }
  }
  return [
    // One G1-AC-COVER entry set: blockers (or a pass) and, apart, the advisory misses; no «pass» next to a warning.
    ...(missing.length > 0 || advisory.length === 0
      ? toChecks(d, { kind: "findings", findings: missing })
      : []),
    ...(advisory.length
      ? toChecks({ ...d, severity: "warning" }, { kind: "findings", findings: advisory })
      : []),
  ];
}

/** G1-FN-01: every public query, called by an allowed role with minimal valid args, answers without 5xx. */
async function publicQueries(
  env: G1Env,
  spec: AppSpec,
  files: ReadonlyMap<string, string>,
  seed: Seed,
  actors: Map<string, Actor[]>,
  now: Date,
): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const [i, f] of (spec.functions ?? []).entries()) {
    if (f.kind !== "query" || f.public !== true) continue;
    const roles = f.roles ?? spec.roles.filter((r) => r.isAdmin).map((r) => r.name);
    const role = roles.find((r) => (actors.get(r) ?? []).length > 0);
    const actor = role ? actors.get(role)?.[0] : undefined;
    if (!actor) continue;
    const source = files.get(f.file);
    const args =
      (source &&
        minimalArgs(f.file, source, {
          now,
          idOf: (entity) =>
            entity === USERS_ENTITY ? actor.id : ((seed.rows[entity]?.[0]?.id as string | undefined) ?? null),
        })) ??
      {};
    const res = await env.request(actor, "POST", `/api/fn/${encodeURIComponent(f.name)}`, { args });
    if (res.status >= 500) {
      out.push({
        message_ru: `Запрос «${f.name}» отвечает ошибкой сервера`,
        file: f.file,
        path: `/functions/${i}`,
        evidence:
          `роль ${role}: HTTP ${res.status} ${(res.body as { error?: { code?: string } } | null)?.error?.code ?? ""}`.trim(),
        fixHint: `Проверьте ${f.file}: функция не должна падать на допустимых аргументах`,
      });
    }
  }
  return out;
}
