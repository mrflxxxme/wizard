// V4-06: one page of a scenario written as code. The page model (page_compose, GLM-5.3 at the head) writes the body;
// the answer passes the page checks (pageCodeIssues) and G0 of the system (one fix round with its problems). On the
// home page the first screen gets a second candidate (signature_section: its own route and prompt, any family — a
// generator needs no other family, the reviewer does; within RIVAL_DEADLINE_MS) and a judge of a family other than both
// authors picks one by the 390 and 1440 screenshots (critic_visual); without a browser or a judge the first candidate
// stays. A page that never passes keeps its previous version.
import type { BriefScenario } from "@wizard/appspec";
import { type CallType, type LlmMessage, modelFamilyOf, type Registry, type RouteInput } from "@wizard/llm";
import type { PatternMeta } from "@wizard/ui-kit/v3/patterns";
import { z } from "zod";
import { type CallBase, callTool, type RouteFn } from "../../../core/loop.js";
import { defineTool, type ToolIssue } from "../../../core/tool.js";
import type { V3BuildContext } from "../contract.js";
import type { CriticInspector, CriticShot, CriticShotRequest } from "../critic/types.js";
import { keepPhotoPlaces, siteFiles } from "./codegen.js";
import type { SiteFacts } from "./facts.js";
import { lintErrors } from "./lint.js";
import { withMotionImports } from "./motion-imports.js";
import {
  applyPageCode,
  CODE_RULES,
  codeSectionFile,
  designBlock,
  HARD_ISSUES,
  HOME_MIN_SECTIONS,
  type PageCodeAnswer,
  pageCodeRequest,
  pageLintIssues,
  scenarioText,
  TASTE_RULES,
} from "./page-code.js";
import {
  type PagePlan,
  type PlanCodeItem,
  pagePlanRequest,
  planAnswer,
  SECTION_CODE_TOOL,
  sectionRequest,
} from "./page-sections.js";
import { type SiteModel, type SitePage, withSitePages } from "./site.js";
import { lintSitePage } from "./skeleton.js";

/** callTypes of the page step (models.yaml#routes): the page author, the second first-screen author, the judge. */
export const PAGE_CALL_TYPES = {
  page: "page_compose",
  rival: "signature_section",
  judge: "critic_visual",
} as const;

export type PageVerify = (
  spec: V3BuildContext["spec"],
  files: ReadonlyMap<string, string>,
  focus: readonly string[],
) => Promise<{ ok: boolean; problems: string[] }>;

export interface PageStepInput {
  site: SiteModel;
  page: SitePage;
  scenario: BriefScenario;
  facts: SiteFacts;
  library: readonly PatternMeta[];
  verify: PageVerify;
  signatures: ReadonlyMap<string, string>;
  notes: string[];
  /** true — stop the scenario (budget, abort); false — go on with the next page. */
  stop: (e: unknown) => boolean;
  registry: Registry;
  /** The browser of the host: screenshots for the judge of the first screen. */
  inspect?: CriticInspector;
  /** Two candidates of the first screen and the judge (the home page). */
  firstScreen: boolean;
  /** V4-21: what the browser check found not shown — the page is written again to show it (V3BuildContext.repair). */
  repair?: readonly string[];
  /** The callType of the page call (default page_compose; page_edit for a caller that edits). */
  callType?: CallType;
  /** V4-06 speed: the page by sections — a plan call, then one call per code section at once (pageSections). */
  sections?: boolean;
}

export interface PageStepResult {
  page: SitePage;
  sources: Map<string, string>;
}

