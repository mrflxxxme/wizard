// A scenario of the brief brought to its page(s) (V3-12, V4-06; builder-v3.md C6 stage «scenarios»; D79 (2)): the model
// writes each page the scenario touches as free code — sections of React 19 + Tailwind on the tokens + Motion — and
// keeps the SDK components (the request form, booking, cart, login, the system's data) as they are (page-code.ts);
// the page passes the pattern and page lint, the SDK gate and G0 before it is accepted; the home page's first screen
// gets a rival of another family and a judge by the screenshots (page-step.ts). Every call fits ctx.budgetRub first.
import type { AppSpec, BriefScenario } from "@wizard/appspec";
import { runG0 } from "@wizard/gates";
import { type CallType, createRegistry, type OrgPolicy, type Registry, type RouteContext, type RouteInput } from "@wizard/llm";
import { PATTERNS, patternById } from "@wizard/ui-kit/v3/patterns";
import type { RunStepFn } from "../../../core/events.js";
import type { RouteFn } from "../../../core/loop.js";
import { upperBoundCredits } from "../../budget.js";
import { milliToRub } from "../../v2/wallet.js";
import type { V3BuildContext, V3ComposeResult } from "../contract.js";
import type { CriticInspector } from "../critic/types.js";
import { siteFiles } from "./codegen.js";
import { siteRules } from "./content.js";
import { siteFacts } from "./facts.js";
import { lintErrors } from "./lint.js";
import { pageCode } from "./page-step.js";
import { pagePlans, readSite, type SiteModel, type SitePage } from "./site.js";
import { type ComposeLibrary, composeSite, lintSitePage } from "./skeleton.js";

/** callTypes of the composer (models.yaml#routes; data-boundary.yaml: T1 only scrubbed, no records of the system). */
export const COMPOSE_CALL_TYPES = {
  page: "page_compose",
  /** The rival author of the first screen (another family). */
  signature: "signature_section",
} as const satisfies Record<string, CallType>;

/** G0 of the system with a new section: problems of the files in `focus` (or without a file); ok when none. */
export type ScenarioVerify = (
  spec: AppSpec,
  files: ReadonlyMap<string, string>,
  focus: readonly string[],
) => Promise<{ ok: boolean; problems: string[] }>;

export interface ComposeScenarioOptions extends ComposeLibrary {
  /** G0 check of a signature section (default verifySystem). */
  verify?: ScenarioVerify;
  registry?: Registry;
  orgPolicy?: OrgPolicy | null;
  routeCtx?: RouteContext;
  runStep?: RunStepFn;
  /** Repairs of an answer that fails the checks (default 2). */
  maxRepairs?: number;
  /** The host's browser: screenshots of the two first-screen candidates for the judge (absent — the first stays). */
  inspect?: CriticInspector;
  /** false — no rival first screen and no judge (default: on the home page). */
  firstScreen?: boolean;
}

/** G0-IMP-01, G0-SEC-01, G0-TS-01 and G0-BUILD-01 of the system (no database): the checks free code must pass. */
export const verifySystem: ScenarioVerify = async (spec, files, focus) => {
  const report = await runG0(
    {
      spec,
      prevSpec: null,
      specVersion: 0,
      files,
      env: "draft",
      systemKey: "compose_check",
      db: undefined as never,
    },
    { only: ["G0-IMP-01", "G0-SEC-01", "G0-TS-01", "G0-BUILD-01"] },
  );
  const bad = report.checks.filter(
    (c) => (c.status === "fail" || c.status === "error") && (!c.file || focus.includes(c.file)),
  );
  return {
    ok: bad.length === 0,
    problems: bad.map((c) => `${c.id}: ${c.message_ru}${c.evidence ? ` — ${c.evidence.slice(0, 300)}` : ""}`),
  };
};

/** The step would not fit the money left (ctx.budgetRub). */
class BudgetStop extends Error {
  constructor(readonly needRub: number) {
    super(`compose budget: need ${needRub}`);
  }
}

/** RouteFn over ctx.route that checks the upper bound of each call against the budget and counts what was spent. */
function walletRoute(ctx: V3BuildContext, registry: Registry) {
  const state = { spentMilli: 0 };
  const left = () => ctx.budgetRub - milliToRub(state.spentMilli, registry.rubPerCredit);
  const route: RouteFn = async (input: RouteInput) => {
    const ub = upperBoundCredits(input.callType as CallType, input.messages, input.tools ?? [], registry);
    const need = Math.round(ub * registry.rubPerCredit * 100) / 100;
    if (need > left()) throw new BudgetStop(need);
    const out = await ctx.route(input);
    state.spentMilli += out.creditsMilli;
    return out;
  };
  return { route, spent: () => milliToRub(state.spentMilli, registry.rubPerCredit), left };
}

// ------------------------------------------------------------------------------------------------ the step

