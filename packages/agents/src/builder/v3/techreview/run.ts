// The techreview of a v3 build (V3-15; builder-v3.md §3 C6 stage 7, product.yaml D77_v3 (10)): the deterministic part
// first — it is the source of truth — then the reviewer on a model of another family than the builder reads the
// compact digest and answers with a closed set of findings; fixes the harness can apply safely are applied by code
// (fixes.ts) and re-checked, the rest stay open; never more than 2 rounds of fixes, within the stage budget
// (ctx.budgetRub; calls go through ctx.route, so the wallet counts them). Blockers of the deterministic part and the
// reviewer's blocker findings left open → the system is not published (the harness fails the build: GATES_FAILED).
// The reviewer's models unavailable or its budget spent → the deterministic verdict stands, noted for the client.
import { createRegistry, LlmError } from "@wizard/llm";
import { DEFAULT_REGISTRY } from "../../../planner/catalog.js";
import type { V3BuildContext } from "../contract.js";
import type { V3HookResult, V3StageHook } from "../harness/types.js";
import { milliRub, V3BudgetError } from "../harness/wallet.js";
import { referenceSpec } from "./chains.js";
import { blockerLine, blockingChecks, deterministicChecks, localGates } from "./checks.js";
import { techDigest } from "./digest.js";
import { applyFix } from "./fixes.js";
import { defaultBuilderFamilies, reviewRound } from "./reviewer.js";
import {
  type FixOutcome,
  type ReviewerState,
  type ReviewFinding,
  TECH_AREA_RU,
  type TechCheck,
  type TechreviewDeps,
  type TechreviewOutcome,
  type TechSystem,
} from "./types.js";

/** Rounds of fixes of a techreview, at most (D77 (10)). */
export const TECHREVIEW_MAX_ROUNDS = 2;

const SEVERITY_RU = { blocker: "блокер", major: "важное", minor: "мелкое" } as const;

