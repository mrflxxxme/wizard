// V4-06 (D79 (2)): the model writes the public page as free code — React 19 + Tailwind on the tokens of the client's
// design system + Motion — section by section (ui/sections/<page>-<id>.tsx). The sections bound to data — the request
// form, booking, cart, the visitor's login and cabinet, catalogs — are SDK components the page must keep as they are
// (texts around them only); the library patterns are examples in the prompt, not a list to choose from. Code is
// checked by the pattern lint and the page lint (tokens only, no raw colours or fonts, headings, links, facts), the
// SDK gate (a required component removed — the answer is refused) and G0 of the system before it is accepted.
import type { BriefScenario } from "@wizard/appspec";
import type { LlmMessage } from "@wizard/llm";
import type { DesignSystemV3 } from "@wizard/ui-kit/v3/design";
import { PATTERN_IMPORTS, PATTERN_THEME, PATTERNS, type PatternMeta } from "@wizard/ui-kit/v3/patterns";
import { z } from "zod";
import { defineTool, type ToolIssue, toJsonSchema } from "../../../core/tool.js";
import { heroPhoto } from "./content.js";
import type { SiteFacts } from "./facts.js";
import { copyIssues, lintErrors, propsIssues } from "./lint.js";
import { SECTIONS_DIR, type SiteModel, type SitePage, type SiteSection } from "./site.js";
import { lintSitePage } from "./skeleton.js";

export const PAGE_CODE_TOOL = "submit_page_code";

/** Section types that are SDK components: bound to the system's data and actions, never rewritten by the model. */
export const SDK_TYPES: ReadonlySet<string> = new Set([
  "form",
  "booking",
  "catalog",
  "cart",
  "order",
  "account",
  "shop",
  "product",
  "article",
  "rubric",
  "blog",
]);

/** Props that bind a section to data (V3-08): such a section is an SDK component whatever its type. */
const BINDING_KEYS = [
  "entity",
  "booking",
  "categoryEntity",
  "fields",
  "itemAction",
  "preview",
  "dates",
] as const;

/** Sections the model keeps as they are: SDK components, the owner's contacts (exact phone and address). */
export function isKeptSection(s: SiteSection): boolean {
  if (s.type === "header" || s.type === "footer") return false;
  if (s.type === "contacts" || SDK_TYPES.has(s.type)) return true;
  return BINDING_KEYS.some((k) => s.props[k] !== undefined);
}

/** SDK components of a page (the gate: none of them may disappear). */
export const sdkSections = (page: SitePage): SiteSection[] => page.sections.filter(isKeptSection);

/**
 * The SDK gate (V4-06 acceptance): every SDK component of `before` is still on `after`, with its binding props
 * unchanged. Problems in Russian; empty — the page keeps its components.
 */
export function sdkGate(before: SitePage, after: SitePage): string[] {
  const out: string[] = [];
  for (const s of sdkSections(before)) {
    const now = after.sections.find((x) => x.id === s.id);
    if (!now || now.pattern !== s.pattern) {
      out.push(`На странице ${before.route} нет обязательного компонента «${s.id}» (${s.pattern})`);
      continue;
    }
    for (const k of BINDING_KEYS)
      if (JSON.stringify(now.props[k]) !== JSON.stringify(s.props[k]))
        out.push(`Компонент «${s.id}» на странице ${before.route}: привязка ${k} изменена`);
  }
  return out;
}

const idRe = /^[a-z][a-z0-9-]{1,30}$/;

/** submit_page_code: the body of the page in order — code sections and the kept SDK sections — and the page SEO. */
export function pageCodeSchema(kept: readonly string[]) {
  const code = z.strictObject({
    kind: z.literal("code"),
    id: z.string().regex(idRe, "id: латиница, цифры, дефис"),
    title: z.string().min(3).max(80),
    source: z.string().min(200).max(14000),
    props: z.record(z.string(), z.unknown()),
  });
  const keep = z.strictObject({
    kind: z.literal("keep"),
    id: kept.length ? z.enum(kept as [string, ...string[]]) : z.never(),
    /** Texts of the component (its slot schema); the binding stays. */
    props: z.record(z.string(), z.unknown()).optional(),
  });
  return z.strictObject({
    sections: z
      .array(z.discriminatedUnion("kind", [code, keep]))
      .min(1)
      .max(12),
    seo: z.strictObject({ title: z.string().min(10).max(70), description: z.string().min(50).max(160) }),
  });
}
export type PageCodeAnswer = z.output<ReturnType<typeof pageCodeSchema>>;
type CodeItem = Extract<PageCodeAnswer["sections"][number], { kind: "code" }>;
type KeepItem = Extract<PageCodeAnswer["sections"][number], { kind: "keep" }>;

