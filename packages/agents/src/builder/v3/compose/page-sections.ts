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
  HOME_MIN_SECTIONS,
  type PageCodeAnswer,
  pageShapeIssues,
  sdkSections,
  softOnLastAttempt,
  stripPricePromises,
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
    idea: z.string().max(400).optional(),
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
 * What a section written as code may take from @wizard/ui-kit/v3/headless: helpers of photos and text only. There are
 * no UI components there (Accordion, Tabs, Button…): the section writes its own markup; data goes through the SDK
 * components the plan keeps.
 */
export const SECTION_HEADLESS = [
  "srcSetOf",
  "IMAGE_WIDTHS",
  "fitWords",
  "useFitWords",
  "richInline",
  "richPlain",
  "safeHref",
] as const;
const HEADLESS_IMPORT = /import\s*(type\s+)?\{([^}]*)\}\s*from\s*["']@wizard\/ui-kit\/v3\/headless["'];?\n?/;

/** Names a section imports from headless that it may not (not in SECTION_HEADLESS). */
export function unknownHeadless(source: string): string[] {
  const m = HEADLESS_IMPORT.exec(source);
  if (!m || m[1]) return [];
  const allowed = new Set<string>(SECTION_HEADLESS);
  return (m[2] as string)
    .split(",")
    .map(
      (x) =>
        x
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim() ?? "",
    )
    .filter((x) => x && !allowed.has(x));
}

/** An import the section may not take is dropped with the blocks that use it (<X …/> and <X …>…</X>). */
function withoutUnknownHeadless(source: string): string {
  const bad = unknownHeadless(source);
  if (!bad.length) return source;
  let s = source.replace(HEADLESS_IMPORT, (_all, type: string | undefined, names: string) => {
    const keep = names
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x && !bad.includes(x.split(/\s+as\s+/)[0]?.trim() ?? ""));
    return keep.length
      ? `import ${type ?? ""}{ ${keep.join(", ")} } from "@wizard/ui-kit/v3/headless";\n`
      : "";
  });
  for (const name of bad) {
    s = s.replace(new RegExp(`<${name}\\b[^>]*?/>`, "g"), "");
    s = s.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}>`, "g"), "");
  }
  return s;
}

/**
 * Deterministic fixes of the slips models make most (code, never a model call): framer-motion → motion/react,
 * class → className, a named default export, `motion.x` → `m.x` inside LazyMotion. Returns the source unchanged when
 * nothing applies.
 */
export function autofixSection(source: string): string {
  let s = source
    .replace(/^\s*```(?:tsx|jsx|ts|typescript)?\s*\n/, "")
    .replace(/\n```\s*$/, "\n")
    // A fence cut in half leaves its language as the first line («tsx» — G0: Cannot find name 'tsx').
    .replace(/^\s*(?:tsx|jsx)\s*\n/, "");
  s = s.replace(MOTION_FROM, 'from "motion/react"');
  s = s.replace(/<([a-zA-Z][\w.]*)([^>]*?)\sclass=/g, "<$1$2 className=");
  if (!/export\s+default\s+function/.test(s)) {
    const named = s.match(/export\s+function\s+([A-Z]\w*)/);
    if (named) s = s.replace(`export function ${named[1]}`, `export default function ${named[1]}`);
  }
  if (/<LazyMotion\b/.test(s)) s = s.replace(/<(\/?)motion\./g, "<$1m.");
  else if (/<(?:m|motion)\./.test(s)) s = withLazyMotion(s.replace(/<(\/?)motion\./g, "<$1m."));
  // safeHref returns { href, external } | null, not a string (G0 TS2322 on href={safeHref(x)}).
  s = s.replace(/href=\{safeHref\(([^()]*)\)\}/g, "href={safeHref($1)?.href}");
  // Every helper a section may take has one argument (G0 TS2554 «Expected 1 arguments, but got 2»: fitWords(t, 3)).
  s = s.replace(
    /\b(fitWords|useFitWords|srcSetOf|safeHref|richInline|richPlain)(<[^<>()]*>)?\(([^(),]+),[^()]*\)/g,
    "$1$2($3)",
  );
  return withLinkColor(withoutUnknownHeadless(s));
}

/**
 * A link without a theme text colour (the linter's LINK_COLOR): the flagged <a> gets text-inherit — the colour of its
 * parent, what the model meant by leaving it out. Only the tags the linter names are touched.
 */
function withLinkColor(source: string): string {
  let lines: number[];
  try {
    lines = lintPattern(source, "section.tsx")
      .filter((i) => i.code === "link-color")
      .map((i) => i.line);
  } catch {
    return source;
  }
  if (!lines.length) return source;
  const rows = source.split("\n");
  for (const n of new Set(lines)) {
    const row = rows[n - 1];
    if (row === undefined) continue;
    const at = row.search(/<a\b/);
    if (at < 0) continue;
    const head = row.slice(at);
    const fixed = /^<a\b[^>]*?\sclassName="/.test(head)
      ? head.replace(/^(<a\b[^>]*?\sclassName=")/, "$1text-inherit ")
      : /^<a\b[^>]*\sclassName=/.test(head)
        ? head
        : head.replace(/^<a\b/, '<a className="text-inherit"');
    rows[n - 1] = row.slice(0, at) + fixed;
  }
  return rows.join("\n");
}

/**
 * m.* without <LazyMotion> (the linter's MOTION_LAZY, the most frequent refusal of the probe): the JSX the default
 * export returns gets the wrapper and the import. The source is left as it was when the return cannot be found.
 */
function withLazyMotion(input: string): string {
  let source = input;
  const start = source.search(/export\s+default\s+function/);
  if (start >= 0 && source.indexOf("return (", start) < 0) {
    // `return <section>…</section>;` without parentheses: the last statement of the default export gets them.
    const bare = source.indexOf("return <", start);
    const close = source.lastIndexOf("}");
    const semi = source.lastIndexOf(";", close);
    const end = semi > bare ? semi : source.lastIndexOf(">", close) + 1;
    if (bare < 0 || close < bare || end <= bare) return source;
    source = `${source.slice(0, bare)}return (${source.slice(bare + "return ".length, end)});${source.slice(semi > bare ? end + 1 : end)}`;
  }
  const ret = start < 0 ? -1 : source.indexOf("return (", start);
  if (ret < 0) return source;
  let depth = 0;
  let end = -1;
  for (let i = ret + "return ".length; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return source;
  const open = ret + "return (".length;
  const body = source.slice(open, end);
  let out = `${source.slice(0, open)}\n<LazyMotion features={domAnimation}>${body}</LazyMotion>\n${source.slice(end)}`;
  const imp = /import\s*\{([^}]*)\}\s*from\s*["']motion\/react["'];?/.exec(out);
  if (imp) {
    const names = new Set(
      (imp[1] as string)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    );
    names.add("LazyMotion");
    names.add("domAnimation");
    out = out.replace(imp[0], `import { ${[...names].join(", ")} } from "motion/react";`);
  } else out = `import { domAnimation, LazyMotion } from "motion/react";\n${out}`;
  return out;
}

/** Pattern rules of one section's source (errors only), each with its line, as tool issues. */
export function sectionIssues(source: string, o: { id: string; hero: boolean }): ToolIssue[] {
  const out: ToolIssue[] = lintPattern(source, `${o.id}.tsx`).map((i) => ({
    path: "source",
    code: i.code.toUpperCase().replace(/-/g, "_"),
    message: `${i.message_ru} (строка ${i.line}): ${i.evidence}`,
  }));
  for (const name of unknownHeadless(source))
    out.push({
      path: "source",
      code: "UNKNOWN_IMPORT",
      message: `В @wizard/ui-kit/v3/headless нет «${name}» для секции; можно только ${SECTION_HEADLESS.join(", ")} — разметку пиши сама`,
    });
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
  "Первый экран — заголовок-оффер с фактом из брифа (до 90 знаков), одна строка пояснения, одна главная кнопка и фото; без подписи над заголовком (eyebrow), второй кнопки и сносок; телефон, часы и адрес — не в первом экране.",
  "Каталог (услуги, меню, прайс) на главной — компонент SDK: ставь его сразу после первого экрана; заголовок — словами брифа; «цены» в заголовке — только если цены есть в фактах.",
  "Без подпорок: секции из одного фото без текста нет; преимущества — только 3+ конкретных пункта из фактов, иначе блока нет.",
  `Главная — полная страница: 5–8 секций (не меньше ${HOME_MIN_SECTIONS}). Каждое обещание сценария — своя секция: компонент SDK, если есть, иначе код по фактам; контакты и «как проходит запись» по фактам — обязательно. Врачи и отзывы — только компонентом SDK с данными; нет ни фактов, ни компонента — секции нет.`,
  "Все компоненты SDK из списка обязаны остаться (kind keep с их id); в их props можно переписать тексты по схеме, привязку не трогай.",
  "Не нумеруй пункты в props («01», «02»): номер шага, если он нужен, рисует код секции.",
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
    .map(
      (s) =>
        `- ${s.id}${s.kind === "code" ? ` — ${s.title}${s.idea ? `: ${s.idea}` : ""}` : " — компонент SDK"}`,
    )
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
        `- Из @wizard/ui-kit/v3/headless — только ${SECTION_HEADLESS.join(", ")}; готовых UI-компонентов (Accordion, Tabs, Button, Card…) там нет, разметку пиши сама.`,
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
        `## Твоя секция: ${o.item.id} — ${o.item.title}${o.item.idea ? `\n${o.item.idea}` : ""}`,
        `## props секции (придут в компонент ровно такими)\n${JSON.stringify(o.item.props, null, 1)}`,
        `## Задача\nНапиши секцию и вызови ${SECTION_CODE_TOOL}.`,
      ].join("\n\n"),
    },
  ];
}

