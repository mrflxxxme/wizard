// The visual critic of the build v3 (V3-13; builder-v3.md §3 C6 stage `critic`, D77 (6), design-agent-catalog.md C):
// algorithms ahead of models. 1) The host's inspector builds the site and runs the deterministic checks at 390/768/1440
// (contrast, overflow, fonts, CLS, touch, names, headings); what code can fix it fixes without a model — another
// variant of the section, a token step — and keeps a fix only when the checks get better. 2) Up to 3 cycles of the
// vision model (critic_visual: with images the router keeps it on T0) on the screenshots: axis scores and findings
// with edits from a closed set (ops.ts). Each edit is linted, the batch is built (G0) and checked in the browser again;
// a regression is rolled back edit by edit. The loop stops on «pass», when the score stops growing (a batch that made
// it worse is rolled back), on the budget (≤ 40 ₽ and ctx.budgetRub, checked by the upper bound before each call),
// on time or when nothing applies. The result is a layer of files for the harness; the critic never blocks a build.
import { type KnownContacts, knownContacts, type StubFinding, stubFindings } from "@wizard/gates";
import {
  type CallType,
  createRegistry,
  modelFamily,
  type OrgPolicy,
  type Registry,
  type RouteContext,
} from "@wizard/llm";
import type { DesignSystemV3 } from "@wizard/ui-kit/v3/design";
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
import { pointEditIssues } from "../edit/point.js";
import type { V3HookResult, V3StageHook } from "../harness/types.js";
import { V3BudgetError } from "../harness/wallet.js";
import { CRITIC_VIEWPORTS } from "./checks.js";
import { editKey, impliedEdit } from "./implied.js";
import {
  applyEdit,
  type CriticState,
  type EditEnv,
  type EditOp,
  signatureFallback,
  variantsFor,
} from "./ops.js";
import { ownerCriticNotes, ownerEdit, ruPlaces } from "./owner.js";
import { CRITIC_CALL_TYPE, type CritiqueHistory, critiqueMessages, critiqueTool } from "./prompt.js";
import {
  CHECK_RUBRIC,
  type CheckCode,
  type CodePatch,
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

/** Caps of the critic (V3-13: ≤ 40 ₽; V4-09: ≤ 2 cycles). */
export const CRITIC_LIMITS = {
  maxCycles: 2,
  budgetRub: 40,
  /** Wall clock of the stage, ms. */
  timeMs: 6 * 60_000,
  /** Browser inspections of the stage (each builds the site and opens its pages). */
  maxInspections: 16,
  /** Model edits applied per cycle. */
  maxEdits: 6,
  /** Sections the deterministic phase tries to fix by another variant. */
  maxFixes: 4,
  /**
   * The founder's floor of the score (10.10.2026: a built site never below 30): under it an unchanged score does not
   * stop the loop — the next cycle tries the other findings while cycles and budget last.
   */
  floor: 30,
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
  /**
   * V4-09: model families of the pages' author in this build (the platform reads them from the run's calls); the critic
   * is never of one of them. Default: the family of the head of the page writer's route.
   */
  authorFamilies?: () => Promise<readonly string[]>;
}

/** One model cycle: the verdict on the state it saw and what its edits did. */
export interface CriticCycle {
  n: number;
  score: number;
  pass: boolean;
  axes: Critique["axes"];
  polish: Critique["polish"];
  findings: number;
  /** The main findings (by severity, at most 8): the operator's view of why the score is what it is. */
  top: { severity: string; sign: string; where: string }[];
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
  /** What the owner reads (V4-09: plain words, no routes or keys; ownerCriticNotes). */
  notes: string[];
  /** The accepted model edits as the owner reads them («заголовок первого экрана главной»). */
  owner: string[];
  /** The technical lines for the staff (routes, anchors, scores) — the report V4-04, not the owner. */
  details: string[];
  /** The design system after token edits (absent — the critic kept ctx.design); the harness applies it (V3-14 seam). */
  design?: DesignSystemV3;
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
 * Images of one critic call at most: Cloud.ru takes at most 4 vision chunks for kimi-k2.6 and 2 images for qwen3.6-35b
 * per prompt (shape probe 2026-10-09, v3-004: 6 images were a 400 on both) — two keep every model of the chain.
 */
export const CRITIC_MAX_IMAGES = 2;

/**
 * Screenshots of a cycle (≤ CRITIC_MAX_IMAGES): the home page's first screen at 390 (as is) and the whole home page at
 * 1440 (a quarter: the rhythm «при прищуре»). The other pages and widths are covered by the in-page checks.
 */
export function shotPlan(site: SiteModel): CriticShotRequest[] {
  const home = site.pages.find((p) => p.route === "/") ?? site.pages[0];
  if (!home) return [];
  const plan: CriticShotRequest[] = [
    { route: home.route, width: 390, kind: "screen", maxWidth: 390, maxHeight: 844 },
    { route: home.route, width: 1440, kind: "page", maxWidth: 360, maxHeight: 2400 },
  ];
  return plan.slice(0, CRITIC_MAX_IMAGES);
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

/** An edit of a cycle: a closed operation or a code edit (V4-09). */
export type Change = { kind: "op"; op: EditOp } | { kind: "patch"; patch: CodePatch };

export const describeChange = (ch: Change): string =>
  ch.kind === "op" ? describeEdit(ch.op) : describePatch(ch.patch);

/** Short Russian form of a code edit. */
export function describePatch(p: CodePatch): string {
  const what = p.replace.replace(/\s+/g, " ").trim().slice(0, 60);
  return `${p.file}: правка кода «${what}»`;
}

/** V4-18: a stub of `file` the edit adds (S01–S04 of @wizard/gates, its file only), in words; null — none. */
export function newStub(
  files: ReadonlyMap<string, string>,
  file: string,
  after: string,
  contacts: KnownContacts,
): string | null {
  const key = (f: StubFinding) => `${f.code}|${f.section ?? ""}|${f.literal ?? ""}`;
  const of = (fs: ReadonlyMap<string, string>) =>
    stubFindings({ files: fs, known: contacts }).filter((f) => f.file === file);
  const was = new Set(of(files).map(key));
  const added = of(new Map([...files, [file, after]])).find((f) => !was.has(key(f)));
  return added ? `${added.code} ${added.message_ru}${added.literal ? ` («${added.literal}»)` : ""}` : null;
}

/** Families of the head models of the page writer's route (the default author of the pages). */
export function defaultAuthorFamilies(reg: Registry): string[] {
  const chain = reg.routes.page_compose.chain;
  const out = new Set<string>();
  for (const id of [chain.T1?.[0], chain.T0?.[0]]) {
    const m = id ? reg.models.find((x) => x.id === id) : undefined;
    if (m) out.add(modelFamily(m));
  }
  return [...out].sort();
}

/** The generated layer with the code edits over it (a patch whose fragment is not there exactly once is skipped). */
export function withCode(
  layer: Map<string, string | null>,
  base: ReadonlyMap<string, string>,
  code: readonly CodePatch[] = [],
): Map<string, string | null> {
  if (!code.length) return layer;
  const out = new Map(layer);
  for (const p of code) {
    const src = out.has(p.file) ? out.get(p.file) : base.get(p.file);
    if (typeof src !== "string") continue;
    const at = src.indexOf(p.find);
    if (at < 0 || src.indexOf(p.find, at + 1) >= 0) continue;
    out.set(p.file, src.slice(0, at) + p.replace + src.slice(at + p.find.length));
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

const RU_PROBLEMS = ruPlaces;

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
    owner: [],
    details: [],
  };
  const skip = (reason: string): CriticReport => ({ ...report, status: "skipped", reason, notes: [reason] });

  const site0 = readSite(ctx.files);
  if (!site0 || site0.pages.length === 0) return skip("Публичных страниц нет — смотреть критику нечего.");
  const routes = criticRoutes(site0);
  if (routes.length === 0) return skip("Публичных страниц без входа нет — смотреть критику нечего.");
  const facts: SiteFacts = siteFacts(ctx);
  const env: EditEnv = { library, numbers: facts.numbers };
  // V4-18: the contacts the owner gave; a phone or an e-mail beyond them on the site is S04.
  const c = ctx.spec.compliance ?? {};
  const contacts = knownContacts([
    JSON.stringify(ctx.brief),
    ctx.request ?? "",
    c.operatorContact ?? "",
    c.operatorAddress ?? "",
  ]);
  const signatures = new Map<string, string>();
  for (const p of site0.pages)
    for (const s of p.sections) {
      const src = s.file ? ctx.files.get(s.file) : undefined;
      if (s.file && src !== undefined) signatures.set(s.file, src);
    }
  const fonts = [...new Set([ctx.design.fonts.display.family, ctx.design.fonts.text.family])];
  const seed = `${ctx.design.seed}:${ctx.systemId}`;

  const layerOf = (st: CriticState) =>
    withCode(
      siteFiles(st.site, facts.copy.site, st.design, ctx.files, signatures, library),
      ctx.files,
      st.code,
    );
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
      contacts,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    stubPhotos ||= r.stubPhotos === true;
    return r;
  };
  const lintCount = (st: CriticState, route: string) => {
    const page = st.site.pages.find((p) => p.route === route);
    return page ? lintErrors(lintSitePage(st.site, page, facts, library, signatures)).length : 0;
  };
  /** A closed operation on the site model or a code edit of a file (V4-09). */
  type Applied =
    | { ok: true; state: CriticState; summary_ru: string; touched: "all" | string[] }
    | { ok: false; reason_ru: string };
  const applyChange = (st: CriticState, ch: Change): Applied => {
    if (ch.kind === "op") {
      const r = applyEdit(st, ch.op, env);
      if (!r.ok) return r;
      return {
        ok: true,
        state: r.state,
        summary_ru: r.summary_ru,
        touched: r.touched === "site" ? "all" : [r.route as string],
      };
    }
    const p = ch.patch;
    if (p.file.startsWith("ui/patterns/"))
      return { ok: false, reason_ru: "библиотеку секций не правим — только страницы и фирменные секции" };
    const before = filesOf(st).get(p.file);
    if (before === undefined) return { ok: false, reason_ru: `файла ${p.file} нет` };
    const at = before.indexOf(p.find);
    if (at < 0 || before.indexOf(p.find, at + 1) >= 0)
      return { ok: false, reason_ru: "фрагмент не найден в файле ровно один раз" };
    const after = before.slice(0, at) + p.replace + before.slice(at + p.find.length);
    const issues = pointEditIssues(p.file, before, after);
    if (issues.length) return { ok: false, reason_ru: issues[0]?.message ?? "правка не прошла проверку" };
    // V4-18: an edit that adds a stub (a dead link, a placeholder, a strange contact) is refused before the browser.
    const stub = newStub(filesOf(st), p.file, after, contacts);
    if (stub) return { ok: false, reason_ru: `правка добавляет заглушку: ${stub}` };
    const pages = st.site.pages.filter((pg) => pg.file === p.file).map((pg) => pg.route);
    return {
      ok: true,
      state: { ...st, code: [...(st.code ?? []), p] },
      summary_ru: describePatch(p),
      touched: pages.length ? pages : "all",
    };
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
  // A signature section (free code) has no variants: one the checks still flag for contrast or overflow gives its
  // place to a pattern (the plan's rule), kept only when the checks get better.
  const signatureBroken = problemDigest(problems).filter(
    (d) =>
      (d.code === "C08" || d.code === "L11") &&
      d.section &&
      sectionOf(state, d.route, d.section)?.type === "signature",
  );
  for (const t of signatureBroken) {
    if (!canInspect()) break;
    const id = t.section as string;
    if (sectionOf(state, t.route, id)?.type !== "signature") continue;
    const r = signatureFallback(state, t.route, id, env);
    if (!r.ok) continue;
    const tr = await trial(r.state, [t.route], { g0: false, shots: false });
    if (!tr.ok || problemPenalty(tr.problems) >= problemPenalty(problems)) continue;
    state = r.state;
    problems = tr.problems;
    report.fixes.push(`${r.summary_ru} (${t.code})`);
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
  // V4-09: the critic is never of the pages' author's family.
  const avoid = [
    ...new Set([...defaultAuthorFamilies(registry), ...((await o.authorFamilies?.().catch(() => [])) ?? [])]),
  ];
  const route: RouteFn = async (input) => {
    const ub = upperBoundCredits(input.callType as CallType, input.messages, input.tools ?? [], registry);
    const need = round2(ub * rpc);
    if (need > left()) throw new CriticBudgetStop(need);
    const out = await ctx.route({
      ...input,
      avoidFamilies: [...new Set([...(input.avoidFamilies ?? []), ...avoid])],
    });
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
      // V4-09: the code of the shown pages — the patches edit it.
      code: new Map(
        [...new Set(shots.map((x) => x.route))].flatMap((rt) => {
          const file = state.site.pages.find((pg) => pg.route === rt)?.file;
          const src = file ? filesOf(state).get(file) : undefined;
          return file && src !== undefined ? [[file, src] as const] : [];
        }),
      ),
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
      top: [...critique.findings]
        .sort((a, b) => SEV_ORDER(a.severity) - SEV_ORDER(b.severity))
        .slice(0, 8)
        .map((f) => ({ severity: f.severity, sign: f.sign.slice(0, 160), where: f.where })),
      applied: [],
      rejected: [],
      costRub: round2(spent() - spentBefore),
      ...(lastCall.model ? { model: lastCall.model, tier: lastCall.tier as string } : {}),
    };
    report.cycles.push(cycle);
    // V4-09: the model's opinion never accepts or rolls back an edit — the deterministic checks did; a cycle that did
    // not raise the score only stops the loop.
    if (prev && score < prev.score) {
      report.stop = "no_gain";
      break;
    }
    if (prev && score === prev.score && (score >= CRITIC_LIMITS.floor || n >= maxCycles)) {
      report.stop = "no_gain";
      break;
    }
    if (cycle.pass) {
      report.stop = "pass";
      break;
    }
    // A finding's code edit (V4-09) or closed edit; without either — the one its catalog sign implies (V3-40); one
    // edit per section or fragment, the most severe first.
    const seen = new Set<string>();
    const edits = [...critique.findings]
      .sort((a, b) => SEV_ORDER(a.severity) - SEV_ORDER(b.severity))
      .map((f): Change | null => {
        if (f.patch) return { kind: "patch", patch: f.patch };
        const op = f.edit ?? impliedEdit(f, state, library, seed);
        return op ? { kind: "op", op } : null;
      })
      .filter((ch): ch is Change => {
        if (!ch) return false;
        const key = ch.kind === "op" ? editKey(ch.op) : `${ch.patch.file}\u0000${ch.patch.find}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, maxEdits);
    // Edits one by one on the model (cheap: slot schemas, copy rules, the linter of the page; a code edit — it parses,
    // keeps the file's imports and data bindings, no raw colours or fonts).
    let cand = state;
    const accepted: { change: Change; summary: string; touched: "all" | string[] }[] = [];
    for (const change of edits) {
      const r = applyChange(cand, change);
      if (!r.ok) {
        cycle.rejected.push({ edit: describeChange(change), reason_ru: r.reason_ru });
        continue;
      }
      const touched = r.touched === "all" ? routes : r.touched;
      const worse = touched.find((rt) => lintCount(r.state, rt) > lintCount(cand, rt));
      if (worse) {
        cycle.rejected.push({ edit: describeChange(change), reason_ru: `линтер страницы ${worse}` });
        continue;
      }
      cand = r.state;
      accepted.push({ change, summary: r.summary_ru, touched: r.touched });
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
      report.owner.push(...accepted.map((x) => ownerEdit(state.site, x.change)));
    } else {
      let s2 = state;
      for (const x of accepted) {
        const r = applyChange(s2, x.change);
        if (!r.ok) continue;
        const t2 = await trial(r.state, x.touched, { g0: true, shots: false });
        if (t2.ok) {
          s2 = r.state;
          state = s2;
          problems = t2.problems;
          cycle.applied.push(x.summary);
          report.owner.push(ownerEdit(state.site, x.change));
        } else {
          cycle.rejected.push({ edit: describeChange(x.change), reason_ru: `откат: ${t2.reason}` });
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
    state.site === site0 && state.design === ctx.design && !state.code?.length
      ? new Map()
      : changed(layerOf(state), ctx.files);
  report.details = criticNotes(report);
  report.notes = ownerCriticNotes({
    edits: report.owner,
    fixes: report.fixes,
    left: problemDigest(report.left),
    site: state.site,
  });
  if (state.design !== ctx.design) report.design = state.design;
  return report;
}

/** The technical lines for the staff report: what was looked at, what changed (routes, anchors), what is left. */
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
      ...(r.design ? { design: r.design } : {}),
      review: {
        stop: r.stop,
        fixes: r.fixes,
        cycles: r.cycles.map((c) => ({ n: c.n, score: c.score, axes: c.axes, polish: c.polish, top: c.top })),
        // The problems the checks still see (stubs S01–S04 among them): the staff report lists them by code.
        left: problemDigest(r.left).map((d) => ({ code: d.code, where: d.where, message_ru: d.message_ru })),
      },
      // Model calls went through ctx.route: the harness wallet has them.
      spentRub: 0,
      note:
        [
          `циклов ${r.cycles.length}`,
          ...(scores.length ? [`оценка ${scores.join("→")}`] : []),
          `проверки ${r.before.penalty}→${r.after.penalty}`,
          `правок ${r.fixes.length + r.cycles.reduce((s, c) => s + c.applied.length, 0)}`,
          ...(r.rolledBack.length ? [`откатов ${r.rolledBack.length}`] : []),
          `${r.spentRub} ₽`,
          `стоп ${r.stop}`,
        ].join(", ") + (r.details.length ? ` | ${r.details.join(" ")}` : ""),
    };
  };
}