/** Key of a page in section file names: «home» for /, else the route's words. */
export function pageKey(page: Pick<SitePage, "route">): string {
  const words = page.route
    .split("/")
    .filter((x) => x && !x.startsWith(":"))
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  return words || "home";
}

export const codeSectionFile = (page: Pick<SitePage, "route">, id: string): string =>
  `${SECTIONS_DIR}/${pageKey(page)}-${id}.tsx`;

const BINDING = new Set<string>(BINDING_KEYS);

/** The page with the answer applied: header and footer kept, code sections as section files, kept ones in place. */
export function applyPageCode(
  page: SitePage,
  v: PageCodeAnswer,
  library: readonly PatternMeta[] = PATTERNS,
): { page: SitePage; sources: Map<string, string> } {
  const byId = new Map(page.sections.map((s) => [s.id, s]));
  const sources = new Map<string, string>();
  const body: SiteSection[] = v.sections.map((s): SiteSection => {
    if (s.kind === "code") {
      const file = codeSectionFile(page, s.id);
      sources.set(file, s.source);
      return { id: s.id, type: "signature", pattern: "signature", props: s.props, file, title: s.title };
    }
    const was = byId.get(s.id) as SiteSection;
    if (!s.props) return was;
    // The binding of a kept component comes from the page as it was, never from the model (a key it added included).
    const fixed = Object.fromEntries(Object.entries(was.props).filter(([k]) => BINDING.has(k)));
    const texts = Object.fromEntries(Object.entries(s.props).filter(([k]) => !BINDING.has(k)));
    const merged = { ...was.props, ...texts, ...fixed };
    const parsed = library.find((p) => p.id === was.pattern)?.slots.safeParse(merged);
    return { ...was, props: (parsed?.success ? parsed.data : was.props) as Record<string, unknown> };
  });
  const header = page.sections.filter((s) => s.type === "header");
  const footer = page.sections.filter((s) => s.type === "footer");
  const image = heroPhoto(body[0]?.props) ?? page.seo.image;
  return {
    page: {
      ...page,
      sections: [...header, ...body, ...footer],
      seo: { title: v.seo.title, description: v.seo.description, ...(image ? { image } : {}) },
    },
    sources,
  };
}

const code = (i: number, c: string, message: string, path = `sections.${i}`): ToolIssue => ({
  path,
  code: c,
  message,
});

interface PageCheckCtx {
  site: SiteModel;
  page: SitePage;
  facts: SiteFacts;
  library: readonly PatternMeta[];
  /** Sources of the code sections already on the site (other pages). */
  signatures: ReadonlyMap<string, string>;
}

/**
 * The shape of the page whatever its code: the first section is the hero written as code, ids unique, every SDK
 * component kept with its binding (the SDK gate), photos only from the list, copy of the props and SEO by the facts.
 */
export function pageShapeIssues(
  v: Pick<PageCodeAnswer, "seo"> & { sections: readonly (Omit<CodeItem, "source"> | KeepItem)[] },
  ctx: Omit<PageCheckCtx, "signatures">,
): ToolIssue[] {
  const out: ToolIssue[] = [];
  const seen = new Set<string>();
  v.sections.forEach((s, i) => {
    if (seen.has(s.id)) out.push(code(i, "DUPLICATE", `Секция ${s.id} повторяется`, `sections.${i}.id`));
    seen.add(s.id);
    if (s.kind === "keep" || s.props === undefined) return;
    const photos = new Set(ctx.facts.photos.map((p) => p.src));
    const props = JSON.stringify(s.props);
    for (const src of props.matchAll(/"(?:src|image)":"(\/[^"]*)"/g))
      if (!photos.has(src[1] as string))
        out.push(code(i, "UNKNOWN_PHOTO", `Фото ${src[1]} нет в списке «Фото»`, `sections.${i}.props`));
    for (const c of propsIssues(s.props, ctx.facts.numbers))
      if (c.severity === "error")
        out.push(
          code(
            i,
            c.code.toUpperCase().replace(/-/g, "_"),
            `${c.message_ru}${c.evidence ? `: ${c.evidence}` : ""}`,
            `sections.${i}.props`,
          ),
        );
  });
  const first = v.sections[0];
  if (first?.kind !== "code" || first.id !== "hero")
    out.push(
      code(0, "HERO_FIRST", "Первая секция — первый экран кодом: kind code, id hero, с единственным h1"),
    );
  for (const [k, text] of [
    ["seo.title", v.seo.title],
    ["seo.description", v.seo.description],
  ] as const)
    for (const i of copyIssues(text, ctx.facts.numbers).filter((c) => c.severity === "error"))
      out.push({ path: k, code: i.code.toUpperCase().replace(/-/g, "_"), message: i.evidence });
  const placeholder = {
    seo: v.seo,
    sections: v.sections.map((s) => (s.kind === "code" ? { ...s, source: "" } : s)),
  } as PageCodeAnswer;
  const { page: next } = applyPageCode(ctx.page, placeholder, ctx.library);
  for (const p of sdkGate(ctx.page, next)) out.push({ path: "sections", code: "SDK_REQUIRED", message: p });
  return out;
}