/** Runs the techreview over the build context. */
export async function runTechreview(
  ctx: V3BuildContext,
  deps: TechreviewDeps = {},
): Promise<TechreviewOutcome> {
  const llm = createRegistry();
  const rpc = deps.rubPerCredit ?? llm.rubPerCredit;
  const maxRounds = Math.max(0, Math.min(deps.maxRounds ?? TECHREVIEW_MAX_ROUNDS, TECHREVIEW_MAX_ROUNDS));
  const reference = referenceSpec(ctx.plan, deps.registry ?? DEFAULT_REGISTRY);
  const evidence = deps.evidence ? await deps.evidence().catch(() => []) : [];
  const gates = deps.gates ?? localGates;
  // V3-20 contracts of the brief's outgoing integrations (the layer of the build is made of exactly these).
  const outgoing = new Set(ctx.brief.integrations.filter((i) => i.direction !== "in").map((i) => i.id));
  const contracts = ((await deps.contracts?.()) ?? []).filter((c) => outgoing.has(c.integrationId));
  const recheck = (system: TechSystem) =>
    deterministicChecks(system, {
      plan: ctx.plan,
      reference,
      evidence,
      gates,
      contracts,
      ...(deps.integrations ? { integrations: deps.integrations } : {}),
    });

  // 1. The deterministic part — the source of truth.
  let system: TechSystem = { spec: ctx.spec, files: new Map(ctx.files) };
  let checks = await recheck(system);

  // 2. The reviewer on another family than the builder, ≤ 2 rounds of fixes.
  const avoid = [
    ...new Set([...defaultBuilderFamilies(llm), ...((await deps.builderFamilies?.()) ?? [])]),
  ].sort();
  const reviewer: ReviewerState = { status: "done", calls: 0, model: null, costRub: 0, unfounded: 0 };
  const fixes: FixOutcome[] = [];
  const changed = new Map<string, string>();
  const extensions: TechreviewOutcome["extensions"] = [];
  let open: ReviewFinding[] = [];
  /** The reviewer's findings about the owner's input (the operator's data): publication asks the owner, not the build. */
  const ownerInput = new Map<string, string>();
  /** Titles of every finding seen: a finding raised again in the next round keeps the reason its fix was refused. */
  const titles = new Map<string, string>();
  let rounds = 0;
  for (let round = 1; round <= Math.max(1, maxRounds); round++) {
    let r: Awaited<ReturnType<typeof reviewRound>>;
    try {
      r = await reviewRound({
        route: ctx.route,
        avoidFamilies: avoid,
        digest: techDigest({ brief: ctx.brief, plan: ctx.plan, system, reference, checks, fixes }),
        round,
        rounds: Math.max(1, maxRounds),
        system,
        checks,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      // The stage budget is spent, or the reviewer's models are unavailable: the deterministic verdict stands. The run's
      // own cap and a cancellation are the run's business (as the reviewer of the builder v1).
      if (e instanceof V3BudgetError) reviewer.reason = "бюджет этапа исчерпан";
      else if (e instanceof LlmError && e.code !== "BUDGET_EXCEEDED" && e.code !== "ABORTED")
        reviewer.reason = `модели ревьюера недоступны (${e.code})`;
      else throw e;
      if (round === 1) reviewer.status = "skipped";
      break;
    }
    reviewer.calls += r.calls;
    reviewer.model = r.model ?? reviewer.model;
    reviewer.costRub = Math.round((reviewer.costRub + milliRub(r.creditsMilli, rpc)) * 100) / 100;
    reviewer.unfounded += r.unfounded;
    if (!r.valid) {
      reviewer.reason = "ревьюер не дал ответа по форме";
      if (round === 1) reviewer.status = "skipped";
      break;
    }
    open = r.findings;
    for (const f of r.ownerInput) ownerInput.set(f.title_ru, f.title_ru);
    for (const f of open) titles.set(f.id, f.title_ru);
    const fixable = open.filter((f) => f.fix.kind !== "none" && f.severity !== "minor");
    if (!fixable.length || round > maxRounds) break;
    rounds = round;
    for (const f of fixable) {
      const res = await applyFix(f, {
        system,
        checks,
        round,
        recheck,
        applyExtensions: deps.applyExtensions === true,
      });
      fixes.push(res.outcome);
      if (!res.outcome.applied || !res.system || !res.checks) {
        // An extension the rules refuse (or a host that does not merge extensions): «Запросы на развитие» with why.
        if (f.fix.kind === "extension")
          await deps.request?.({
            key: `techreview:ext:${f.title_ru}`,
            quote_ru: res.deferred
              ? `Доработка по техревью: ${f.title_ru}`
              : `Доработка по техревью: ${f.title_ru} — не применена: ${res.outcome.reason_ru ?? "не прошла проверки"}`,
            offered_ru: "Пока система работает без этой доработки.",
          });
        continue;
      }
      system = res.system;
      checks = res.checks;
      if (f.fix.kind === "function_patch") changed.set(f.fix.file, f.fix.source);
      if (res.extension) extensions.push(res.extension);
      if (res.closed) open = open.filter((x) => x.id !== f.id);
    }
  }

  // 3. The verdict: deterministic blockers and the reviewer's blockers left open.
  const reasonOf = (f: ReviewFinding) => {
    const last = [...fixes]
      .reverse()
      .find((x) => !x.applied && (x.finding === f.id || titles.get(x.finding) === f.title_ru));
    return last?.reason_ru ? ` (исправление не применено: ${last.reason_ru})` : "";
  };
  const blockers = [
    ...blockingChecks(checks).map(blockerLine),
    ...open
      .filter((f) => f.severity === "blocker")
      .map((f) => `${TECH_AREA_RU[f.area]}: ${f.title_ru.replace(/\.$/, "")}${reasonOf(f)}`),
  ];
  for (const c of checks.filter((x) => x.area === "chains" && x.status === "warn"))
    await deps.request?.({
      key: `techreview:${c.id}`,
      quote_ru: c.message_ru,
      offered_ru: "Цепочку можно замкнуть доработкой системы.",
    });

  const ran = checks.filter((c) => c.status !== "skip").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const applied = fixes.filter((f) => f.applied).length;
  const notes = [
    `Техревью: проверил сборку и типы, миграции, права и персональные данные, интеграции, связи модулей, скорость и доступность — ${ran} проверок${warnings ? `, замечаний без блокировки: ${warnings}` : ""}.`,
    reviewer.status === "done"
      ? `Ревьюер на модели другого семейства нашёл ${open.length + applied} замечаний${applied ? `, исправлено ${applied}` : ""}.`
      : `Ревьюер не ответил (${reviewer.reason}) — систему проверила детерминированная часть.`,
  ];
  const note = [
    `проверок ${ran}, предупреждений ${warnings}, блокеров ${blockers.length}`,
    `ревьюер ${reviewer.status === "done" ? (reviewer.model ?? "—") : `пропущен: ${reviewer.reason}`}`,
    `находок ${open.length}${open.length ? ` (${open.map((f) => SEVERITY_RU[f.severity]).join(", ")})` : ""}`,
    `раундов исправлений ${rounds}`,
    ...(ownerInput.size ? [`данные владельца перед публикацией: ${ownerInput.size}`] : []),
  ].join("; ");
  return {
    checks,
    findings: open,
    fixes,
    files: changed,
    extensions,
    blockers,
    ownerInput: [...ownerInput.values()],
    notes,
    rounds,
    reviewer,
    note,
  };
}

/** What the techreview stage hands the harness (V3HookResult.extensions — the extension fixes the harness applies). */
export type TechreviewHookResult = V3HookResult;

/** The techreview stage hook of the harness v3 (V3Host.hooks.techreview). */
export function createTechreview(deps: TechreviewDeps = {}): V3StageHook {
  return async (ctx): Promise<TechreviewHookResult> => {
    const r = await runTechreview(ctx, deps);
    return {
      status: "done",
      notes: r.notes,
      blockers: r.blockers,
      note: r.note,
      // The reviewer's calls go through ctx.route: the stage wallet has counted them already.
      spentRub: 0,
      ...(r.files.size ? { files: new Map<string, string | null>(r.files) } : {}),
      ...(deps.applyExtensions && r.extensions.length ? { extensions: r.extensions } : {}),
    };
  };
}

/** Deterministic checks that keep the system from publication (for the build log). */
export const techBlockers = (checks: readonly TechCheck[]): string[] =>
  blockingChecks(checks).map(blockerLine);
