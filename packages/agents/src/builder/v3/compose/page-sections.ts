// V4-06 speed (plan v4 §5, orchestrator 13.10.2026): the page as code in two steps instead of one long answer. A short
// plan call fixes the sections of the page — ids, titles, the idea of each code section, its props (texts and photos)
// and the kept SDK components — then every code section is written by its own short call, all at once. The page is
// assembled by code (applyPageCode) and checked as before; only a section that fails is written again. Mechanical
// slips (imports, tailwind names, missing attributes) are fixed by code before any check: a fix code can make never
// costs a model call.
import type { LlmMessage } from "@wizard/llm";
import type { DesignSystemV3 } from "@wizard/ui-kit/v3/design";
import { lintPattern, type PatternMeta } from "@wizard/ui-kit/v3/patterns";
import { z } from "zod";
import { defineTool, type ToolIssue, toJsonSchema } from "../../../core/tool.js";
import type { SiteFacts } from "./facts.js";
import {
  CODE_RULES,
  codeExamples,
  designBlock,
  type PageCodeAnswer,
  pageShapeIssues,
  sdkSections,
  TASTE_RULES,
} from "./page-code.js";
import type { SiteModel, SitePage } from "./site.js";

export const PAGE_PLAN_TOOL = "submit_page_plan";
export const SECTION_CODE_TOOL = "submit_section_code";

const idRe = /^[a-z][a-z0-9-]{1,30}$/;

/** submit_page_plan: the body of the page in order — code sections with their idea and props, kept SDK ones — and SEO. */
export function pagePlanSchema(kept: readonly string[]) {
  const code = z.strictObject({
    kind: z.literal("code"),
    id: z.string().regex(idRe, "id: латиница, цифры, дефис"),
    title: z.string().min(3).max(80),
    /** What the section shows and how it is laid out (one or two sentences): the brief of its own call. */
    idea: z.string().min(10).max(400),
    props: z.record(z.string(), z.unknown()),
  });
  const keep = z.strictObject({
    kind: z.literal("keep"),
    id: kept.length ? z.enum(kept as [string, ...string[]]) : z.never(),
    props: z.record(z.string(), z.unknown()).optional(),
  });
  return z.strictObject({
    sections: z
      .array(z.discriminatedUnion("kind", [code, keep]))
      .min(1)
      .max(10),
    seo: z.strictObject({ title: z.string().min(10).max(70), description: z.string().min(50).max(160) }),
  });
}
export type PagePlan = z.output<ReturnType<typeof pagePlanSchema>>;
export type PlanCodeItem = Extract<PagePlan["sections"][number], { kind: "code" }>;

export const sectionCodeSchema = z.strictObject({ source: z.string().min(150).max(9000) });

/** The answer of the page with the sources written by the section calls (one per code section of the plan). */
export function planAnswer(plan: PagePlan, sources: ReadonlyMap<string, string>): PageCodeAnswer {
  return {
    seo: plan.seo,
    sections: plan.sections.map((s) =>
      s.kind === "code"
        ? { kind: "code", id: s.id, title: s.title, source: sources.get(s.id) ?? "", props: s.props }
        : s,
    ),
  } as PageCodeAnswer;
}

// ------------------------------------------------------------------------------------------------ mechanical fixes