function mergedFiles(
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

/** Files and spec of the system with `page` in place (the sources of every code section of the site). */
function systemWith(
  ctx: V3BuildContext,
  s: Pick<PageStepInput, "site" | "facts" | "library">,
  page: SitePage,
  sources: ReadonlyMap<string, string>,
) {
  const site = { ...s.site, pages: s.site.pages.map((p) => (p.route === page.route ? page : p)) };
  const files = mergedFiles(
    ctx.files,
    siteFiles(site, s.facts.copy.site, ctx.design, ctx.files, sources, s.library),
  );
  return { site, files, spec: withSitePages(ctx.spec, site) };
}

/** A route whose calls skip the given model families (the rival and the judge are never of the author's). */
const avoiding =
  (route: RouteFn, families: readonly string[]): RouteFn =>
  (input) =>
    route(
      families.length ? { ...input, avoidFamilies: [...(input.avoidFamilies ?? []), ...families] } : input,
    );

/** A route that remembers the model of the last answer (the author's family for the rival and the judge). */
function tracking(route: RouteFn): { route: RouteFn; model: () => string | null } {
  let last: string | null = null;
  return {
    route: async (input: RouteInput) => {
      const out = await route(input);
      last = out.model;
      return out;
    },
    model: () => last,
  };
}

/**
 * The page step: the page as code, checked and built (G0) with one fix round; the first screen's rival and judge on
 * the home page. Null — the page stays as it was (a note says why); "stop" — the scenario stops (budget, abort).
 */
export async function pageCode(
  ctx: V3BuildContext,
  base: Omit<CallBase, "callType"> & { maxRepairs?: number },
  s: PageStepInput,
): Promise<PageStepResult | null | "stop"> {
  const req = pageCodeRequest({
    facts: s.facts,
    site: s.site,
    page: s.page,
    scenario: s.scenario,
    design: ctx.design,
    library: s.library,
    signatures: s.signatures,
    ...(s.repair?.length ? { repair: s.repair } : {}),
  });
  const author = tracking(base.route);
  let messages = req.messages;
  for (let round = 0; round < 2; round++) {
    let r: Awaited<ReturnType<typeof callTool<typeof req.tool.input>>>;
    try {
      r = await callTool({
        ...base,
        route: author.route,
        callType: s.callType ?? PAGE_CALL_TYPES.page,
        stepName: `page_code:${s.page.route}`,
        messages,
        tool: req.tool,
      });
    } catch (e) {
      return s.stop(e) ? "stop" : null;
    }
    if (!r.ok) {
      s.notes.push(`Код страницы ${s.page.route} не прошёл проверки — страница осталась прежней.`);
      return null;
    }
    const answer = r.value as PageCodeAnswer;
    const applied = codePage(s.page, answer, s.library);
    const all = new Map([...s.signatures, ...applied.sources]);
    const sys = systemWith(ctx, s, applied.page, all);
    const check = await s.verify(sys.spec, sys.files, [...applied.sources.keys(), applied.page.file]);
    if (check.ok) {
      s.notes.push(
        `Страница ${s.page.route} «${s.page.title}» написана кодом под сценарий «${s.scenario.id}» и прошла проверки.`,
      );
      const result = { page: applied.page, sources: applied.sources };
      return s.firstScreen ? firstScreen(ctx, base, s, result, author.model()) : result;
    }
    messages = [
      ...r.messages,
      {
        role: "user",
        content: `Страница не прошла проверку системы (G0):\n${check.problems.slice(0, 8).join("\n")}\nИсправь код и вызови submit_page_code снова со всей страницей.`,
      },
    ];
  }
  s.notes.push(`Код страницы ${s.page.route} не собрался (G0) — страница осталась прежней.`);
  return null;
}

/** Checks of the assembled page by sections: the first and two rounds of rewriting the failing sections. */
const SECTION_ROUNDS = 3;

/**
 * The section of a G0 error in the page file itself (`<file>:<line>`): the props of the plan do not fit the props type
 * the section's code declares (rehearsal №6, salon: `cta` a string, the hero's type a link). The page file wraps each
 * section's element in `<div id="<id>">` (codegen pageSource), so the nearest such line above names the section.
 */
function pageFileSection(
  pageFile: string,
  pageSource: string | undefined,
  message: string,
): string | undefined {
  if (!pageSource) return undefined;
  const at = new RegExp(`${pageFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`).exec(message);
  if (!at) return undefined;
  const lines = pageSource.split("\n");
  for (let i = Math.min(Number(at[1]), lines.length) - 1; i >= 0; i--) {
    const div = /^\s*<div id="([^"]+)">\s*$/.exec(lines[i] ?? "");
    if (div) return div[1];
    if (/^\s*<\/div>\s*$/.test(lines[i] ?? "")) return undefined;
  }
  return undefined;
}

