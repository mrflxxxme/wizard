// The visual critic of the build v3 (V3-13; builder-v3.md §3 C6 stage `critic`, D77 (6), design-agent-catalog.md C):
// algorithms ahead of models. 1) The host's inspector builds the site and runs the deterministic checks at 390/768/1440
// (contrast, overflow, fonts, CLS, touch, names, headings); what code can fix it fixes without a model — another
// variant of the section, a token step — and keeps a fix only when the checks get better. 2) Up to 3 cycles of the
// vision model (critic_visual: with images the router keeps it on T0) on the screenshots: axis scores and findings
// with edits from a closed set (ops.ts). Each edit is linted, the batch is built (G0) and checked in the browser again;
// a regression is rolled back edit by edit. The loop stops on «pass», when the score stops growing (a batch that made
// it worse is rolled back), on the budget (≤ 40 ₽ and ctx.budgetRub, checked by the upper bound before each call),
// on time or when nothing applies. The result is a layer of files for the harness; the critic never blocks a build.
import { type CallType, createRegistry, type OrgPolicy, type Registry, type RouteContext } from "@wizard/llm";
import { hash32, PATTERNS, type PatternMeta } from "@wizard/ui-kit/v3/patterns";
import type { RunStepFn } from "../../../core/events.js";
import { callTool, type RouteFn } from "../../../core/loop.js";
import { upperBoundCredits } from "../../budget.js";
import { siteFiles } from "../compose/codegen.js";
import { type SiteFacts, siteFacts } from "../compose/facts.js";
import { lintErrors } from "../compose/lint.js";
import { type ScenarioVerify, verifySystem } from "../compose/scenario.js";
import { readSite, type SiteModel, type SitePage } from "../compose/site.js";
import { lintSitePage } from "../compose/skeleton.js";
import type { V3BuildContext } from "../contract.js";
import type { V3HookResult, V3StageHook } from "../harness/types.js";
import { V3BudgetError } from "../harness/wallet.js";
import { CRITIC_VIEWPORTS } from "./checks.js";
import { applyEdit, type CriticState, type EditEnv, type EditOp, variantsFor } from "./ops.js";
import { CRITIC_CALL_TYPE, type CritiqueHistory, critiqueMessages, critiqueTool } from "./prompt.js";
import {
  CHECK_RUBRIC,
  type CheckCode,
  type Critique,
  critiquePasses,
  critiqueScore,
  type DeterministicProblem,
  problemDigest,
  problemKey,
  problemPenalty,
  SEVERITIES,
} from "./rubric.js";
import type { CriticInspection, CriticInspector, CriticShot, CriticShotRequest } from "./types.js";

/** Caps of the critic (V3-13 acceptance: ≤ 3 cycles, ≤ 40 ₽). */
export const CRITIC_LIMITS = {
  maxCycles: 3,
  budgetRub: 40,
  /** Wall clock of the stage, ms. */
  timeMs: 6 * 60_000,
  /** Browser inspections of the stage (each builds the site and opens its pages). */
  maxInspections: 16,
  /** Model edits applied per cycle. */
  maxEdits: 6,
  /** Sections the deterministic phase tries to fix by another variant. */
  maxFixes: 4,
} as const;

export interface CriticOptions {
  /** The host's browser: build, checks and screenshots (platform: builds-v3/critic.ts). */
  inspect: CriticInspector;
  /** G0 of the system after a batch of edits (default verifySystem of the composer); null — the browser build only. */
  verify?: ScenarioVerify | null;
  /** Patterns (default: the ui-kit library). */
  patterns?: readonly PatternMeta[];
  registry?: Registry;
  maxCycles?: number;
  /** Cap of the stage, ₽ (the smaller of it and ctx.budgetRub applies). */
  budgetRub?: number;
  timeMs?: number;
  maxInspections?: number;
  maxEdits?: number;
  now?: () => number;
  orgPolicy?: OrgPolicy | null;
  routeCtx?: RouteContext;
  runStep?: RunStepFn;
}