const MOTION_FROM = /from\s+["'](?:framer-motion|motion)["']/g;

/**
 * Deterministic fixes of the slips models make most (code, never a model call): framer-motion → motion/react,
 * class → className, a named default export, `motion.x` → `m.x` inside LazyMotion. Returns the source unchanged when
 * nothing applies.
 */
export function autofixSection(source: string): string {
  let s = source.replace(/^\s*```(?:tsx|jsx|ts)?\s*\n/, "").replace(/\n```\s*$/, "\n");
  s = s.replace(MOTION_FROM, 'from "motion/react"');
  s = s.replace(/<([a-zA-Z][\w.]*)([^>]*?)\sclass=/g, "<$1$2 className=");
  if (!/export\s+default\s+function/.test(s)) {
    const named = s.match(/export\s+function\s+([A-Z]\w*)/);
    if (named) s = s.replace(`export function ${named[1]}`, `export default function ${named[1]}`);
  }
  if (/\bLazyMotion\b/.test(s)) s = s.replace(/<(\/?)motion\./g, "<$1m.");
  return s;
}

/** Pattern rules of one section's source (errors only), each with its line, as tool issues. */
export function sectionIssues(source: string, o: { id: string; hero: boolean }): ToolIssue[] {
  const out: ToolIssue[] = lintPattern(source, `${o.id}.tsx`).map((i) => ({
    path: "source",
    code: i.code.toUpperCase().replace(/-/g, "_"),
    message: `${i.message_ru} (строка ${i.line}): ${i.evidence}`,
  }));
  const h1 = /<(?:m\.)?h1\b/.test(source);
  if (o.hero && !h1)
    out.push({ path: "source", code: "NO_H1", message: "В первом экране нужен единственный h1" });
  if (!o.hero && h1)
    out.push({ path: "source", code: "EXTRA_H1", message: "h1 — только в первом экране; здесь h2 и h3" });
  return out;
}

// ------------------------------------------------------------------------------------------------ prompts

const PLAN_RULES = [
  "Сначала — план страницы, без кода: список секций по порядку. kind code — секция, которую потом напишут кодом; kind keep — обязательный компонент SDK, он остаётся как есть.",
  "У секции кодом: id (латиница через дефис), title (что показывает), idea — 1–2 предложения о раскладке и приёме (что крупно, где фото, как читается на телефоне), props — все тексты и фото секции ровно в том виде, в каком их получит код.",
  "Первая секция — первый экран (kind code, id hero). Шапку и подвал не пиши. Соседние секции — разных раскладок; у страницы одна сильная идея.",
  "Все компоненты SDK из списка обязаны остаться (kind keep с их id); в их props можно переписать тексты по схеме, привязку не трогай.",
  "seo.title — до 70 знаков, seo.description — 50–160 знаков, по фактам страницы.",
  `Отвечай только вызовом ${PAGE_PLAN_TOOL}.`,
];

const COPY_RULES = [
  "Пиши как владелец, который объясняет соседу: коротко, конкретно, на «вы» со строчной.",
  "Факты, числа, цены, сроки, имена, отзывы — только из раздела «Факты». Нет факта — не пиши его (D49). Никаких «лучший», «№ 1», «гарантируем».",
  "Кнопка — глагол и объект («Записаться на пробное»), не «Подробнее» и не «Отправить».",
  "Ссылки — только на страницы и якоря из списка «Сайт», tel: и mailto: из фактов. Фото — только из списка «Фото», с осмысленным alt.",
];

function factsBlock(f: SiteFacts, site: SiteModel): string {
  const texts = [...f.texts.entries()].map(([type, c]) => `- ${type}: ${JSON.stringify(c)}`);
  return [
    `Бизнес: ${f.copy.home}.`,
    f.description ? `Описание: ${f.description}` : "",
    f.audience ? `Аудитория: ${f.audience}` : "",
    `Цели: ${f.goals.join("; ") || "не указаны"}`,
    f.phone || f.email || f.address
      ? `Контакты: ${[f.phone, f.email, f.address].filter(Boolean).join(", ")}`
      : "",
    texts.length ? `Тексты владельца:\n${texts.join("\n")}` : "",
    f.photos.length ? `Фото:\n${f.photos.map((p) => `- ${p.src} — ${p.alt}`).join("\n")}` : "Фото: нет.",
    `Сайт: ${site.pages.map((p) => `${p.route} «${p.title}» (якоря: ${p.sections.map((s) => `#${s.id}`).join(" ")})`).join("; ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The plan prompt: the facts, the design, the scenario and the SDK components of the page. */
export function pagePlanMessages(o: {
  facts: SiteFacts;
  site: SiteModel;
  page: SitePage;
  scenarioText: string;
  design: DesignSystemV3;
  library: readonly PatternMeta[];
}): LlmMessage[] {
  const kept = sdkSections(o.page).map((s) => {
    const meta = o.library.find((p) => p.id === s.pattern);
    const schema = meta ? `\n  схема props: ${JSON.stringify(toJsonSchema(meta.slots))}` : "";
    return `- ${s.id} (${s.type}, компонент ${s.pattern}${meta ? `: ${meta.title}` : ""}); сейчас props: ${JSON.stringify(s.props)}${schema}`;
  });
  return [
    {
      role: "system",
      content: [
        "Ты — ведущий дизайнер Born to Build. Планируешь публичную страницу сайта клиента: какие секции, в каком порядке, с какими текстами. Код секций напишут по твоему плану.",
        "## Вкус",
        TASTE_RULES.map((r) => `- ${r}`).join("\n"),
        "## Правила текста",
        COPY_RULES.map((r) => `- ${r}`).join("\n"),
        "## Правила плана",
        PLAN_RULES.map((r) => `- ${r}`).join("\n"),
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `## Факты\n${factsBlock(o.facts, o.site)}`,
        `## Дизайн-система\n${designBlock(o.design)}`,
        `## Сценарий\n${o.scenarioText}`,
        `## Страница ${o.page.route} «${o.page.title}»`,
        kept.length
          ? `## Обязательные компоненты SDK (kind keep)\n${kept.join("\n")}`
          : "## Обязательные компоненты SDK\nНа этой странице их нет.",
        `## Задача\nСоставь план страницы под сценарий и вызови ${PAGE_PLAN_TOOL}.`,
      ].join("\n\n"),
    },
  ];
}