/** An anchor link of a section: `href="#x"` or `"/#x"` in its code, a string `#x` / `/#x` anywhere in its props. */
const SOURCE_ANCHOR_RE = /href=\{?["'`](\/?#[a-zA-Z][\w-]*)["'`]/g;
const PROPS_ANCHOR_RE = /^\/?#[a-zA-Z][\w-]*$/;

/** Anchors of the page: its section ids, the ids of the answer's sections and the ids their code declares. */
function anchorIds(v: PageCodeAnswer, page: Pick<SitePage, "sections">): Set<string> {
  const code = v.sections.flatMap((s) => (s.kind === "code" ? [s] : []));
  return new Set([
    ...page.sections.map((s) => s.id),
    ...v.sections.map((s) => s.id),
    ...code.flatMap((s) => [...s.source.matchAll(/\bid=\{?["'`]([\w-]+)["'`]/g)].map((m) => m[1] ?? "")),
  ]);
}

/**
 * The anchor of the page's own form: the SDK form section (type form — LeadForm or BookingForm, what GS-landing-1 takes
 * for «the form on this page») the answer keeps. Undefined — the page has no form.
 */
export function formAnchor(
  v: Pick<PageCodeAnswer, "sections">,
  page: Pick<SitePage, "sections">,
): string | undefined {
  const kept = new Set(v.sections.flatMap((s) => (s.kind === "keep" ? [s.id] : [])));
  return page.sections.find((s) => s.type === "form" && kept.has(s.id))?.id;
}

/**
 * Where the main action of the page leads: its own form (`#<id>`), else /booking when the site has it (not on itself),
 * else a request or contacts section of the page. Undefined — nowhere.
 */
function mainActionHref(
  v: PageCodeAnswer,
  page: Pick<SitePage, "route" | "sections">,
  routes: readonly string[],
): string | undefined {
  const form = formAnchor(v, page);
  if (form) return `#${form}`;
  if (page.route !== "/booking" && routes.includes("/booking")) return "/booking";
  const ids = anchorIds(v, page);
  const section = ["form", "request", "contacts"].find((x) => ids.has(x));
  return section && `#${section}`;
}

/**
 * Code links to an anchor the page lacks, sent by code to the main action (mainActionHref): the page's own form first
 * (acceptance 14.10, coffee: sent to /booking past the home's form, GS-landing-1 failed), else /booking, else a request
 * or contacts section (probe «prices»: the hero's last fix round, mending a type error, wrote `#request` — no round was
 * left to hear of it). Returns the sources that changed; with no target nothing changes.
 */
export function retargetAnchors(
  v: PageCodeAnswer,
  page: Pick<SitePage, "route" | "sections">,
  routes: readonly string[],
): Map<string, string> {
  const ids = anchorIds(v, page);
  const out = new Map<string, string>();
  const href = mainActionHref(v, page, routes);
  if (!href) return out;
  for (const s of v.sections) {
    if (s.kind !== "code") continue;
    const next = s.source.replace(SOURCE_ANCHOR_RE, (all, link: string) =>
      (link.startsWith("/") && page.route !== "/") || ids.has(link.slice(link.indexOf("#") + 1))
        ? all
        : all.replace(link, href),
    );
    if (next !== s.source) out.set(s.id, next);
  }
  return out;
}

/**
 * Links of code sections to an anchor the page does not have (rehearsal №6, coffee: «#order» from the first screen,
 * critic P0 S01) — a hard issue at the source section: the visitor's main action must lead somewhere. Anchors are the
 * page's section ids and the ids the sections' code declares; «/#x» counts on the home page only. The message names
 * where the main action leads (mainActionHref: the page's own form first).
 */
export function anchorIssues(
  v: PageCodeAnswer,
  page: Pick<SitePage, "route" | "sections">,
  routes: readonly string[] = [],
): { path: string; code: string; message: string }[] {
  const ids = anchorIds(v, page);
  const out: { path: string; code: string; message: string }[] = [];
  const form = formAnchor(v, page);
  const main = mainActionHref(v, page, routes);
  const hint = form
    ? `ссылка — на существующую секцию, главное действие — на форму этой страницы #${form}`
    : main?.startsWith("#")
      ? `ссылка — на существующую секцию, главное действие — на ${main}`
      : main
        ? `ссылка — на существующую секцию или на ${main}`
        : "ссылка — на существующую секцию";
  v.sections.forEach((s, i) => {
    if (s.kind !== "code") return;
    const links = new Set<string>();
    for (const m of s.source.matchAll(SOURCE_ANCHOR_RE)) links.add(m[1] ?? "");
    const visit = (x: unknown): void => {
      if (typeof x === "string" && PROPS_ANCHOR_RE.test(x)) links.add(x);
      else if (Array.isArray(x)) for (const y of x) visit(y);
      else if (x && typeof x === "object") for (const y of Object.values(x)) visit(y);
    };
    visit(s.props);
    for (const l of links) {
      if (l.startsWith("/") && page.route !== "/") continue;
      const id = l.slice(l.indexOf("#") + 1);
      if (ids.has(id)) continue;
      out.push({
        path: `sections.${i}.source`,
        code: "BROKEN_ANCHOR",
        message: `Якоря #${id} на странице нет: ${hint}`,
      });
    }
  });
  return out;
}

/** The span of the `href` value of the first screen's main action (`data-testid="wz-hero-primary"`, GS-landing-1). */
interface PrimaryHref {
  start: number;
  end: number;
  /** A literal value: `"x"`, `'x'`, `{"x"}`, `` {`x`} ``. */
  literal?: string;
  /** A value read from props: `{action.href}`, `{props.cta?.href}`, `{actions[0].href}`. */
  path?: string[];
}

/** The end of a JSX value or tag from `i`: the first `stop` outside quotes and braces (-1 — none). */
function scanTo(source: string, i: number, stop: string): number {
  let depth = 0;
  let quote = "";
  for (let k = i; k < source.length; k++) {
    const c = source[k] as string;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0 && stop === "}") return k;
    } else if (c === stop && depth === 0) return k;
  }
  return -1;
}

function primaryHref(source: string): PrimaryHref | undefined {
  const at = source.indexOf("wz-hero-primary");
  const open = at < 0 ? -1 : source.lastIndexOf("<", at);
  const close = open < 0 ? -1 : scanTo(source, open, ">");
  if (close < 0) return undefined;
  const tag = source.slice(open, close);
  let depth = 0;
  let quote = "";
  for (let k = 0; k < tag.length; k++) {
    const c = tag[k] as string;
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    if (depth !== 0 || !/\s/.test(c)) continue;
    const m = /^href\s*=\s*/.exec(tag.slice(k + 1));
    if (!m) continue;
    const start = open + k + 1 + m[0].length;
    const first = source[start];
    if (first === '"' || first === "'") {
      const end = source.indexOf(first, start + 1) + 1;
      return end > start ? { start, end, literal: source.slice(start + 1, end - 1) } : undefined;
    }
    if (first !== "{") return undefined;
    const end = scanTo(source, start, "}") + 1;
    if (end <= start) return undefined;
    const expr = source.slice(start + 1, end - 1).trim();
    const lit = /^(["'])([^"'\\]*)\1$/.exec(expr) ?? /^(`)([^`$\\]*)`$/.exec(expr);
    if (lit) return { start, end, literal: lit[2] as string };
    const path = /^(?:props\s*\??\.\s*)?([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\[\d+\])*)$/.exec(
      expr,
    );
    return {
      start,
      end,
      ...(path
        ? { path: (path[1] as string).split(/\??\.|\[|\]/).flatMap((x) => (x.trim() ? [x.trim()] : [])) }
        : {}),
    };
  }
  return undefined;
}

const valueAt = (v: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined),
    v,
  );

function withValueAt(v: unknown, path: readonly string[], value: string): unknown {
  const [k, ...rest] = path;
  if (k === undefined) return value;
  if (Array.isArray(v)) return v.map((x, i) => (i === Number(k) ? withValueAt(x, rest, value) : x));
  const o = v as Record<string, unknown>;
  return { ...o, [k]: withValueAt(o[k], rest, value) };
}

/**
 * GS-landing-1 by code: on a page with its own form the first screen's main action (`data-testid="wz-hero-primary"`)
 * leads to that form — `#<id>`, never /booking, «/#form» or another section (acceptance 14.10, coffee: the hero sent
 * to /booking while the home page held its request form; the goal takes only `#…` to a form of this page). The value is
 * set where the code reads it: the prop of `href={action.href}`, else the literal of the attribute. Runs before every
 * check — a link to another page is no issue the model would hear of. Unchanged — the same object.
 */
export function heroToForm(v: PageCodeAnswer, page: Pick<SitePage, "sections">): PageCodeAnswer {
  const form = formAnchor(v, page);
  if (!form) return v;
  const to = `#${form}`;
  let changed = false;
  const sections = v.sections.map((s) => {
    if (s.kind !== "code" || s.id !== "hero") return s;
    const h = primaryHref(s.source);
    if (!h) return s;
    const read = h.path && valueAt(s.props, h.path);
    if (h.path && typeof read === "string") {
      if (read === to) return s;
      changed = true;
      return { ...s, props: withValueAt(s.props, h.path, to) as Record<string, unknown> };
    }
    if (h.literal === to) return s;
    changed = true;
    return { ...s, source: `${s.source.slice(0, h.start)}${JSON.stringify(to)}${s.source.slice(h.end)}` };
  });
  return changed ? ({ ...v, sections } as PageCodeAnswer) : v;
}

/**
 * Library photo addresses (`/_wizard/photos/…`) the list «Фото» does not have, under any prop of a section and in the
 * code of a code section — a hard issue (UNKNOWN_PHOTO). The page's shape check reads only `src` and `image`, but the
 * models carry a picture as `photo` too (acceptance 14.10, coffee: an invented /_wizard/photos/grain-local.jpg under
 * `photo` passed every check — a broken image on the home page).
 */
export function photoIssues(
  v: { sections: readonly { props?: Record<string, unknown>; source?: string }[] },
  facts: Pick<SiteFacts, "photos">,
): ToolIssue[] {
  const known = new Set(facts.photos.map((p) => p.src));
  const out: ToolIssue[] = [];
  v.sections.forEach((s, i) => {
    const props = new Set(
      [...JSON.stringify(s.props ?? {}).matchAll(/"(\/_wizard\/photos\/[^"]*)"/g)].map((m) => m[1] as string),
    );
    for (const src of props)
      if (!known.has(src))
        out.push({
          path: `sections.${i}.props`,
          code: "UNKNOWN_PHOTO",
          message: `Фото ${src} нет в списке «Фото»`,
        });
    const code = new Set(
      [...(s.source ?? "").matchAll(/\/_wizard\/photos\/[^\s"'`)}\]$]+/g)].map((m) => m[0]),
    );
    for (const src of code)
      if (!known.has(src))
        out.push({
          path: `sections.${i}.source`,
          code: "UNKNOWN_PHOTO",
          message: `Фото ${src} нет в списке «Фото»: фото секции — только из props`,
        });
  });
  return out;
}

/** The plan tool with photoIssues added to its checks (the same message is not repeated). */
function withPhotoCheck(
  tool: ReturnType<typeof pagePlanRequest>["tool"],
  facts: SiteFacts,
): ReturnType<typeof pagePlanRequest>["tool"] {
  return defineTool({
    name: tool.name,
    description: tool.description,
    input: tool.input,
    ...(tool.normalize ? { normalize: tool.normalize } : {}),
    check: (v: PagePlan) => {
      const own = tool.check?.(v) ?? [];
      return [...own, ...photoIssues(v, facts).filter((i) => !own.some((o) => o.message === i.message))];
    },
  });
}

/** What the section hears of a G0 error in the page file: its props type must take the props of the plan as they are. */
const PROPS_TYPE_HINT =
  "Ошибка в файле страницы: props секции из плана не подходят под тип props, который объявляет код секции. Тип props в коде должен принимать ровно ключи и значения props плана (строка остаётся строкой).";

/**
 * Section ids named by problems of the page lint (path sections.<i>…) or of G0 (the section file in the text, or a
 * line of the page file inside the section's wrapper).
 */
function failingSections(
  plan: PagePlan,
  page: SitePage,
  issues: readonly { path?: string; message: string }[],
  pageSource?: string,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: string, m: string) => out.set(id, [...(out.get(id) ?? []), m]);
  for (const i of issues) {
    const at = /^sections\.(\d+)/.exec(i.path ?? "");
    const byPath = at ? plan.sections[Number(at[1])] : undefined;
    if (byPath?.kind === "code") {
      add(byPath.id, i.message);
      continue;
    }
    const byFile = plan.sections.find(
      (s) => s.kind === "code" && i.message.includes(codeSectionFile(page, s.id)),
    );
    if (byFile) {
      add(byFile.id, i.message);
      continue;
    }
    const id = pageFileSection(page.file, pageSource, i.message);
    if (id && plan.sections.some((s) => s.kind === "code" && s.id === id))
      add(id, `${i.message}\n${PROPS_TYPE_HINT}`);
  }
  return out;
}

/**
 * The page step by sections (V4-06 speed): a short plan call (sections, ideas, props, SDK components, SEO), every
 * code section by its own call at once, the page assembled by code; the page lint and G0 send only the failing
 * sections back (up to two rounds). Null — the page stays as it was; "stop" — the scenario stops.
 */
export async function pageSections(
  ctx: V3BuildContext,
  base: Omit<CallBase, "callType"> & { maxRepairs?: number },
  s: PageStepInput,
): Promise<PageStepResult | null | "stop"> {
  const callType = s.callType ?? PAGE_CALL_TYPES.page;
  const planReq = pagePlanRequest({
    facts: s.facts,
    site: s.site,
    page: s.page,
    scenarioText: scenarioText(s.scenario),
    design: ctx.design,
    library: s.library,
  });
  const author = tracking(base.route);
  let plan: PagePlan;
  try {
    const r = await callTool({
      ...base,
      route: author.route,
      callType,
      stepName: `page_plan:${s.page.route}`,
      messages: planReq.messages,
      tool: withPhotoCheck(planReq.tool, s.facts),
    });
    if (!r.ok) {
      s.notes.push(`План страницы ${s.page.route} не прошёл проверки — страница осталась прежней.`);
      return null;
    }
    plan = r.value as PagePlan;
  } catch (e) {
    return s.stop(e) ? "stop" : null;
  }
  const items = plan.sections.filter((x): x is PlanCodeItem => x.kind === "code");
  const sources = new Map<string, string>();
  let stopped: unknown = null;
  const write = async (item: PlanCodeItem, problems?: readonly string[]): Promise<void> => {
    const req = sectionRequest({
      plan,
      item,
      page: s.page,
      design: ctx.design,
      library: s.library,
      archetype: s.site.archetype,
    });
    const messages: LlmMessage[] = problems?.length
      ? [
          ...req.messages,
          ...(sources.has(item.id)
            ? [
                {
                  role: "user" as const,
                  content: `Прошлый вариант секции:\n\`\`\`tsx\n${sources.get(item.id)}\n\`\`\`\nОн не прошёл проверки страницы:\n${problems.slice(0, 6).join("\n")}\nИсправь именно это и вызови ${SECTION_CODE_TOOL} снова.`,
                },
              ]
            : []),
        ]
      : req.messages;
    try {
      const r = await callTool({
        ...base,
        route: author.route,
        callType,
        stepName: `page_section:${s.page.route}#${item.id}${problems ? ":fix" : ""}`,
        messages,
        tool: req.tool,
      });
      if (r.ok) sources.set(item.id, withMotionImports(r.value.source));
    } catch (e) {
      stopped ??= e;
    }
  };
  await Promise.all(items.map((it) => write(it)));
  if (stopped) return s.stop(stopped) ? "stop" : null;
  const check = { site: s.site, page: s.page, facts: s.facts, library: s.library, signatures: s.signatures };
  const routes = s.site.pages.map((p) => p.route);
  /**
   * The page without the sections that still fail (rehearsal №6: six written sections thrown away for one): kept when
   * the hero stays, the home page keeps HOME_MIN_SECTIONS, the hard lint passes and G0 builds it. Null — it does not.
   */
  const partial = async (
    drop: ReadonlySet<string>,
    why: readonly string[],
  ): Promise<PageStepResult | null> => {
    if (!drop.size || drop.has("hero")) return null;
    const kept: PagePlan = {
      ...plan,
      sections: plan.sections.filter((x) => x.kind !== "code" || (!drop.has(x.id) && sources.has(x.id))),
    };
    if (s.page.route === "/" && kept.sections.length < HOME_MIN_SECTIONS) return null;
    const answer = heroToForm(planAnswer(kept, sources), s.page);
    if (pageLintIssues(answer, check).some((i) => HARD_ISSUES.has(i.code ?? ""))) return null;
    if (anchorIssues(answer, s.page, routes).length || photoIssues(answer, s.facts).length) return null;
    const applied = codePage(s.page, answer, s.library);
    const sys = systemWith(ctx, s, applied.page, new Map([...s.signatures, ...applied.sources]));
    const g0 = await s.verify(sys.spec, sys.files, [...applied.sources.keys(), applied.page.file]);
    if (!g0.ok) return null;
    const names = plan.sections
      .filter((x) => x.kind === "code" && drop.has(x.id))
      .map((x) => `«${(x as PlanCodeItem).title}»`);
    s.notes.push(
      `Страница ${s.page.route} «${s.page.title}» собрана без секций ${names.join(", ")}: они не прошли проверки (${why.slice(0, 2).join("; ").slice(0, 300)}).`,
    );
    const model = author.model();
    return { page: model ? { ...applied.page, author: model } : applied.page, sources: applied.sources };
  };
  if (items.some((it) => !sources.has(it.id))) {
    const missing = new Set(items.filter((it) => !sources.has(it.id)).map((it) => it.id));
    const p = await partial(missing, ["секция не написана по форме"]);
    if (p) return p;
    s.notes.push(`Секции страницы ${s.page.route} не прошли проверки — страница осталась прежней.`);
    return null;
  }
  let last: { path?: string; message: string }[] = [];
  let lastSource: string | undefined;
  for (let round = 0; round < SECTION_ROUNDS; round++) {
    // The model mends its own links first; on the last round the code sends what is left to the main action.
    if (round === SECTION_ROUNDS - 1)
      for (const [id, src] of retargetAnchors(planAnswer(plan, sources), s.page, routes))
        sources.set(id, src);
    const answer = heroToForm(planAnswer(plan, sources), s.page);
    // The last round keeps only the hard issues: soft ones never leave the page as it was (G0 still decides).
    const lint = [
      ...pageLintIssues(answer, check).filter(
        (i) => round < SECTION_ROUNDS - 1 || HARD_ISSUES.has(i.code ?? ""),
      ),
      ...anchorIssues(answer, s.page, routes),
      ...photoIssues(answer, s.facts),
    ];
    let problems = lint.map((i) => ({ path: i.path, message: i.message }));
    lastSource = undefined;
    let applied = codePage(s.page, answer, s.library);
    if (!problems.length) {
      const sys = systemWith(ctx, s, applied.page, new Map([...s.signatures, ...applied.sources]));
      const g0 = await s.verify(sys.spec, sys.files, [...applied.sources.keys(), applied.page.file]);
      if (g0.ok) {
        s.notes.push(
          `Страница ${s.page.route} «${s.page.title}» написана по секциям под сценарий «${s.scenario.id}» и прошла проверки.`,
        );
        const model = author.model();
        const result = {
          page: model ? { ...applied.page, author: model } : applied.page,
          sources: applied.sources,
        };
        return s.firstScreen ? firstScreen(ctx, base, s, result, model) : result;
      }
      problems = g0.problems.map((m) => ({ path: "", message: m }));
      lastSource = sys.files.get(applied.page.file);
    }
    last = problems;
    if (round === SECTION_ROUNDS - 1) break;
    const failing = failingSections(plan, s.page, problems, lastSource);
    if (!failing.size) break;
    await Promise.all(items.filter((it) => failing.has(it.id)).map((it) => write(it, failing.get(it.id))));
    if (stopped) return s.stop(stopped) ? "stop" : null;
    applied = codePage(s.page, planAnswer(plan, sources), s.library);
  }
  const failing = failingSections(plan, s.page, last, lastSource);
  const p = await partial(
    new Set(failing.keys()),
    last.map((x) => x.message),
  );
  if (p) return p;
  const why = last
    .slice(0, 2)
    .map((x) => x.message)
    .join("; ")
    .slice(0, 300);
  s.notes.push(
    `Код страницы ${s.page.route} не прошёл проверки${why ? ` (${why})` : ""} — страница осталась прежней.`,
  );
  return null;
}

/**
 * The page with the model's code (applyPageCode): the first screen's action to the page's form (heroToForm), code
 * sections keep the places of the owner's photos (V4-16).
 */
function codePage(
  page: SitePage,
  answer: Parameters<typeof applyPageCode>[1],
  library: readonly PatternMeta[],
): ReturnType<typeof applyPageCode> {
  const code = applyPageCode(page, heroToForm(answer, page), library);
  return { ...code, page: keepPhotoPlaces(page, code.page) };
}

// ------------------------------------------------------------------------------------------------ first screen

export const RIVAL_TOOL = "submit_first_screen";
/** The rival first screen's deadline: past it the author's first screen stays without the judge (the build's time). */
export const RIVAL_DEADLINE_MS = 60_000;
export const JUDGE_TOOL = "submit_first_screen_choice";

/** The rival first screen: TSX of the hero and its props. */
export const rivalSchema = z.strictObject({
  title: z.string().min(3).max(80),
  source: z.string().min(200).max(14000),
  props: z.record(z.string(), z.unknown()),
});
export type RivalAnswer = z.output<typeof rivalSchema>;

export const judgeSchema = z.strictObject({
  pick: z.enum(["A", "B"]),
  why: z.string().min(10).max(400),
});

const withHero = (page: SitePage, v: RivalAnswer): SitePage => ({
  ...page,
  sections: page.sections.map((x) =>
    x.id === "hero" && x.type === "signature" ? { ...x, props: v.props, title: v.title } : x,
  ),
});

/** The rival first screen with its main action to the page's form (heroToForm over the page as written). */
function rivalToForm(page: SitePage, v: RivalAnswer): RivalAnswer {
  const answer = {
    seo: page.seo,
    sections: [
      { kind: "code", id: "hero", title: v.title, source: v.source, props: v.props },
      ...page.sections.filter((x) => x.type === "form").map((x) => ({ kind: "keep", id: x.id })),
    ],
  } as PageCodeAnswer;
  const hero = heroToForm(answer, page).sections[0];
  return hero?.kind === "code" ? { ...v, source: hero.source, props: hero.props } : v;
}

/** The rival's prompt: the same facts and design, another author; the rest of the page as context. */
export function rivalMessages(
  ctx: V3BuildContext,
  s: Pick<PageStepInput, "facts" | "site" | "page">,
  page: SitePage,
): LlmMessage[] {
  const f = s.facts;
  return [
    {
      role: "system",
      content: [
        "Ты — фронтенд-дизайнер Born to Build. Пишешь первый экран (hero) сайта клиента кодом — свой вариант, непохожий на типовой: React 19 + Tailwind v4 на токенах + Motion.",
        "## Вкус",
        TASTE_RULES.map((r) => `- ${r}`).join("\n"),
        "## Правила кода",
        CODE_RULES.map((r) => `- ${r}`).join("\n"),
        "Тексты — по фактам, заголовок — оффер до 90 знаков, один h1, кнопка ведёт к основному действию сайта.",
        `Отвечай только вызовом ${RIVAL_TOOL}.`,
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `## Факты\nБизнес: ${f.copy.home}.${f.description ? `\nОписание: ${f.description}` : ""}\nЦели: ${f.goals.join("; ")}${f.photos.length ? `\nФото:\n${f.photos.map((p) => `- ${p.src} — ${p.alt}`).join("\n")}` : ""}`,
        `## Дизайн-система\n${designBlock(ctx.design)}`,
        `## Страница\nПосле первого экрана: ${page.sections
          .filter((x) => x.id !== "hero" && x.type !== "header" && x.type !== "footer")
          .map((x) => x.id)
          .join(", ")}. Якоря: ${page.sections.map((x) => `#${x.id}`).join(" ")}.`,
        `## Задача\nНапиши первый экран и вызови ${RIVAL_TOOL}.`,
      ].join("\n\n"),
    },
  ];
}

const SHOTS: CriticShotRequest[] = [
  { route: "/", width: 390, kind: "screen", maxWidth: 390, maxHeight: 844 },
  { route: "/", width: 1440, kind: "screen", maxWidth: 720, maxHeight: 450 },
];

/** The judge's prompt: two first screens, each at 390 and 1440, the brief in one line. */
export function judgeMessages(facts: SiteFacts, a: CriticShot[], b: CriticShot[]): LlmMessage[] {
  const att = (x: CriticShot[]) => x.map((sh) => ({ mime: sh.mime, data: sh.data }));
  return [
    {
      role: "system",
      content: [
        "Ты — арт-директор и судья. Выбираешь лучший первый экран сайта из двух вариантов по снимкам 390 и 1440 px.",
        "Критерии: ясный оффер по фактам за 3 секунды; одна сильная идея композиции, не шаблон; иерархия и ритм; читаемость и контраст; кнопка основного действия на виду; без заглушек и визуального мусора; «интересно, но никогда не уродливо».",
        `Отвечай только вызовом ${JUDGE_TOOL}: pick — A или B, why — одно-два предложения по-русски.`,
      ].join("\n\n"),
    },
    {
      role: "user",
      content: `Бизнес: ${facts.copy.home}. Вариант A — снимки 390 и 1440.`,
      attachments: att(a),
    },
    {
      role: "user",
      content: "Вариант B — снимки 390 и 1440. Какой первый экран лучше?",
      attachments: att(b),
    },
  ];
}

async function firstScreen(
  ctx: V3BuildContext,
  base: Omit<CallBase, "callType"> & { maxRepairs?: number },
  s: PageStepInput,
  a: PageStepResult,
  authorModel: string | null,
): Promise<PageStepResult> {
  const heroFile = codeSectionFile(a.page, "hero");
  const famA = authorModel ? modelFamilyOf(s.registry, authorModel) : null;
  const rival = tracking(base.route);
  const lintRival = (v: RivalAnswer): ToolIssue[] => {
    const page = withHero(a.page, v);
    const site = { ...s.site, pages: s.site.pages.map((p) => (p.route === page.route ? page : p)) };
    const all = new Map([...s.signatures, ...a.sources, [heroFile, v.source]]);
    return lintErrors(lintSitePage(site, page, s.facts, s.library, all))
      .filter((i) => !i.section || i.section === "hero")
      .map((i) => ({
        path: i.code === "untraced-number" || i.code === "weak-alt" ? "props" : "source",
        code: i.code.toUpperCase().replace(/-/g, "_"),
        message: `${i.message_ru}${i.evidence ? `: ${i.evidence}` : ""}`,
      }));
  };
  const tool = defineTool({
    name: RIVAL_TOOL,
    description: "The rival first screen: TSX of the hero and its props.",
    input: rivalSchema,
    check: lintRival,
  });
  let b: PageStepResult | null = null;
  // The pair waits for its slower author: a rival that has not answered by the deadline is dropped (the first stays).
  const late = new AbortController();
  const timer = setTimeout(() => late.abort(), RIVAL_DEADLINE_MS);
  const outer = [base.signal, ctx.signal].filter((x): x is AbortSignal => x !== undefined);
  try {
    const r = await callTool({
      ...base,
      route: rival.route,
      callType: PAGE_CALL_TYPES.rival,
      stepName: "first_screen:rival",
      messages: rivalMessages(ctx, s, a.page),
      tool,
      signal: AbortSignal.any([late.signal, ...outer]),
    });
    if (r.ok) {
      const v = rivalToForm(a.page, r.value);
      const page = withHero(a.page, v);
      const sources = new Map([...a.sources, [heroFile, v.source]]);
      const sys = systemWith(ctx, s, page, new Map([...s.signatures, ...sources]));
      const check = await s.verify(sys.spec, sys.files, [heroFile, page.file]);
      if (check.ok) b = { page, sources };
    }
  } catch (e) {
    if (ctx.signal?.aborted || base.signal?.aborted) throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!b) {
    s.notes.push(
      late.signal.aborted
        ? `Второй вариант первого экрана не успел за ${RIVAL_DEADLINE_MS / 1000} с — остался первый.`
        : "Второй вариант первого экрана не получился — остался первый.",
    );
    return a;
  }
  const famB = rival.model() ? modelFamilyOf(s.registry, rival.model() as string) : null;
  if (!s.inspect) {
    s.notes.push("Первый экран: два варианта, судье нечем снять экраны — остался первый.");
    return a;
  }
  try {
    const shoot = async (x: PageStepResult) => {
      const sys = systemWith(ctx, s, x.page, new Map([...s.signatures, ...x.sources]));
      const ins = await (s.inspect as CriticInspector)({
        spec: sys.spec,
        files: sys.files,
        routes: ["/"],
        viewports: [
          { width: 390, height: 844, scheme: "light" },
          { width: 1440, height: 900, scheme: "light" },
        ],
        shots: SHOTS,
        fonts: [ctx.design.fonts.display.family, ctx.design.fonts.text.family],
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return ins.ok ? ins.shots : null;
    };
    const [shotsA, shotsB] = [await shoot(a), await shoot(b)];
    if (!shotsA?.length || !shotsB?.length) {
      s.notes.push("Первый экран: снимки не получились — остался первый вариант.");
      return a;
    }
    const judge = defineTool({
      name: JUDGE_TOOL,
      description: "Pick the better first screen.",
      input: judgeSchema,
    });
    const avoid = [famA, famB].filter((x): x is string => !!x);
    const r = await callTool({
      ...base,
      route: avoiding(base.route, avoid),
      callType: PAGE_CALL_TYPES.judge,
      stepName: "first_screen:judge",
      messages: judgeMessages(s.facts, shotsA, shotsB),
      tool: judge,
    });
    if (!r.ok) {
      s.notes.push("Судья первого экрана не ответил по форме — остался первый вариант.");
      return a;
    }
    s.notes.push(`Первый экран: судья выбрал вариант ${r.value.pick} — ${r.value.why}`);
    return r.value.pick === "B" ? b : a;
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    s.notes.push("Судья первого экрана недоступен — остался первый вариант.");
    return a;
  }
}