/** The page lint of the applied answer, each issue at its section (source, or props for facts and alt texts). */
export function pageLintIssues(v: PageCodeAnswer, ctx: PageCheckCtx): ToolIssue[] {
  const { page: next, sources } = applyPageCode(ctx.page, v, ctx.library);
  const site = { ...ctx.site, pages: ctx.site.pages.map((p) => (p.route === next.route ? next : p)) };
  const all = new Map([...ctx.signatures, ...sources]);
  const body = next.sections.filter((s) => s.type !== "header" && s.type !== "footer");
  return lintErrors(lintSitePage(site, next, ctx.facts, ctx.library, all)).map((i) => {
    const at = i.section ? body.findIndex((s) => s.id === i.section) : -1;
    const item = at >= 0 ? v.sections[at] : undefined;
    const where =
      item?.kind === "code"
        ? i.code === "untraced-number" || i.code === "weak-alt"
          ? "props"
          : "source"
        : "";
    return {
      path: at >= 0 ? `sections.${at}${where ? `.${where}` : ""}` : "",
      code: i.code.toUpperCase().replace(/-/g, "_"),
      message: `${i.message_ru}${i.evidence ? `: ${i.evidence}` : ""}`,
    };
  });
}

/**
 * Checks of submit_page_code: the shape of the page (pageShapeIssues), then the page lint of the result (pattern rules
 * of each code section, headings, links, layout, facts).
 */
export function pageCodeIssues(v: PageCodeAnswer, ctx: PageCheckCtx): ToolIssue[] {
  const shape = pageShapeIssues(v, ctx);
  return shape.length ? shape : pageLintIssues(v, ctx);
}

/** Rules of the code (React 19 + Tailwind v4 on the tokens + Motion), the same checks the linter runs. */
export const CODE_RULES = [
  `Импорты — только ${PATTERN_IMPORTS.join(", ")}; без import(), require, eval, fetch, dangerouslySetInnerHTML. Один компонент в секции: export default function, тексты и фото — из props.`,
  `Цвета и шрифты — только классы темы: цвета ${PATTERN_THEME.color.join(", ")} (bg-*, text-*, border-*); шрифты font-display и font-sans; кегли text-${PATTERN_THEME.text.join("/text-")}; радиусы rounded-${PATTERN_THEME.radius.join("/rounded-")}; отступы py-section, px-gutter; ширина max-w-page, max-w-text.`,
  "Запрещено: произвольные значения цвета и шрифта (text-[#…], font-[…], bg-[…]), палитра Tailwind по умолчанию (blue-500, gray-100…), #hex и rgb() в коде, style с цветом или шрифтом, градиентный текст.",
  "Раскладка — от 390 до 1440 px без горизонтальной прокрутки: grid/flex, min-w-0, перенос длинных слов (wrap-break-word).",
  "Доступность: на странице один h1 — в первом экране (hero); в остальных секциях h2 и h3 по порядку; у img осмысленный alt; у button — type и текст; у ссылок — href и класс цвета темы; цели нажатия ≥ 44 px (min-h-11).",
  "Движение (motion/react) — только m.* внутри <LazyMotion features={domAnimation}>, с useReducedMotion; при профиле still — без анимации; контент виден и без неё.",
];