/** The prompt of one code section: rules, one example of the level, the plan around it, its idea and props. */
export function sectionMessages(o: {
  plan: PagePlan;
  item: PlanCodeItem;
  page: SitePage;
  design: DesignSystemV3;
  library: readonly PatternMeta[];
  archetype: string;
}): LlmMessage[] {
  const hero = o.item.id === "hero";
  const example =
    codeExamples(o.library, o.archetype, 2)[hero ? 0 : 1] ?? codeExamples(o.library, o.archetype, 1)[0];
  const outline = o.plan.sections
    .map((s) => `- ${s.id}${s.kind === "code" ? ` — ${s.title}: ${s.idea}` : " — компонент SDK"}`)
    .join("\n");
  return [
    {
      role: "system",
      content: [
        "Ты — ведущий фронтенд-дизайнер Born to Build. Пишешь одну секцию публичной страницы кодом: React 19 + Tailwind v4 на токенах дизайн-системы клиента + Motion. Секция не должна выглядеть шаблоном.",
        "## Вкус",
        TASTE_RULES.map((r) => `- ${r}`).join("\n"),
        "## Правила кода",
        CODE_RULES.map((r) => `- ${r}`).join("\n"),
        `- ${hero ? "Это первый экран: в нём единственный h1 страницы." : "Это не первый экран: заголовок — h2, подзаголовки — h3; h1 не используй."}`,
        "- Все тексты и фото — только из props (ровно эти ключи); своих текстов в коде нет.",
        `- Отвечай только вызовом ${SECTION_CODE_TOOL} с полным TSX секции. Если инструмент вернул ошибки — исправь именно их.`,
        ...(example
          ? [
              `## Пример уровня — паттерн ${example.id} (${example.title}); образец качества кода, не шаблон\n\`\`\`tsx\n${example.source}\`\`\``,
            ]
          : []),
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `## Дизайн-система\n${designBlock(o.design)}`,
        `## Страница ${o.page.route} «${o.page.title}» — план\n${outline}`,
        `## Твоя секция: ${o.item.id} — ${o.item.title}\n${o.item.idea}`,
        `## props секции (придут в компонент ровно такими)\n${JSON.stringify(o.item.props, null, 1)}`,
        `## Задача\nНапиши секцию и вызови ${SECTION_CODE_TOOL}.`,
      ].join("\n\n"),
    },
  ];
}

/** The plan request: the tool with the page shape checks (no code yet). */
export function pagePlanRequest(o: {
  facts: SiteFacts;
  site: SiteModel;
  page: SitePage;
  scenarioText: string;
  design: DesignSystemV3;
  library: readonly PatternMeta[];
}) {
  const tool = defineTool({
    name: PAGE_PLAN_TOOL,
    description:
      "The plan of the public page: code sections with their idea and props, the kept SDK components, SEO.",
    input: pagePlanSchema(sdkSections(o.page).map((s) => s.id)),
    check: (v) => pageShapeIssues(v, o),
  });
  return { tool, messages: pagePlanMessages(o) };
}

/** The request of one code section: mechanical fixes first, then the pattern rules of its source. */
export function sectionRequest(o: Parameters<typeof sectionMessages>[0]) {
  const tool = defineTool({
    name: SECTION_CODE_TOOL,
    description: "The TSX of one section of the page (one default export, texts and photos from props).",
    input: sectionCodeSchema,
    normalize: (args: unknown) =>
      args && typeof args === "object" && typeof (args as { source?: unknown }).source === "string"
        ? { ...(args as object), source: autofixSection((args as { source: string }).source) }
        : args,
    check: (v) => sectionIssues(v.source, { id: o.item.id, hero: o.item.id === "hero" }),
  });
  return { tool, messages: sectionMessages(o) };
}
