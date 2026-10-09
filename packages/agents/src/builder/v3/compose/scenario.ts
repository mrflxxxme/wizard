// A scenario of the brief brought to its page(s) (V3-12; builder-v3.md C6 stage «scenarios»): the model page_compose
// writes the composition and texts of the page as tool-shaped JSON (variants of the library, props validated by their
// slot schemas, copy by the anti-slop linter); signature_section writes ≤ 2 signature sections per site as free TSX
// under the pattern rules, checked by lintPattern, the page linter and G0 (imports, forbidden API, types, build) before
// it is accepted — a section that fails gets a library pattern in its place. Every call fits ctx.budgetRub first.
import type { AppSpec, BriefScenario } from "@wizard/appspec";
import { runG0 } from "@wizard/gates";
import {
  type CallType,
  createRegistry,
  type LlmMessage,
  type OrgPolicy,
  type Registry,
  type RouteContext,
  type RouteInput,
} from "@wizard/llm";
import type { DesignSystemV3 } from "@wizard/ui-kit/v3/design";
import {
  PATTERN_IMPORTS,
  PATTERN_THEME,
  PATTERNS,
  type PatternMeta,
  patternById,
  type SectionType,
} from "@wizard/ui-kit/v3/patterns";
import { z } from "zod";
import type { RunStepFn } from "../../../core/events.js";
import { type CallBase, callTool, type RouteFn } from "../../../core/loop.js";
import { defineTool, type ToolIssue, toJsonSchema } from "../../../core/tool.js";
import { upperBoundCredits } from "../../budget.js";
import { milliToRub } from "../../v2/wallet.js";
import type { V3BuildContext, V3ComposeResult } from "../contract.js";
import { siteFiles } from "./codegen.js";
import { actionLink, heroPhoto, siteRules } from "./content.js";
import { type SiteFacts, siteFacts } from "./facts.js";
import { copyIssues, lintErrors, type PageLintIssue, propsIssues } from "./lint.js";
import {
  MAX_SIGNATURES,
  pagePlans,
  readSite,
  SECTIONS_DIR,
  type SiteModel,
  type SitePage,
  type SiteSection,
  withSitePages,
} from "./site.js";
import { type ComposeLibrary, choosePattern, composeSite, lintSitePage } from "./skeleton.js";