/** One model cycle: the verdict on the state it saw and what its edits did. */
export interface CriticCycle {
  n: number;
  score: number;
  pass: boolean;
  axes: Critique["axes"];
  polish: Critique["polish"];
  findings: number;
  applied: string[];
  rejected: { edit: string; reason_ru: string }[];
  costRub: number;
  model?: string;
  tier?: string;
}

export type CriticStop =
  | "pass"
  | "no_gain"
  | "no_edits"
  | "cycles"
  | "budget"
  | "time"
  | "inspections"
  | "model"
  | "none";

export interface CriticReport {
  status: "done" | "skipped";
  /** Why the critic skipped (Russian). */
  reason?: string;
  stop: CriticStop;
  cycles: CriticCycle[];
  /** Fixes of the deterministic phase (no model). */
  fixes: string[];
  /** Edits rolled back: a regression in the checks, or the score fell after them. */
  rolledBack: string[];
  /** Penalty and problem keys of the deterministic checks before and after. */
  before: { penalty: number; problems: number };
  after: { penalty: number; problems: number };
  /** Problems left (for the notes and «Запросы на развитие»). */
  left: DeterministicProblem[];
  spentRub: number;
  inspections: number;
  /** Changed files (path → source; null — delete). */
  files: Map<string, string | null>;
  notes: string[];
}

/** The route over ctx.route would pass the stage's cap (checked by the upper bound before each call). */
class CriticBudgetStop extends Error {
  constructor(readonly needRub: number) {
    super(`critic budget: need ${needRub}`);
  }
}

/** Codes a variant of the section can fix (layout, colour of the variant, its controls, its motion). */
const FIXABLE: ReadonlySet<CheckCode> = new Set(["L11", "C08", "A01", "CLS", "L13", "M05"]);
const SEV_ORDER = (s: string) => SEVERITIES.indexOf(s as (typeof SEVERITIES)[number]);

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Pages the critic opens: the public ones a visitor sees without signing in (the client's cabinet is skipped). */
export function criticRoutes(site: SiteModel): string[] {
  return site.pages
    .filter((p) => p.kind !== "account")
    .map((p) => p.route)
    .slice(0, 6);
}

/**
 * Screenshots of a cycle: the home page at 390 (as is), 768 and 1440 (halved) and the whole page at 1440 (a quarter: the
 * rhythm «при прищуре»); the first screen at 390 of up to two more pages. Small images keep a cycle cheap.
 */
export function shotPlan(site: SiteModel): CriticShotRequest[] {
  const home = site.pages.find((p) => p.route === "/") ?? site.pages[0];
  if (!home) return [];
  const others = site.pages
    .filter((p) => p !== home && p.kind !== "account" && p.kind !== "credits")
    .slice(0, 2);
  return [
    { route: home.route, width: 390, kind: "screen", maxWidth: 390, maxHeight: 844 },
    { route: home.route, width: 768, kind: "screen", maxWidth: 384, maxHeight: 512 },
    { route: home.route, width: 1440, kind: "screen", maxWidth: 720, maxHeight: 450 },
    { route: home.route, width: 1440, kind: "page", maxWidth: 360, maxHeight: 2400 },
    ...others.map((p) => ({
      route: p.route,
      width: 390 as const,
      kind: "screen" as const,
      maxWidth: 390,
      maxHeight: 844,
    })),
  ];
}

/** Files that differ from the system's (deletions of files it has). */
function changed(
  files: Map<string, string | null>,
  current: ReadonlyMap<string, string>,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [p, v] of files) if (v === null ? current.has(p) : current.get(p) !== v) out.set(p, v);
  return out;
}

function merged(
  current: ReadonlyMap<string, string>,
  files: Map<string, string | null>,
): Map<string, string> {
  const out = new Map(current);
  for (const [p, v] of files) {
    if (v === null) out.delete(p);
    else out.set(p, v);
  }
  return out;
}