/**
 * Pages a scenario touches: those of its module (moduleHint, or the module of a bound section — not a preview of its
 * data on home, V3-18), else the home page.
 */
function scenarioPages(site: SiteModel, s: BriefScenario, ctx: V3BuildContext): SitePage[] {
  const modules = new Set<string>(s.moduleHint ? [s.moduleHint] : []);
  const entityModule = new Map(ctx.publicFront.actions.map((a) => [a.entity, a.module]));
  const hits = site.pages.filter(
    (p) =>
      (p.module && modules.has(p.module)) ||
      p.sections.some(
        (x) =>
          typeof x.props.entity === "string" &&
          x.props.preview !== true &&
          modules.has(entityModule.get(x.props.entity) ?? ""),
      ),
  );
  const home = site.pages.find((p) => p.route === "/");
  return (hits.length ? hits : home ? [home] : []).slice(0, 2);
}

/** Only the files that differ from the system's (deletions of files it has). */
function changed(
  files: Map<string, string | null>,
  current: ReadonlyMap<string, string>,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [p, v] of files) if (v === null ? current.has(p) : current.get(p) !== v) out.set(p, v);
  return out;
}

export async function composeScenario(
  ctx: V3BuildContext,
  scenario: BriefScenario,
  opts: ComposeScenarioOptions = {},
): Promise<V3ComposeResult> {
  const library = opts.patterns ?? PATTERNS;
  const registry = opts.registry ?? createRegistry();
  const verify = opts.verify ?? verifySystem;
  const facts = siteFacts(ctx);
  let site = readSite(ctx.files) ?? composeSite(ctx, opts).site;
  const notes: string[] = [];
  const empty = (note: string): V3ComposeResult => ({
    files: new Map(),
    pages: [],
    notes: [note],
    spentRub: 0,
  });
  if (scenario.actor !== "visitor" && scenario.actor !== "client")
    return empty(`Сценарий «${scenario.id}» работает в кабинетах — публичные страницы не меняются.`);
  if (site.pages.length === 0)
    return empty("Публичных страниц в системе нет — сценарий проверяется в кабинетах.");

  const wallet = walletRoute(ctx, registry);
  const base = {
    route: wallet.route,
    orgPolicy: opts.orgPolicy ?? null,
    ctx: opts.routeCtx ?? { orgId: "host", systemId: ctx.systemId },
    ...(opts.runStep ? { runStep: opts.runStep } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    maxRepairs: opts.maxRepairs ?? 2,
  };
  // Sources of the signature sections already on the site (earlier scenarios) and of the ones written now.
  const signatures = new Map<string, string>();
  for (const p of site.pages)
    for (const s of p.sections) {
      const src = s.file ? ctx.files.get(s.file) : undefined;
      if (s.file && src !== undefined) signatures.set(s.file, src);
    }
  const targets = scenarioPages(site, scenario, ctx);
  const stop = (e: unknown): boolean => {
    if (ctx.signal?.aborted) throw e;
    if (e instanceof BudgetStop) {
      notes.push(`Бюджет шага исчерпан (нужно ≈ ${e.needRub} ₽): оставил тексты из брифа.`);
      return true;
    }
    notes.push(
      `Модель не ответила (${e instanceof Error ? e.message.slice(0, 120) : String(e)}): оставил каркас страницы.`,
    );
    return true;
  };

  for (const target of targets) {
    const page = site.pages.find((p) => p.route === target.route) as SitePage;
    const done = await pageCode(ctx, base, {
      site,
      page,
      scenario,
      facts,
      library,
      verify,
      signatures,
      notes,
      stop,
      registry,
      ...(opts.inspect ? { inspect: opts.inspect } : {}),
      firstScreen: opts.firstScreen !== false && page.route === "/",
    });
    if (done === "stop") break;
    if (!done) continue;
    for (const [f, src] of done.sources) signatures.set(f, src);
    site = { ...site, pages: site.pages.map((p) => (p.route === done.page.route ? done.page : p)) };
  }

  // The action rules of the site over the model's pages (siteFiles applies them as well).
  site = siteRules(site, (id) => library.find((p) => p.id === id) ?? patternById(id), library);
  const files = changed(
    siteFiles(site, facts.copy.site, ctx.design, ctx.files, signatures, library),
    ctx.files,
  );
  for (const page of site.pages.filter((p) => targets.some((t) => t.route === p.route))) {
    const errors = lintErrors(lintSitePage(site, page, facts, library, signatures));
    if (errors.length)
      notes.push(
        `Проверка страницы ${page.route}: ${errors
          .slice(0, 3)
          .map((e) => e.message_ru)
          .join("; ")}`,
      );
  }
  return {
    files,
    pages: pagePlans(
      site,
      targets.map((t) => t.route),
    ),
    notes,
    spentRub: wallet.spent(),
  };
}