/** Taste (v0/Lovable-style constraints): interesting but never ugly; no tiles, no slop. */
export const TASTE_RULES = [
  "Интересно, но никогда не уродливо: у страницы одна сильная идея композиции, которую видно на первом экране; не набор одинаковых плиток.",
  "Палитра — 3–5 цветов темы, не больше двух семейств шрифтов (font-display для заголовков, font-sans для текста).",
  "Без фиолетовых и индиго градиентов, декоративных пузырей и «блобов», эмодзи вместо иконок, трёх одинаковых карточек в ряд, бегущей строки и пульсации.",
  "Без заглушек: нет «Lorem ipsum», «Название услуги», «Ваш текст», пустых ссылок «#»; нет факта — нет блока.",
  "Ритм: чередуйте плотные и воздушные секции, крупную типографику и фото; соседние секции — разных раскладок.",
];

const COPY_RULES = [
  "Пиши как владелец, который объясняет соседу: коротко, конкретно, на «вы» со строчной.",
  "Факты, числа, цены, сроки, имена, отзывы — только из раздела «Факты». Нет факта — не пиши его (D49). Никаких «лучший», «№ 1», «гарантируем».",
  "Кнопка — глагол и объект («Записаться на пробное»), не «Подробнее» и не «Отправить».",
  "Заголовок первого экрана — оффер с фактом из брифа, до 90 знаков; не больше 4 текстовых элементов в первом экране.",
  "Ссылки — только на страницы и якоря из списка «Сайт», tel: и mailto: из фактов. Фото — только из списка «Фото», с осмысленным alt.",
];