/** callTypes of the composer (models.yaml#routes; data-boundary.yaml: T1 only scrubbed, no records of the system). */
export const COMPOSE_CALL_TYPES = {
  page: "page_compose",
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

// ------------------------------------------------------------------------------------------------ page_compose

const COPY_RULES = [
  "Пиши как владелец, который объясняет соседу: коротко, конкретно, на «вы» со строчной.",
  "Факты, числа, цены, сроки, имена, отзывы — только из раздела «Факты». Нет факта — не пиши его (D49). Никаких «более 1000 клиентов», «лучший», «№ 1», «гарантируем».",
  "Без слов-пустышек («уникальный», «индивидуальный подход», «команда профессионалов», «в кратчайшие сроки»), без эмодзи и восклицательных знаков.",
  "Кнопка — глагол и объект («Записаться на пробное»), не «Подробнее» и не «Отправить».",
  "Заголовок первого экрана — оффер с фактом из брифа, до 90 знаков; не больше 4 текстовых элементов в первом экране.",
  "Ссылки — только на страницы и якоря из списка «Сайт», tel: и mailto: из фактов. Фото — только из списка «Фото», с осмысленным alt.",
];

const PAGE_RULES = [
  "Для каждой секции выбери вариант (pattern) из её списка и заполни props по его схеме. Соседние секции — разных раскладок.",
  "Секции с привязкой к данным (entity) оставь: их логика — модуль системы; меняй только тексты вокруг.",
  "Порядок секций можно поменять, первый экран (hero) остаётся первым. Лишнюю секцию можно убрать, если ей нечего честно сказать.",
  "seo.title — до 70 знаков, seo.description — 50–160 знаков, по фактам страницы.",
  "Отвечай только вызовом submit_page. Если инструмент вернул ошибки — исправь именно их и вызови снова.",
];

const SIGNATURE_OFFER =
  "signature — по желанию: одна фирменная секция этой страницы (кульминация: то, что отличает бизнес по фактам брифа), которую потом напишут кодом; after — id секции, после которой она встанет; title и idea — по-русски.";

/** An editable section of the page and the variants it may take. */
interface Editable {
  section: SiteSection;
  options: PatternMeta[];
  /** Props the model may not change (the hook binding). */
  fixed: Record<string, unknown>;
}

/** Binding slots of the patterns with needs (V3-08): the model writes the texts around them, not these. */
const FIXED_KEYS = ["entity", "booking", "categoryEntity", "fields", "itemAction"] as const;

/** Slot names of a variant (its zod object schema); null — not an object schema. */
const slotKeys = (p: PatternMeta): string[] | null => {
  const shape = (p.slots as unknown as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : null;
};

/** A variant keeps the binding of a section: it has a slot for every binding key (an item action stays an action). */
const keepsBinding = (p: PatternMeta, fixed: Record<string, unknown>): boolean => {
  const keys = slotKeys(p);
  return keys === null || Object.keys(fixed).every((k) => keys.includes(k));
};

function editable(page: SitePage, library: readonly PatternMeta[]): Editable[] {
  return page.sections
    .filter((s) => s.type !== "header" && s.type !== "footer" && s.type !== "signature")
    .map((s) => {
      const meta = library.find((p) => p.id === s.pattern);
      const needs = meta?.needs ?? null;
      const fixed: Record<string, unknown> = {};
      for (const k of FIXED_KEYS) if (s.props[k] !== undefined) fixed[k] = s.props[k];
      return {
        section: s,
        options: library.filter(
          (p) => p.sectionType === s.type && p.needs === needs && keepsBinding(p, fixed),
        ),
        fixed,
      };
    });
}

/** submit_page: the sections (variant and props), the page SEO and an optional signature idea. */
export function pageComposeSchema(
  ids: readonly string[],
  patterns: readonly string[],
  withSignature: boolean,
) {
  const id = z.enum(ids as [string, ...string[]]);
  const base = z.strictObject({
    sections: z
      .array(
        z.strictObject({
          id,
          pattern: z.enum(patterns as [string, ...string[]]),
          props: z.record(z.string(), z.unknown()),
        }),
      )
      .min(1)
      .max(ids.length),
    seo: z.strictObject({ title: z.string().min(10).max(70), description: z.string().min(50).max(160) }),
  });
  return withSignature
    ? base.extend({
        signature: z
          .strictObject({ after: id, title: z.string().min(3).max(80), idea: z.string().min(20).max(400) })
          .optional(),
      })
    : base;
}
export type PageComposeAnswer = {
  sections: { id: string; pattern: string; props: Record<string, unknown> }[];
  seo: { title: string; description: string };
  signature?: { after: string; title: string; idea: string };
};

function factsBlock(f: SiteFacts, site: SiteModel): string {
  const texts = [...f.texts.entries()].map(([type, c]) => `- ${type}: ${JSON.stringify(c)}`);
  return [
    `Бизнес: ${f.copy.home}.`,
    f.description ? `Описание: ${f.description}` : "",
    f.audience ? `Аудитория: ${f.audience}` : "",
    `Цели: ${f.goals.join("; ") || "не указаны"}`,
    texts.length
      ? `Тексты владельца из плана:\n${texts.join("\n")}`
      : "Текстов владельца нет: пиши только то, что следует из целей и сценария.",
    f.photos.length
      ? `Фото:\n${f.photos.map((p) => `- ${p.src} — ${p.alt}`).join("\n")}`
      : "Фото: нет — выбирай варианты без фото.",
    `Сайт: ${site.pages.map((p) => `${p.route} «${p.title}» (якоря: ${p.sections.map((s) => `#${s.id}`).join(" ")})`).join("; ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function scenarioText(s: BriefScenario): string {
  return `Когда ${s.when.replace(/^когда\s+/i, "")}, система: ${s.then.join("; ")}.`;
}

/** The prompt of page_compose: rules, facts, the scenario, the page sections with their variants and schemas. */
export function pageComposeMessages(
  facts: SiteFacts,
  site: SiteModel,
  page: SitePage,
  scenario: BriefScenario,
  library: readonly PatternMeta[] = PATTERNS,
  withSignature = false,
): LlmMessage[] {
  const blocks = editable(page, library).map((e) => {
    const variants = e.options.map(
      (p) =>
        `  - ${p.id} (раскладка ${p.layout}): ${p.title}\n    схема props: ${JSON.stringify(toJsonSchema(p.slots))}`,
    );
    return [
      `### ${e.section.id} (${e.section.type})`,
      `Сейчас: ${e.section.pattern}, props: ${JSON.stringify(e.section.props)}`,
      Object.keys(e.fixed).length ? `Привязка к данным (не менять): ${JSON.stringify(e.fixed)}` : "",
      "Варианты:",
      ...variants,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [
    {
      role: "system",
      content: [
        "Ты — редактор и композитор страниц сайта клиента Born to Build. Раскладку секций дают варианты библиотеки; ты выбираешь варианты и пишешь тексты по фактам.",
        "## Правила текста",
        COPY_RULES.map((r) => `- ${r}`).join("\n"),
        "## Правила страницы",
        [...PAGE_RULES, ...(withSignature ? [SIGNATURE_OFFER] : [])].map((r) => `- ${r}`).join("\n"),
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `## Факты\n${factsBlock(facts, site)}`,
        `## Сценарий\n${scenarioText(scenario)}`,
        `## Страница ${page.route} «${page.title}»\n${blocks.join("\n\n")}`,
        "## Задача\nСобери страницу под сценарий и вызови submit_page.",
      ].join("\n\n"),
    },
  ];
}

/** The page with the answer applied (header, footer and signature sections kept in place). */
function applyAnswer(page: SitePage, edit: Editable[], v: PageComposeAnswer): SitePage {
  const byId = new Map(edit.map((e) => [e.section.id, e]));
  const body: SiteSection[] = v.sections.map((s) => {
    const e = byId.get(s.id) as Editable;
    const meta = e.options.find((p) => p.id === s.pattern) ?? patternById(s.pattern);
    const props = { ...s.props, ...e.fixed };
    const parsed = meta?.slots.safeParse(props);
    return {
      id: s.id,
      type: e.section.type,
      pattern: s.pattern,
      props: (parsed?.success ? parsed.data : props) as Record<string, unknown>,
      // The places of the owner's photos stay with the section (V3-18); the page shows those its variant can.
      ...(e.section.photos ? { photos: e.section.photos } : {}),
    };
  });
  // Signature sections of earlier scenarios are not the model's to change: they stay after the same neighbour.
  page.sections.forEach((s, i) => {
    if (s.type !== "signature") return;
    const prev = page.sections[i - 1];
    const at = prev?.type === "header" ? 0 : body.findIndex((x) => x.id === prev?.id) + 1 || body.length;
    body.splice(at, 0, s);
  });
  const header = page.sections.filter((s) => s.type === "header");
  const footer = page.sections.filter((s) => s.type === "footer");
  const hero = body.find((s) => s.type === "hero");
  const image = heroPhoto(hero?.props);
  return {
    ...page,
    sections: [...header, ...body, ...footer],
    seo: { title: v.seo.title, description: v.seo.description, ...(image ? { image } : {}) },
  };
}

function issuesOfLint(lint: readonly PageLintIssue[], page: SitePage, prefix = "sections"): ToolIssue[] {
  const body = page.sections.filter((s) => s.type !== "header" && s.type !== "footer");
  return lintErrors(lint).map((i) => {
    const at = i.section ? body.findIndex((s) => s.id === i.section) : -1;
    return {
      path: at >= 0 ? `${prefix}.${at}` : "",
      code: i.code.toUpperCase().replace(/-/g, "_"),
      message: `${i.message_ru}${i.evidence ? `: ${i.evidence}` : ""}`,
    };
  });
}

/** Semantic checks of submit_page: variants of the section's type, props by the slot schema, copy and page rules. */
function pageIssues(
  v: PageComposeAnswer,
  ctx: {
    site: SiteModel;
    page: SitePage;
    edit: Editable[];
    facts: SiteFacts;
    library: readonly PatternMeta[];
    /** Sources of the signature sections already on the site. */
    signatures: ReadonlyMap<string, string>;
  },
): ToolIssue[] {
  const out: ToolIssue[] = [];
  const byId = new Map(ctx.edit.map((e) => [e.section.id, e]));
  const seen = new Set<string>();
  v.sections.forEach((s, i) => {
    const e = byId.get(s.id);
    if (!e) return;
    if (seen.has(s.id))
      out.push({ path: `sections.${i}.id`, code: "DUPLICATE", message: `Секция ${s.id} повторяется` });
    seen.add(s.id);
    const meta = e.options.find((p) => p.id === s.pattern);
    if (!meta) {
      out.push({
        path: `sections.${i}.pattern`,
        code: "WRONG_VARIANT",
        message: `Для секции ${s.id} допустимы: ${e.options.map((p) => p.id).join(", ")}`,
      });
      return;
    }
    const parsed = meta.slots.safeParse({ ...s.props, ...e.fixed });
    if (!parsed.success)
      for (const zi of parsed.error.issues)
        out.push({ path: `sections.${i}.props.${zi.path.join(".")}`, code: "PROPS", message: zi.message });
    const photos = new Set(ctx.facts.photos.map((p) => p.src));
    for (const src of JSON.stringify(s.props).matchAll(/"src":"([^"]*)"/g))
      if (!photos.has(src[1] as string))
        out.push({
          path: `sections.${i}.props`,
          code: "UNKNOWN_PHOTO",
          message: `Фото ${src[1]} нет в списке «Фото»`,
        });
    for (const c of propsIssues(s.props, ctx.facts.numbers))
      if (c.severity === "error")
        out.push({
          path: `sections.${i}.props`,
          code: c.code.toUpperCase().replace(/-/g, "_"),
          message: `${c.message_ru}${c.evidence ? `: ${c.evidence}` : ""}`,
        });
  });
  for (const e of ctx.edit)
    if ((Object.keys(e.fixed).length || e.section.type === "hero") && !seen.has(e.section.id))
      out.push({ path: "sections", code: "REQUIRED", message: `Секцию ${e.section.id} убирать нельзя` });
  if (v.sections[0] && seen.has("hero") && v.sections[0].id !== "hero")
    out.push({ path: "sections.0", code: "HERO_FIRST", message: "Первый экран (hero) — первая секция" });
  for (const [k, text] of [
    ["seo.title", v.seo.title],
    ["seo.description", v.seo.description],
  ] as const)
    for (const i of copyIssues(text, ctx.facts.numbers).filter((c) => c.severity === "error"))
      out.push({ path: k, code: i.code.toUpperCase().replace(/-/g, "_"), message: i.evidence });
  if (out.length) return out;
  const next = applyAnswer(ctx.page, ctx.edit, v);
  const site = { ...ctx.site, pages: ctx.site.pages.map((p) => (p.route === next.route ? next : p)) };
  return issuesOfLint(lintSitePage(site, next, ctx.facts, ctx.library, ctx.signatures), next);
}

// ------------------------------------------------------------------------------------------------ signature

/** submit_section: a signature section as free TSX and the props it gets. */
export const signatureSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{2,30}$/, "имя файла: латиница, цифры, дефис"),
  title: z.string().min(3).max(80),
  source: z.string().min(200).max(12000),
  props: z.record(z.string(), z.unknown()),
});
export type SignatureAnswer = z.output<typeof signatureSchema>;

