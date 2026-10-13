// V4-06: one page of a scenario written as code. The page model (page_compose, Kimi K3 at the head) writes the body;
// the answer passes the page checks (pageCodeIssues) and G0 of the system (one fix round with its problems). On the
// home page the first screen gets a second candidate from another family (signature_section with avoidFamilies of the
// first author) and a judge of a third family picks one by the 390 and 1440 screenshots (critic_visual); without a
// browser or a judge the first candidate stays. A page that never passes keeps its previous version.
import type { BriefScenario } from "@wizard/appspec";
import { type CallType, type LlmMessage, modelFamilyOf, type Registry, type RouteInput } from "@wizard/llm";
import type { PatternMeta } from "@wizard/ui-kit/v3/patterns";
import { z } from "zod";
import { type CallBase, callTool, type RouteFn } from "../../../core/loop.js";
import { defineTool, type ToolIssue } from "../../../core/tool.js";
import type { V3BuildContext } from "../contract.js";
import type { CriticInspector, CriticShot, CriticShotRequest } from "../critic/types.js";
import { siteFiles } from "./codegen.js";
import type { SiteFacts } from "./facts.js";
import { lintErrors } from "./lint.js";
import {
  applyPageCode,
  CODE_RULES,
  codeSectionFile,
  designBlock,
  type PageCodeAnswer,
  pageCodeRequest,
  TASTE_RULES,
} from "./page-code.js";
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
  /** The callType of the page call (default page_compose; the pages after home — page_edit, V4-06 speed). */
  callType?: CallType;
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
    const applied = applyPageCode(s.page, answer, s.library);
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

// ------------------------------------------------------------------------------------------------ first screen

export const RIVAL_TOOL = "submit_first_screen";
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
  const rival = tracking(avoiding(base.route, famA ? [famA] : []));
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
  try {
    const r = await callTool({
      ...base,
      route: rival.route,
      callType: PAGE_CALL_TYPES.rival,
      stepName: "first_screen:rival",
      messages: rivalMessages(ctx, s, a.page),
      tool,
    });
    if (r.ok) {
      const page = withHero(a.page, r.value);
      const sources = new Map([...a.sources, [heroFile, r.value.source]]);
      const sys = systemWith(ctx, s, page, new Map([...s.signatures, ...sources]));
      const check = await s.verify(sys.spec, sys.files, [heroFile, page.file]);
      if (check.ok) b = { page, sources };
    }
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
  }
  if (!b) {
    s.notes.push("Второй вариант первого экрана не получился — остался первый.");
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