/**
 * Mechanical slips of the plan: sections or seo sent as a JSON string (MiMo), zero-padded ordinals «01», «02» in props
 * (UNTRACED_NUMBER: the brief has no such numbers — the code draws a step number itself).
 */
export function normalizePlan(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const key of ["sections", "seo"])
    if (typeof out[key] === "string")
      try {
        out[key] = JSON.parse(out[key] as string);
      } catch {
        // left as is: the schema names the field
      }
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.filter((x) => !(typeof x === "string" && ORDINAL.test(x))).map(strip);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => !(typeof x === "string" && ORDINAL.test(x)))
          .map(([k, x]) => [k, strip(x)]),
      );
    return v;
  };
  if (Array.isArray(out.sections))
    out.sections = out.sections.map((x) =>
      x && typeof x === "object" && "props" in x
        ? { ...x, props: strip((x as { props: unknown }).props) }
        : x,
    );
  return out;
}
const ORDINAL = /^0\d\.?$/;

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
    normalize: (args: unknown) => stripPricePromises(normalizePlan(args), o.facts.prices),
    check: softOnLastAttempt((v: PagePlan) => pageShapeIssues(v, o)),
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
    check: softOnLastAttempt((v: { source: string }) =>
      sectionIssues(v.source, { id: o.item.id, hero: o.item.id === "hero" }),
    ),
  });
  return { tool, messages: sectionMessages(o) };
}