const SIGNATURE_RULES = [
  `Импорты — только ${PATTERN_IMPORTS.join(", ")}; без import(), require, eval, fetch, dangerouslySetInnerHTML. Один компонент: export default function.`,
  `Цвета и шрифты — только классы темы Tailwind: цвета ${PATTERN_THEME.color.join(", ")} (bg-*, text-*, border-*); шрифты font-display, font-sans; кегли text-${PATTERN_THEME.text.join("/text-")}; радиусы rounded-${PATTERN_THEME.radius.join("/rounded-")}; отступы py-section, px-gutter; ширина max-w-page, max-w-text.`,
  "Запрещено: произвольные значения цвета и шрифта (text-[#…], font-[…], bg-[…]), палитра Tailwind по умолчанию (blue-500, gray-100…), #hex и rgb() в коде, style с цветом или шрифтом, градиентный текст, фиолетовые градиенты, пульсация, бегущая строка.",
  "Раскладка — от 390 до 1440 px без горизонтальной прокрутки: сетка grid/flex, min-w-0, перенос длинных слов (wrap-break-word); не три одинаковые карточки в ряд.",
  "Доступность: заголовки секции — h2 (и h3 внутри), h1 нет; у img осмысленный alt; у button — type и текст; у ссылок — href и класс цвета темы (text-foreground, text-primary…); цели нажатия ≥ 44 px (min-h-11).",
  "Движение (motion/react) — только элементы m.* внутри <LazyMotion features={domAnimation}> (полный motion.* раздувает бандл), с useReducedMotion и только если профиль движения не still; контент виден без анимации.",
  "Все тексты — из props (факты брифа), в коде текстов и чисел нет. Секция получает props ровно в том виде, что ты вернёшь.",
];