const PAGE_RULES = [
  "Тело страницы — список секций по порядку: kind code — секция, которую ты пишешь кодом; kind keep — обязательный компонент SDK, который остаётся как есть.",
  "Все компоненты SDK из списка ниже обязаны остаться (kind keep с их id): форма заявки, запись, корзина, вход и данные системы работают только через них. В props компонента можно переписать тексты по его схеме; привязку к данным не трогай.",
  "Первая секция — первый экран кодом (kind code, id hero) с единственным h1. Шапку и подвал не пиши — их добавит система.",
  "Секция кодом: id — латиница через дефис, title — что она показывает (по-русски), source — TSX, props — тексты и фото, которые секция получит ровно в таком виде.",
  "seo.title — до 70 знаков, seo.description — 50–160 знаков, по фактам страницы.",
  `Отвечай только вызовом ${PAGE_CODE_TOOL}. Если инструмент вернул ошибки — исправь именно их и вызови снова со всей страницей.`,
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
    texts.length
      ? `Тексты владельца:\n${texts.join("\n")}`
      : "Текстов владельца нет: пиши только то, что следует из целей и сценария.",
    f.photos.length ? `Фото:\n${f.photos.map((p) => `- ${p.src} — ${p.alt}`).join("\n")}` : "Фото: нет.",
    `Сайт: ${site.pages.map((p) => `${p.route} «${p.title}» (якоря: ${p.sections.map((s) => `#${s.id}`).join(" ")})`).join("; ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** A short description of the design system for the code (tokens are classes; this is the character). */
export function designBlock(ds: DesignSystemV3): string {
  return [
    `Направление «${ds.name}», схема ${ds.palette.scheme}, тон текстов ${ds.voice}.`,
    `Шрифты: ${ds.fonts.display.family} (font-display, заголовки${ds.type.upper ? " капслоком" : ""}) и ${ds.fonts.text.family} (font-sans).`,
    `Шкала ${ds.type.scale}, радиусы ${ds.radius.set}, ритм ${ds.grid.rhythm.density}, сетка ${ds.grid.layout}, движение ${ds.motion.profile} (вход ${ds.motion.entrance}, наведение ${ds.motion.hover}).`,
    `Фото: ${ds.imagery.style}; рамка ${ds.imagery.frame}, пропорции ${ds.imagery.ratio}. Акцент: ${ds.palette.accentUse}.`,
  ].join("\n");
}

/** Library patterns shown as examples of the level (never a list to choose from): a hero and a content section. */
export function codeExamples(library: readonly PatternMeta[], archetype: string, n = 2): PatternMeta[] {
  const fit = (p: PatternMeta) =>
    (p.archetypes as readonly string[] | undefined)?.includes(archetype) ?? false;
  const pick = (type: string) =>
    library.find((p) => p.sectionType === type && !p.needs && fit(p)) ??
    library.find((p) => p.sectionType === type && !p.needs);
  return [pick("hero"), pick("services") ?? pick("about")].filter((p): p is PatternMeta => !!p).slice(0, n);
}

export function scenarioText(s: BriefScenario): string {
  return `Когда ${s.when.replace(/^когда\s+/i, "")}, система: ${s.then.join("; ")}.`;
}

/** The prompt of the page code: rules, taste, examples, facts, design, the scenario, the SDK components of the page. */
export function pageCodeMessages(o: {
  facts: SiteFacts;
  site: SiteModel;
  page: SitePage;
  scenario: BriefScenario;
  design: DesignSystemV3;
  library?: readonly PatternMeta[];
  /** Sources of the page's code sections now (an earlier scenario): the model may rewrite or keep their idea. */
  current?: ReadonlyMap<string, string>;
  /** V4-21: what the browser check found not shown on the page — the block «Что исправить» (only when repairing). */
  repair?: readonly string[];
}): LlmMessage[] {
  const library = o.library ?? PATTERNS;
  const examples = codeExamples(library, o.site.archetype);
  const kept = sdkSections(o.page).map((s) => {
    const meta = library.find((p) => p.id === s.pattern);
    const schema = meta ? `\n  схема props: ${JSON.stringify(toJsonSchema(meta.slots))}` : "";
    return `- ${s.id} (${s.type}, компонент ${s.pattern}${meta ? `: ${meta.title}` : ""}); сейчас props: ${JSON.stringify(s.props)}${schema}`;
  });
  const now = o.page.sections
    .filter((s) => s.type !== "header" && s.type !== "footer")
    .map((s) => `${s.id} (${s.type === "signature" ? "код" : s.pattern})`);
  const own = [...(o.current ?? new Map())].filter(([f]) => o.page.sections.some((s) => s.file === f));
  return [
    {
      role: "system",
      content: [
        "Ты — ведущий фронтенд-дизайнер Born to Build. Пишешь публичную страницу сайта клиента кодом: React 19 + Tailwind v4 на токенах его дизайн-системы + Motion. Сайт не должен выглядеть шаблоном и быть похожим на другие.",
        "## Вкус",
        TASTE_RULES.map((r) => `- ${r}`).join("\n"),
        "## Правила кода",
        CODE_RULES.map((r) => `- ${r}`).join("\n"),
        "## Правила текста",
        COPY_RULES.map((r) => `- ${r}`).join("\n"),
        "## Правила страницы",
        PAGE_RULES.map((r) => `- ${r}`).join("\n"),
        ...examples.map(
          (p) =>
            `## Пример уровня — паттерн библиотеки ${p.id} (${p.title}); это образец качества кода, а не шаблон для копирования\n\`\`\`tsx\n${p.source}\`\`\``,
        ),
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `## Факты\n${factsBlock(o.facts, o.site)}`,
        `## Дизайн-система\n${designBlock(o.design)}`,
        `## Сценарий\n${scenarioText(o.scenario)}`,
        `## Страница ${o.page.route} «${o.page.title}»\nСейчас: ${now.join(", ")}.`,
        kept.length
          ? `## Обязательные компоненты SDK (kind keep)\n${kept.join("\n")}`
          : "## Обязательные компоненты SDK\nНа этой странице их нет.",
        ...own.map(([f, src]) => `## Код секции сейчас (${f})\n\`\`\`tsx\n${src.slice(0, 4000)}\`\`\``),
        o.repair?.length
          ? `## Что исправить\nПроверка в браузере: на сайте не показано обещанное сценарием.\n${o.repair.map((r) => `- ${r}`).join("\n")}\nИсправь это по фактам; чего нет в фактах, не выдумывай.`
          : "",
        `## Задача\nНапиши страницу под сценарий и вызови ${PAGE_CODE_TOOL}.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

/** The page code request: the tool with its checks and the prompt. */
export function pageCodeRequest(o: {
  facts: SiteFacts;
  site: SiteModel;
  page: SitePage;
  scenario: BriefScenario;
  design: DesignSystemV3;
  library?: readonly PatternMeta[];
  signatures?: ReadonlyMap<string, string>;
  repair?: readonly string[];
}) {
  const library = o.library ?? PATTERNS;
  const signatures = o.signatures ?? new Map<string, string>();
  const tool = defineTool({
    name: PAGE_CODE_TOOL,
    description: "The public page as free code: code sections and the kept SDK components in order, SEO.",
    input: pageCodeSchema(sdkSections(o.page).map((s) => s.id)),
    check: (v) => pageCodeIssues(v, { site: o.site, page: o.page, facts: o.facts, library, signatures }),
  });
  return {
    tool,
    messages: pageCodeMessages({ ...o, library, current: signatures }),
  };
}

export type { CodeItem, KeepItem };