/** Short Russian form of an edit for the history and the notes. */
export function describeEdit(op: EditOp): string {
  switch (op.op) {
    case "swap_variant":
      return `${op.route}#${op.section} → ${op.pattern}`;
    case "reorder":
      return `${op.route}: порядок ${op.order.join(", ")}`;
    case "set_text":
      return `${op.route}#${op.section}.${op.path} = «${op.text.slice(0, 60)}»`;
    case "token":
      return `${op.token} = ${op.value}`;
    case "drop_section":
      return `${op.route}: убрать ${op.section}`;
  }
}

const RU_PROBLEMS = (n: number) =>
  n % 10 === 1 && n % 100 !== 11
    ? "место"
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
      ? "места"
      : "мест";

/** Runs the critic on a build context (the hook wraps it; tests read the report). */
export async function runCritic(ctx: V3BuildContext, o: CriticOptions): Promise<CriticReport> {
  const library = o.patterns ?? PATTERNS;
  const registry = o.registry ?? createRegistry();
  const rpc = registry.rubPerCredit;
  const now = o.now ?? Date.now;
  const t0 = now();
  const maxCycles = Math.min(o.maxCycles ?? CRITIC_LIMITS.maxCycles, CRITIC_LIMITS.maxCycles);
  const cap = Math.min(o.budgetRub ?? CRITIC_LIMITS.budgetRub, ctx.budgetRub);
  const timeMs = o.timeMs ?? CRITIC_LIMITS.timeMs;
  const maxInspections = o.maxInspections ?? CRITIC_LIMITS.maxInspections;
  const maxEdits = o.maxEdits ?? CRITIC_LIMITS.maxEdits;
  const verify = o.verify === undefined ? verifySystem : o.verify;

  const report: CriticReport = {
    status: "done",
    stop: "none",
    cycles: [],
    fixes: [],
    rolledBack: [],
    before: { penalty: 0, problems: 0 },
    after: { penalty: 0, problems: 0 },
    left: [],
    spentRub: 0,
    inspections: 0,
    files: new Map(),
    notes: [],
  };
  const skip = (reason: string): CriticReport => ({ ...report, status: "skipped", reason, notes: [reason] });

  const site0 = readSite(ctx.files);
  if (!site0 || site0.pages.length === 0) return skip("Публичных страниц нет — смотреть критику нечего.");
  const routes = criticRoutes(site0);
  if (routes.length === 0) return skip("Публичных страниц без входа нет — смотреть критику нечего.");
  const facts: SiteFacts = siteFacts(ctx);
  const env: EditEnv = { library, numbers: facts.numbers };
  const signatures = new Map<string, string>();
  for (const p of site0.pages)
    for (const s of p.sections) {
      const src = s.file ? ctx.files.get(s.file) : undefined;
      if (s.file && src !== undefined) signatures.set(s.file, src);
    }
  const fonts = [...new Set([ctx.design.fonts.display.family, ctx.design.fonts.text.family])];
  const seed = `${ctx.design.seed}:${ctx.systemId}`;

  const layerOf = (st: CriticState) =>
    siteFiles(st.site, facts.name, st.design, ctx.files, signatures, library);
  const filesOf = (st: CriticState) => merged(ctx.files, layerOf(st));
  const timeLeft = () => now() - t0 < timeMs;
  const canInspect = () => report.inspections < maxInspections && timeLeft();
  let stubPhotos = false;
  const inspect = async (st: CriticState, rs: readonly string[], shots: readonly CriticShotRequest[]) => {
    report.inspections += 1;
    const r: CriticInspection = await o.inspect({
      spec: ctx.spec,
      files: filesOf(st),
      routes: rs,
      viewports: CRITIC_VIEWPORTS,
      shots,
      fonts,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    stubPhotos ||= r.stubPhotos === true;
    return r;
  };
  const lintCount = (st: CriticState, route: string) => {
    const page = st.site.pages.find((p) => p.route === route);
    return page ? lintErrors(lintSitePage(st.site, page, facts, library, signatures)).length : 0;
  };
  /** Problems of the routes just inspected replace theirs; the rest stay. */
  const withRoutes = (
    all: readonly DeterministicProblem[],
    rs: readonly string[],
    fresh: DeterministicProblem[],
  ) => [...all.filter((p) => !rs.includes(p.route)), ...fresh];
  const renderKeys = (ps: readonly DeterministicProblem[]) =>
    new Set(ps.filter((p) => p.code === "RENDER").map(problemKey));

  // 0. The site as the scenarios left it: the checks of every page and the screenshots of the first cycle.
  let state: CriticState = { site: site0, design: ctx.design };
  const plan = () => shotPlan(state.site);
  const first = await inspect(state, routes, plan());
  if (!first.ok)
    return skip(`Сайт не открылся для просмотра (${first.error ?? "ошибка сборки"}) — критика пропущена.`);
  let problems = first.problems;
  let shots: CriticShot[] = first.shots;
  let shotsOf: CriticState | null = state;
  report.before = { penalty: problemPenalty(problems), problems: problemDigest(problems).length };

  /**
   * A candidate state: lint of the touched pages must not get worse, G0 (when asked) must pass, the browser checks of
   * the affected pages must not get worse (no new failed render). Returns the merged problems or the reason.
   */
  type Trial =
    | { ok: true; problems: DeterministicProblem[]; insp: CriticInspection }
    | { ok: false; reason: string };
  const trial = async (
    cand: CriticState,
    touched: "all" | readonly string[],
    o2: { g0: boolean; shots: boolean },
  ): Promise<Trial> => {
    const rs = touched === "all" ? routes : routes.filter((r) => touched.includes(r));
    for (const r of touched === "all" ? routes : rs)
      if (lintCount(cand, r) > lintCount(state, r)) return { ok: false, reason: `линтер страницы ${r}` };
    if (o2.g0 && verify) {
      const before = filesOf(state);
      const after = filesOf(cand);
      const focus = [...after.keys()].filter((k) => before.get(k) !== after.get(k));
      const v = await verify(ctx.spec, after, focus);
      if (!v.ok) return { ok: false, reason: `сборка: ${v.problems[0]?.slice(0, 160) ?? "G0"}` };
    }
    if (!canInspect()) return { ok: false, reason: "нет времени на проверку в браузере" };
    const shotReq = o2.shots ? shotPlan(cand.site) : [];
    const inspected = [...new Set([...rs, ...shotReq.map((s) => s.route)])];
    const insp = await inspect(cand, inspected, shotReq);
    if (!insp.ok) return { ok: false, reason: `сборка в браузере: ${insp.error ?? "ошибка"}` };
    const next = withRoutes(problems, inspected, insp.problems);
    const oldRender = renderKeys(problems);
    if ([...renderKeys(next)].some((k) => !oldRender.has(k)))
      return { ok: false, reason: "страница перестала открываться" };
    if (problemPenalty(next) > problemPenalty(problems)) {
      const was = new Set(problems.map(problemKey));
      const fresh = problemDigest(next).filter((d) => !was.has(d.key));
      return {
        ok: false,
        reason: `проверки в браузере: ${fresh[0] ? `${fresh[0].code} ${fresh[0].where}` : "стало хуже"}`,
      };
    }
    return { ok: true, problems: next, insp };
  };

  // 1. Deterministic fixes (no model): another variant of a section the checks flag, then a token step for contrast.
  const sectionOf = (st: CriticState, route: string, id: string) =>
    st.site.pages.find((p) => p.route === route)?.sections.find((s) => s.id === id);
  const targets = problemDigest(problems)
    .filter(
      (d) => FIXABLE.has(d.code) && d.section && sectionOf(state, d.route, d.section)?.type !== "signature",
    )
    .sort((a, b) => SEV_ORDER(CHECK_RUBRIC[a.code].severity) - SEV_ORDER(CHECK_RUBRIC[b.code].severity));
  const tried = new Set<string>();
  const detStart = state;
  for (const t of targets) {
    if (tried.size >= CRITIC_LIMITS.maxFixes || !canInspect()) break;
    const id = t.section as string;
    const key = `${t.route}#${id}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const s = sectionOf(state, t.route, id);
    if (!s) continue;
    const page = state.site.pages.find((p) => p.route === t.route) as SitePage;
    const i = page.sections.indexOf(s);
    const near = new Set(
      [page.sections[i - 1], page.sections[i + 1]].map(
        (x) => library.find((p) => p.id === x?.pattern)?.layout,
      ),
    );
    const alts = variantsFor(library, s).sort(
      (a, b) =>
        Number(near.has(a.layout)) - Number(near.has(b.layout)) ||
        hash32(`${seed}:${id}:${a.id}`) - hash32(`${seed}:${id}:${b.id}`),
    );
    const mine = (ps: readonly DeterministicProblem[]) =>
      problemPenalty(ps.filter((p) => p.route === t.route && p.section === id));
    // A fix of another section (a site-wide header) may have taken this one's problems too.
    if (mine(problems) === 0) continue;
    for (const alt of alts.slice(0, 2)) {
      if (!canInspect()) break;
      const r = applyEdit(state, { op: "swap_variant", route: t.route, section: id, pattern: alt.id }, env);
      if (!r.ok) continue;
      const tr = await trial(r.state, r.touched === "site" ? "all" : [t.route], { g0: false, shots: false });
      if (
        !tr.ok ||
        mine(tr.problems) >= mine(problems) ||
        problemPenalty(tr.problems) >= problemPenalty(problems)
      )
        continue;
      state = r.state;
      problems = tr.problems;
      report.fixes.push(`${r.summary_ru} (${t.code})`);
      break;
    }
  }
  const plainContrast = problemDigest(problems).filter(
    (d) => d.code === "C08" && !d.message_ru.includes("на фото"),
  );
  if (plainContrast.length >= 2) {
    const schemes = new Set(
      problems.filter((p) => p.code === "C08" && !p.message_ru.includes("на фото")).map((p) => p.scheme),
    );
    for (const scheme of schemes) {
      if (!canInspect()) break;
      const r = applyEdit(state, { op: "token", token: "muted_contrast", value: scheme }, env);
      if (!r.ok) continue;
      const tr = await trial(r.state, "all", { g0: false, shots: false });
      if (tr.ok && problemPenalty(tr.problems) < problemPenalty(problems)) {
        state = r.state;
        problems = tr.problems;
        report.fixes.push(`${r.summary_ru} (C08)`);
      }
    }
  }
  if (state !== detStart && verify) {
    // The swaps are slot-checked; G0 once for the whole phase (a failure drops the phase).
    const before = filesOf(detStart);
    const after = filesOf(state);
    const v = await verify(
      ctx.spec,
      after,
      [...after.keys()].filter((k) => before.get(k) !== after.get(k)),
    );
    if (!v.ok) {
      report.rolledBack.push(...report.fixes);
      report.fixes = [];
      state = detStart;
      problems = first.problems;
    }
  }

  // 2. Model cycles on the screenshots.
  let spentMilli = 0;
  const spent = () => round2((spentMilli / 1000) * rpc);
  const left = () => cap - spent();
  const lastCall: { model?: string; tier?: string } = {};
  const route: RouteFn = async (input) => {
    const ub = upperBoundCredits(input.callType as CallType, input.messages, input.tools ?? [], registry);
    const need = round2(ub * rpc);
    if (need > left()) throw new CriticBudgetStop(need);
    const out = await ctx.route(input);
    spentMilli += out.creditsMilli;
    lastCall.model = out.model;
    lastCall.tier = out.tier;
    return out;
  };
  const base = {
    route,
    orgPolicy: o.orgPolicy ?? null,
    ctx: o.routeCtx ?? { orgId: "host", systemId: ctx.systemId },
    ...(o.runStep ? { runStep: o.runStep } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    maxRepairs: 1,
  };
  const history: CritiqueHistory[] = [];
  let prev: { score: number; before: CriticState; problems: DeterministicProblem[]; batch: string[] } | null =
    null;

  for (let n = 1; n <= maxCycles; n++) {
    if (!timeLeft()) {
      report.stop = "time";
      break;
    }
    if (shotsOf !== state) {
      if (!canInspect()) {
        report.stop = "inspections";
        break;
      }
      const rs = [...new Set(plan().map((s) => s.route))];
      const insp = await inspect(state, rs, plan());
      if (!insp.ok) {
        report.stop = "inspections";
        break;
      }
      problems = withRoutes(problems, rs, insp.problems);
      shots = insp.shots;
      shotsOf = state;
    }
    const messages = critiqueMessages({
      facts,
      brief: ctx.brief,
      site: state.site,
      design: state.design,
      library,
      shots,
      found: problems,
      history,
      stubPhotos,
    });
    const need = round2(
      upperBoundCredits(CRITIC_CALL_TYPE, messages, [critiqueTool.definition], registry) * rpc,
    );
    if (need > left()) {
      report.stop = "budget";
      break;
    }
    const spentBefore = spent();
    let critique: Critique;
    try {
      const r = await callTool({
        ...base,
        callType: CRITIC_CALL_TYPE,
        stepName: `critic_visual:${n}`,
        messages,
        tool: critiqueTool,
      });
      if (!r.ok) {
        report.stop = "model";
        break;
      }
      critique = r.value;
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      report.stop = e instanceof CriticBudgetStop || e instanceof V3BudgetError ? "budget" : "model";
      break;
    }
    const score = critiqueScore(critique);
    const cycle: CriticCycle = {
      n,
      score,
      pass: critiquePasses(critique),
      axes: critique.axes,
      polish: critique.polish,
      findings: critique.findings.length,
      applied: [],
      rejected: [],
      costRub: round2(spent() - spentBefore),
      ...(lastCall.model ? { model: lastCall.model, tier: lastCall.tier as string } : {}),
    };
    report.cycles.push(cycle);
    if (prev && score < prev.score) {
      // The last batch made the site worse in the model's eyes: back to the state before it.
      state = prev.before;
      problems = prev.problems;
      report.rolledBack.push(...prev.batch);
      report.stop = "no_gain";
      break;
    }
    if (prev && score === prev.score) {
      report.stop = "no_gain";
      break;
    }
    if (cycle.pass) {
      report.stop = "pass";
      break;
    }
    const edits = critique.findings
      .filter((f) => f.edit)
      .sort((a, b) => SEV_ORDER(a.severity) - SEV_ORDER(b.severity))
      .slice(0, maxEdits)
      .map((f) => f.edit as EditOp);
    // Edits one by one on the model (cheap: slot schemas, copy rules, the linter of the page).
    let cand = state;
    const accepted: { op: EditOp; summary: string; touched: "all" | string[] }[] = [];
    for (const op of edits) {
      const r = applyEdit(cand, op, env);
      if (!r.ok) {
        cycle.rejected.push({ edit: describeEdit(op), reason_ru: r.reason_ru });
        continue;
      }
      const touched = r.touched === "site" ? routes : [r.route as string];
      const worse = touched.find((rt) => lintCount(r.state, rt) > lintCount(cand, rt));
      if (worse) {
        cycle.rejected.push({ edit: describeEdit(op), reason_ru: `линтер страницы ${worse}` });
        continue;
      }
      cand = r.state;
      accepted.push({ op, summary: r.summary_ru, touched: r.touched === "site" ? "all" : touched });
    }
    if (accepted.length === 0) {
      history.push({ cycle: n, applied: [], rejected: cycle.rejected });
      report.stop = "no_edits";
      break;
    }
    const touchedOf = (xs: typeof accepted): "all" | string[] =>
      xs.some((x) => x.touched === "all") ? "all" : [...new Set(xs.flatMap((x) => x.touched as string[]))];
    const more = n < maxCycles;
    const before = { state, problems };
    // The batch: G0 and one browser check; on a regression each edit alone, the bad ones rolled back.
    const tr = await trial(cand, touchedOf(accepted), { g0: true, shots: more });
    if (tr.ok) {
      state = cand;
      problems = tr.problems;
      if (more) {
        shots = tr.insp.shots;
        shotsOf = state;
      }
      cycle.applied = accepted.map((x) => x.summary);
    } else {
      let s2 = state;
      for (const x of accepted) {
        const r = applyEdit(s2, x.op, env);
        if (!r.ok) continue;
        const t2 = await trial(r.state, x.touched, { g0: true, shots: false });
        if (t2.ok) {
          s2 = r.state;
          state = s2;
          problems = t2.problems;
          cycle.applied.push(x.summary);
        } else {
          cycle.rejected.push({ edit: describeEdit(x.op), reason_ru: `откат: ${t2.reason}` });
          report.rolledBack.push(`${x.summary} (${t2.reason})`);
        }
      }
    }
    history.push({ cycle: n, applied: cycle.applied, rejected: cycle.rejected });
    if (cycle.applied.length === 0) {
      report.stop = "no_edits";
      break;
    }
    prev = { score, before: before.state, problems: before.problems, batch: cycle.applied };
    if (n === maxCycles) report.stop = "cycles";
  }

  report.spentRub = spent();
  report.after = { penalty: problemPenalty(problems), problems: problemDigest(problems).length };
  report.left = problems;
  report.files =
    state.site === site0 && state.design === ctx.design ? new Map() : changed(layerOf(state), ctx.files);
  report.notes = criticNotes(report);
  return report;
}

/** Short Russian notes for the client: what was looked at, what changed, what is left. */
function criticNotes(r: CriticReport): string[] {
  const out: string[] = [];
  const scores = r.cycles.map((c) => c.score);
  const look =
    scores.length > 0
      ? `Посмотрел сайт на телефоне, планшете и компьютере глазами дизайнера: ${r.cycles.length} ${r.cycles.length === 1 ? "круг" : "круга"}, оценка ${scores[0]}${scores.length > 1 ? ` → ${scores.at(-1)}` : ""} из 100.`
      : "Проверил сайт в браузере на телефоне, планшете и компьютере: контраст, переполнение, шрифты, сдвиги вёрстки.";
  out.push(look);
  const done = [...r.fixes, ...r.cycles.flatMap((c) => c.applied)].filter((x) => !r.rolledBack.includes(x));
  if (done.length)
    out.push(`Поправил ${done.length} ${RU_PROBLEMS(done.length)}: ${done.slice(0, 3).join("; ")}.`);
  const left = problemDigest(r.left).filter((d) => d.code !== "RENDER");
  if (left.length)
    out.push(
      `Осталось поправить вручную: ${left
        .slice(0, 3)
        .map((d) => `${CHECK_RUBRIC[d.code].label} — ${d.where}`)
        .join("; ")}.`,
    );
  return out;
}

/** The stage hook `critic` of the harness v3 (V3HookResult: the files layer, notes, no blockers). */
export function createCriticHook(o: CriticOptions): V3StageHook {
  return async (ctx): Promise<V3HookResult> => {
    const r = await runCritic(ctx, o);
    if (r.status === "skipped") return { status: "skipped", ...(r.reason ? { note: r.reason } : {}) };
    const scores = r.cycles.map((c) => c.score);
    return {
      status: "done",
      files: r.files,
      notes: r.notes,
      // Model calls went through ctx.route: the harness wallet has them.
      spentRub: 0,
      note: [
        `циклов ${r.cycles.length}`,
        ...(scores.length ? [`оценка ${scores.join("→")}`] : []),
        `проверки ${r.before.penalty}→${r.after.penalty}`,
        `правок ${r.fixes.length + r.cycles.reduce((s, c) => s + c.applied.length, 0)}`,
        ...(r.rolledBack.length ? [`откатов ${r.rolledBack.length}`] : []),
        `${r.spentRub} ₽`,
        `стоп ${r.stop}`,
      ].join(", "),
    };
  };
}