/** The prompt of signature_section: the rules of patterns, a library pattern as the style reference, the idea. */
export function signatureMessages(
  facts: SiteFacts,
  site: SiteModel,
  page: SitePage,
  idea: { after: string; title: string; idea: string },
  design: { name: string; motion: string; voice: string },
): LlmMessage[] {
  const reference = patternById("cta-band") ?? PATTERNS.find((p) => p.sectionType === "cta");
  return [
    {
      role: "system",
      content: [
        "Ты — фронтенд-дизайнер Born to Build. Пишешь одну фирменную секцию сайта клиента кодом: React + Tailwind v4 на токенах дизайн-системы клиента.",
        "## Правила кода",
        SIGNATURE_RULES.map((r) => `- ${r}`).join("\n"),
        "## Правила текста",
        COPY_RULES.map((r) => `- ${r}`).join("\n"),
        reference
          ? `## Образец оформления (паттерн библиотеки ${reference.id})\n\`\`\`tsx\n${reference.source}\`\`\``
          : "",
        "Отвечай только вызовом submit_section. Если инструмент вернул ошибки — исправь именно их и вызови снова.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    {
      role: "user",
      content: [
        `## Факты\n${factsBlock(facts, site)}`,
        `## Стиль\nНаправление «${design.name}», тон ${design.voice}, движение ${design.motion}.`,
        `## Страница ${page.route}\nСекции: ${page.sections.map((s) => `${s.id} (${s.pattern})`).join(", ")}. Новая секция встанет после «${idea.after}».`,
        `## Фирменная секция\n«${idea.title}»: ${idea.idea}`,
        "## Задача\nНапиши секцию и вызови submit_section.",
      ].join("\n\n"),
    },
  ];
}

const sectionFile = (name: string) => `${SECTIONS_DIR}/${name}.tsx`;

function withSignature(page: SitePage, after: string, s: SiteSection): SitePage {
  const sections = page.sections.filter((x) => x.id !== s.id);
  const at = sections.findIndex((x) => x.id === after);
  sections.splice(at >= 0 ? at + 1 : Math.max(sections.length - 1, 0), 0, s);
  return { ...page, sections };
}

function signatureIssues(
  v: SignatureAnswer,
  ctx: { site: SiteModel; page: SitePage; after: string; facts: SiteFacts; library: readonly PatternMeta[] },
): ToolIssue[] {
  const file = sectionFile(v.name);
  const taken = ctx.site.pages.some((p) => p.sections.some((x) => x.id === v.name || x.file === file));
  if (taken)
    return [
      { path: "name", code: "NAME_TAKEN", message: `Имя ${v.name} уже занято секцией сайта — выбери другое` },
    ];
  const section: SiteSection = {
    id: v.name,
    type: "signature",
    pattern: "signature",
    props: v.props,
    file,
    title: v.title,
  };
  const page = withSignature(ctx.page, ctx.after, section);
  const lint = lintSitePage(ctx.site, page, ctx.facts, ctx.library, new Map([[file, v.source]]));
  return lintErrors(lint).map((i) => ({
    path:
      i.section === v.name
        ? i.code === "untraced-number" || i.code === "weak-alt"
          ? "props"
          : "source"
        : "",
    code: i.code.toUpperCase().replace(/-/g, "_"),
    message: `${i.message_ru}${i.evidence ? `: ${i.evidence}` : ""}`,
  }));
}

// ------------------------------------------------------------------------------------------------ requests

/** A page may get a signature section: the site has fewer than MAX_SIGNATURES and the page none yet. */
export function signatureOffer(site: SiteModel, page: SitePage): boolean {
  const used = site.pages.flatMap((p) => p.sections.filter((s) => s.type === "signature")).length;
  return used < MAX_SIGNATURES && !page.sections.some((s) => s.type === "signature");
}

/** The page_compose request of a page: its editable sections, the submit_page tool with its checks, the prompt. */
export function pageComposeRequest(o: {
  facts: SiteFacts;
  site: SiteModel;
  page: SitePage;
  scenario: BriefScenario;
  library?: readonly PatternMeta[];
  offer: boolean;
  /** Sources of the signature sections already on the site (their code is linted with the page). */
  signatures?: ReadonlyMap<string, string>;
}) {
  const library = o.library ?? PATTERNS;
  const signatures = o.signatures ?? new Map<string, string>();
  const edit = editable(o.page, library);
  const tool = defineTool({
    name: "submit_page",
    description: "Page composition: variant and props per section, SEO, optional signature idea.",
    input: pageComposeSchema(
      edit.map((e) => e.section.id),
      [...new Set(edit.flatMap((e) => e.options.map((p) => p.id)))],
      o.offer,
    ),
    check: (v) =>
      pageIssues(v as PageComposeAnswer, {
        site: o.site,
        page: o.page,
        edit,
        facts: o.facts,
        library,
        signatures,
      }),
  });
  return { edit, tool, messages: pageComposeMessages(o.facts, o.site, o.page, o.scenario, library, o.offer) };
}

/** The signature_section request: the submit_section tool with the lint checks and the prompt. */
export function signatureRequest(o: {
  facts: SiteFacts;
  site: SiteModel;
  page: SitePage;
  idea: { after: string; title: string; idea: string };
  design: Pick<DesignSystemV3, "name" | "voice" | "motion">;
  library?: readonly PatternMeta[];
}) {
  const library = o.library ?? PATTERNS;
  const tool = defineTool({
    name: "submit_section",
    description: "Signature section: file name, Russian title, TSX source, props.",
    input: signatureSchema,
    check: (v) =>
      signatureIssues(v, { site: o.site, page: o.page, after: o.idea.after, facts: o.facts, library }),
  });
  const messages = signatureMessages(o.facts, o.site, o.page, o.idea, {
    name: o.design.name,
    motion: o.design.motion.profile,
    voice: o.design.voice,
  });
  return { tool, messages };
}

// ------------------------------------------------------------------------------------------------ the step

/** Pages a scenario touches: those of its module (moduleHint, or the module of a bound section), else the home page. */
function scenarioPages(site: SiteModel, s: BriefScenario, ctx: V3BuildContext): SitePage[] {
  const modules = new Set<string>(s.moduleHint ? [s.moduleHint] : []);
  const entityModule = new Map(ctx.publicFront.actions.map((a) => [a.entity, a.module]));
  const hits = site.pages.filter(
    (p) =>
      (p.module && modules.has(p.module)) ||
      p.sections.some(
        (x) => typeof x.props.entity === "string" && modules.has(entityModule.get(x.props.entity) ?? ""),
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

/** The scenario step of the composer. */
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
    let page = site.pages.find((p) => p.route === target.route) as SitePage;
    const offer = signatureOffer(site, page);
    const req = pageComposeRequest({ facts, site, page, scenario, library, offer, signatures });
    if (req.edit.length === 0) continue;
    let answer: PageComposeAnswer;
    try {
      const r = await callTool({
        ...base,
        callType: COMPOSE_CALL_TYPES.page,
        stepName: `page_compose:${page.route}`,
        messages: req.messages,
        tool: req.tool,
      });
      if (!r.ok) {
        notes.push(`Тексты страницы ${page.route} не прошли проверку — оставил каркас из брифа.`);
        continue;
      }
      answer = r.value as PageComposeAnswer;
    } catch (e) {
      if (stop(e)) break;
      continue;
    }
    page = applyAnswer(page, req.edit, answer);
    site = { ...site, pages: site.pages.map((p) => (p.route === page.route ? page : p)) };
    notes.push(`Страница ${page.route} «${page.title}»: композиция и тексты под сценарий «${scenario.id}».`);

    const idea = offer ? answer.signature : undefined;
    if (!idea) continue;
    const placed = await signature(
      ctx,
      { ...base },
      { site, page, idea, facts, library, verify, signatures, notes, stop },
    );
    page = placed;
    site = { ...site, pages: site.pages.map((p) => (p.route === page.route ? page : p)) };
  }

  // The action rules of the site over the model's pages (siteFiles applies them as well).
  site = siteRules(site, (id) => library.find((p) => p.id === id) ?? patternById(id));
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

/**
 * The signature section of a page: submit_section with lint repairs, then G0 of the system with it (one fix round
 * with the G0 problems); a section that still fails — a library pattern in its place.
 */
async function signature(
  ctx: V3BuildContext,
  base: Omit<CallBase, "callType"> & { maxRepairs?: number },
  s: {
    site: SiteModel;
    page: SitePage;
    idea: { after: string; title: string; idea: string };
    facts: SiteFacts;
    library: readonly PatternMeta[];
    verify: ScenarioVerify;
    signatures: Map<string, string>;
    notes: string[];
    stop: (e: unknown) => boolean;
  },
): Promise<SitePage> {
  const { page, idea, facts, library } = s;
  const req = signatureRequest({ facts, site: s.site, page, idea, design: ctx.design, library });
  const tool = req.tool;
  let messages = req.messages;
  let failure = "не прошла проверки кода";
  for (let round = 0; round < 2; round++) {
    let r: Awaited<ReturnType<typeof callTool<typeof signatureSchema>>>;
    try {
      r = await callTool({
        ...base,
        callType: COMPOSE_CALL_TYPES.signature,
        stepName: `signature_section:${page.route}`,
        messages,
        tool,
      });
    } catch (e) {
      s.stop(e);
      failure = "не написана";
      break;
    }
    if (!r.ok) break;
    const v = r.value;
    const file = sectionFile(v.name);
    const section: SiteSection = {
      id: v.name,
      type: "signature",
      pattern: "signature",
      props: v.props,
      file,
      title: v.title,
    };
    const next = withSignature(page, idea.after, section);
    const site = { ...s.site, pages: s.site.pages.map((p) => (p.route === next.route ? next : p)) };
    const sig = new Map([...s.signatures, [file, v.source]]);
    const files = merged(ctx.files, siteFiles(site, facts.copy.site, ctx.design, ctx.files, sig, library));
    const check = await s.verify(withSitePages(ctx.spec, site), files, [file, next.file]);
    if (check.ok) {
      s.signatures.set(file, v.source);
      s.notes.push(
        `Фирменная секция «${v.title}» на странице ${page.route} написана кодом и прошла проверки.`,
      );
      return next;
    }
    failure = `не собралась (${check.problems[0] ?? "G0"})`;
    messages = [
      ...r.messages,
      {
        role: "user",
        content: `Секция не прошла проверку системы (G0):\n${check.problems.slice(0, 8).join("\n")}\nИсправь код и вызови submit_section снова.`,
      },
    ];
  }
  return fallback(page, s, failure);
}

/** A library pattern in the place of a signature section that failed: a call to action with the idea's title. */
function fallback(
  page: SitePage,
  s: {
    site: SiteModel;
    idea: { after: string; title: string };
    library: readonly PatternMeta[];
    notes: string[];
  },
  failure: string,
): SitePage {
  const primary = s.site.primary;
  const used = s.site.pages.flatMap((p) => p.sections.map((x) => x.pattern));
  const at = page.sections.findIndex((x) => x.id === s.idea.after);
  const prev = s.library.find((p) => p.id === page.sections[at]?.pattern);
  const props = primary ? { title: s.idea.title, action: actionLink(primary, page.route) } : null;
  const p = props
    ? choosePattern(s.library, {
        type: "cta" as SectionType,
        needs: null,
        props,
        archetype: s.site.archetype,
        seed: s.site.seed,
        used,
        ...(prev ? { prevLayout: prev.layout } : {}),
      })
    : null;
  if (!p || !props || page.sections.some((x) => x.id === "signature-fallback")) {
    s.notes.push(`Фирменная секция «${s.idea.title}» ${failure} — страница осталась на паттернах.`);
    return page;
  }
  s.notes.push(`Фирменная секция «${s.idea.title}» ${failure} — на её месте паттерн «${p.title}».`);
  return withSignature(page, s.idea.after, {
    id: "signature-fallback",
    type: "cta",
    pattern: p.id,
    props: p.slots.parse(props) as Record<string, unknown>,
  });
}
