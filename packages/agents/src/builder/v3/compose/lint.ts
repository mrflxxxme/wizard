// Anti-slop linter of the v3 public pages (V3-12; docs/research/design-agent-catalog.md B, H; D49, D64). Section code
// goes through lintPattern (theme tokens only, imports, a11y of img/button/a, motion); on top of it the page rules:
// layout family repeated in a row (L06), a row of three equal cards (L01), default fonts (T01, A3), purple gradients
// (C01), emoji (K07, I07), placeholder copy (K04), superlatives (K02), numbers not found in the facts (K03, D49), stop
// words (K01), meaningless alt (A08), heading order and one h1 per page (A06), links to pages that do not exist.
import type { DesignSystemV3 } from "@wizard/ui-kit/v3/design";
import { FORBIDDEN_FONTS, parseOklch } from "@wizard/ui-kit/v3/design";
import { type LayoutFamily, lintPattern, type PatternLintCode } from "@wizard/ui-kit/v3/patterns";
import ts from "typescript";
import { numbersOf } from "./facts.js";

export type PageLintCode =
  | PatternLintCode
  | "layout-repeat"
  | "three-cards"
  | "default-font"
  | "purple-gradient"
  | "emoji"
  | "placeholder"
  | "superlative"
  | "untraced-number"
  | "stop-word"
  | "exclamation"
  | "weak-alt"
  | "heading-order"
  | "multiple-h1"
  | "no-h1"
  | "broken-link";

export interface PageLintIssue {
  code: PageLintCode;
  /** error — the section (signature) or the page is not accepted; warn — a note for the critic. */
  severity: "error" | "warn";
  message_ru: string;
  /** Section id on the page. */
  section?: string;
  evidence?: string;
}

const MESSAGES: Record<Exclude<PageLintCode, PatternLintCode>, string> = {
  "layout-repeat": "Две секции подряд одной раскладки: возьмите другой вариант (каталог L06)",
  "three-cards":
    "Ряд из трёх одинаковых карточек «иконка + заголовок + текст» (каталог L01): прайс, доминанта со списком или таблица",
  "default-font":
    "Шрифт по умолчанию (Inter, системный, Arial): только шрифты дизайн-системы (D64, каталог A3)",
  "purple-gradient": "Фиолетовый градиент — примета ИИ-палитры (каталог C01): сплошной цвет темы",
  emoji: "Эмодзи в тексте или вместо иконок (каталог K07, I07): обычный текст, иконки ui-kit",
  placeholder: "Рыба или заглушка вместо текста (каталог K04): настоящий текст из брифа",
  superlative:
    "Превосходная степень без источника: «лучший», «№ 1», «самый», «гарантируем» (каталог K02, 38-ФЗ, D49)",
  "untraced-number":
    "Число, которого нет в брифе и данных клиента (каталог K03, D49): уберите или возьмите из брифа",
  "stop-word": "Слово-пустышка из стоп-листа (каталог H.3): скажите конкретно — что, сколько, когда",
  exclamation: "Восклицательный знак в тексте интерфейса (каталог K07): точка",
  "weak-alt": "Подпись фото ничего не описывает (каталог A08): что на снимке",
  "heading-order": "Пропуск уровня заголовка (каталог A06): h1 → h2 → h3 без пропусков",
  "multiple-h1": "На странице больше одного h1 (каталог A06)",
  "no-h1": "На странице нет h1: заголовок первого экрана — h1",
  "broken-link": "Ссылка ведёт на страницу или якорь, которых на сайте нет",
};

const PATTERN_ERRORS: ReadonlySet<PatternLintCode> = new Set([
  "import",
  "dynamic-code",
  "default-export",
  "arbitrary-color",
  "arbitrary-font",
  "palette",
  "raw-color",
  "inline-style",
  "slop",
  "fabricated",
  "img-alt",
  "button-type",
  "button-name",
  "link-href",
  "link-name",
  "link-color",
  "click-target",
  "reduced-motion",
  "motion-lazy",
  "forbidden-source",
]);

// --------------------------------------------------------------------------------------------------- copy rules

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const PLACEHOLDER_RE =
  /lorem|ipsum|иван\s+иванов|ромашк|заголовок\s+секции|подзаголовок\s+секции|текст\s+секции|название\s+услуги|^пример\b|\bTODO\b|\bxxx\b|\{\{|\[(?:текст|название|цена)\]/i;
const SUPERLATIVE_RE =
  /(?<![а-яё])(?:лучш(?:ий|ая|ее|ие|их|ему|ей)|сам(?:ый|ая|ое|ые|ых)\s+(?:лучш|популяр|надёжн|надежн|больш|качествен|выгодн)|лидер(?:ы|ом)?\s+рынка|непревзойд|гарантир(?:уем|ует|ованн)|идеальн)|№\s?1\b|номер\s+один|топ-?\d|\b100\s?%/i;
/** Stop list of the catalog H.3 (K01). */
export const STOP_WORDS = [
  "инновационн",
  "уникальн",
  "индивидуальный подход",
  "команда профессионалов",
  "комплексные решения",
  "широкий спектр",
  "динамично развивающ",
  "качественно и в срок",
  "лучшие цены",
  "высокое качество",
  "идеальное решение",
  "погрузитесь",
  "откройте для себя",
  "незабываем",
  "надёжный партнёр",
  "надежный партнер",
  "ценим каждого клиента",
  "в кратчайшие сроки",
  "премиальн",
  "эксклюзивн",
] as const;

export interface CopyIssue {
  code: Extract<
    PageLintCode,
    "emoji" | "placeholder" | "superlative" | "untraced-number" | "stop-word" | "exclamation"
  >;
  severity: "error" | "warn";
  evidence: string;
}

/**
 * Copy rules for one text the visitor reads. `numbers` — the numbers of the facts (siteFacts); without it numbers are
 * not checked. Phones, e-mails and links are not copy.
 */
export function copyIssues(text: string, numbers?: ReadonlySet<string>): CopyIssue[] {
  const t = text.trim();
  if (!t || /^(?:tel:|mailto:|https?:\/\/|\/|#)/.test(t)) return [];
  const out: CopyIssue[] = [];
  const ev = t.slice(0, 120);
  if (EMOJI_RE.test(t)) out.push({ code: "emoji", severity: "error", evidence: ev });
  if (PLACEHOLDER_RE.test(t)) out.push({ code: "placeholder", severity: "error", evidence: ev });
  if (SUPERLATIVE_RE.test(t)) out.push({ code: "superlative", severity: "error", evidence: ev });
  if (numbers) {
    const missing = numbersOf(t).filter((n) => !numbers.has(n));
    if (missing.length)
      out.push({ code: "untraced-number", severity: "error", evidence: `${missing.join(", ")} в «${ev}»` });
  }
  const low = t.toLowerCase();
  const stop = STOP_WORDS.find((w) => low.includes(w));
  if (stop) out.push({ code: "stop-word", severity: "warn", evidence: stop });
  if (/!/.test(t)) out.push({ code: "exclamation", severity: "warn", evidence: ev });
  return out;
}

const GENERIC_ALT_RE =
  /^(?:фото(?:графия)?|изображение|картинка|снимок|image|photo|picture|img)\s*\d*$|\.(?:jpe?g|png|webp|svg)$/i;

/** Copy issues of every text of a section's props, plus meaningless alt texts of its images. */
export function propsIssues(props: unknown, numbers?: ReadonlySet<string>): PageLintIssue[] {
  const out: PageLintIssue[] = [];
  const visit = (v: unknown, key: string): void => {
    if (typeof v === "string") {
      if (key === "href" || key === "src") return;
      if (key === "alt" && (v.trim().length < 5 || GENERIC_ALT_RE.test(v.trim())))
        out.push(issue("weak-alt", "error", v));
      for (const c of copyIssues(v, key === "alt" ? undefined : numbers))
        out.push(issue(c.code, c.severity, c.evidence));
    } else if (Array.isArray(v)) for (const x of v) visit(x, key);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(props, "");
  return out;
}

function issue(
  code: PageLintCode,
  severity: "error" | "warn",
  evidence?: string,
  section?: string,
  message?: string,
): PageLintIssue {
  const message_ru = message ?? (code in MESSAGES ? MESSAGES[code as keyof typeof MESSAGES] : code);
  return {
    code,
    severity,
    message_ru,
    ...(section ? { section } : {}),
    ...(evidence ? { evidence: evidence.slice(0, 160) } : {}),
  };
}

// --------------------------------------------------------------------------------------------------- source rules

const DEFAULT_FONT_RE =
  /\b(?:Inter|Inter Tight|Roboto|Arial|Helvetica(?: Neue)?|system-ui|-apple-system|BlinkMacSystemFont|Segoe UI)\b|\bfont-(?:serif|mono)\b/;
const GRADIENT_RE =
  /(?:^|\s|:)(?:bg-(?:linear|gradient|radial|conic)-|from-|via-)|(?:linear|radial|conic)-gradient\(/;
const PURPLE_STOP_RE = /(?:^|\s|:)(?:from|via|to)-(?:purple|violet|indigo|fuchsia)(?:-\d{2,3})?\b/;

/**
 * The outline a section renders: its distinct heading levels, shallowest first. Source order is not render order — a
 * pattern often builds its item cards (h3) in a variable or a helper above the JSX with its own h2 — so a section is read
 * as «its heading, then the levels under it»: h1 → h3 is still a skip when a section has no h2, h2 → h4 inside one too.
 */
export function sectionOutline(levels: readonly number[]): number[] {
  return [...new Set(levels)].sort((a, b) => a - b);
}

/** Heading levels of a TSX source in source order (h1…h6, motion.h1…). */
export function headingLevels(source: string): number[] {
  const sf = ts.createSourceFile("s.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: number[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const m = /^(?:motion\.|m\.)?h([1-6])$/.exec(n.tagName.getText(sf));
      if (m) out.push(Number(m[1]));
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** String literals and JSX texts of a source (what can be classes or copy). */
function sourceStrings(source: string): { text: string; jsx: boolean }[] {
  const sf = ts.createSourceFile("s.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: { text: string; jsx: boolean }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))
      out.push({ text: n.text, jsx: false });
    else if (ts.isJsxText(n) && !n.containsOnlyTriviaWhiteSpaces)
      out.push({ text: n.getText(sf), jsx: true });
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** A grid of three columns whose children come from a list or are three equal elements (catalog L01). */
function threeCardsInSource(source: string): string | null {
  const sf = ts.createSourceFile("s.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let hit: string | null = null;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isJsxElement(n)) {
      const cls = n.openingElement.attributes.properties.find(
        (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === "className",
      );
      const text = cls?.initializer?.getText(sf) ?? "";
      if (/(?:^|[\s"'`:])grid-cols-3\b/.test(text)) {
        const kids = n.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
        const mapped = kids.some((c) => ts.isJsxExpression(c) && /\.map\(/.test(c.getText(sf)));
        const elems = kids.filter((c) => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c));
        const same =
          elems.length === 3 &&
          new Set(
            elems.map((e) =>
              (ts.isJsxElement(e) ? e.openingElement : (e as ts.JsxSelfClosingElement)).attributes.getText(
                sf,
              ),
            ),
          ).size === 1;
        if (mapped || same) hit = text.slice(0, 120);
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return hit;
}

/** Items of a section's props that look like the «icon + title + text» trio (catalog L01). */
function threeCardsInProps(props: unknown): boolean {
  if (!props || typeof props !== "object") return false;
  for (const v of Object.values(props)) {
    if (!Array.isArray(v) || v.length !== 3) continue;
    const plain = v.every(
      (x) =>
        x &&
        typeof x === "object" &&
        !Array.isArray(x) &&
        Object.keys(x).every((k) => ["icon", "title", "text", "description"].includes(k)) &&
        "title" in x,
    );
    if (plain) return true;
  }
  return false;
}

function purpleAccent(design: DesignSystemV3 | undefined): boolean {
  const p = design ? parseOklch(design.palette.light.accent) : null;
  return !!p && p.c >= 0.06 && p.h >= 265 && p.h <= 330;
}

// --------------------------------------------------------------------------------------------------- page

/** A section as the linter sees it: its code (library pattern or signature) and the content it gets. */
export interface LintSection {
  id: string;
  /** Section type of the library, or «signature» for free code. */
  type: string;
  pattern: string;
  layout?: LayoutFamily;
  source: string;
  props: unknown;
}

export interface LintPageInput {
  sections: readonly LintSection[];
  design?: DesignSystemV3;
  /** Numbers of the facts: every number the page shows must be one of them. */
  numbers?: ReadonlySet<string>;
  /** Routes of the site (internal links must lead to one of them). */
  routes?: readonly string[];
  /** Ids of the sections of the home page (links «/#id»). */
  homeAnchors?: readonly string[];
}

const CHROME = new Set(["header", "footer"]);
const RESERVED_ROUTES = ["/login", "/privacy"];

function linkProblems(props: unknown, input: LintPageInput, anchors: Set<string>): string[] {
  if (!input.routes) return [];
  const routes = new Set([...input.routes, ...RESERVED_ROUTES]);
  const home = new Set(input.homeAnchors ?? []);
  const out: string[] = [];
  const visit = (v: unknown, key: string): void => {
    if (typeof v === "string" && key === "href") {
      if (v.startsWith("#") && !anchors.has(v.slice(1))) out.push(v);
      else if (v.startsWith("/")) {
        const [full = "", hash] = v.split("#");
        // A query names the same page (/login?next=/me, V3-18).
        const path = full.split("?")[0] ?? "";
        if (!routes.has(path || "/")) out.push(v);
        else if (hash && path === "/" && !home.has(hash)) out.push(v);
      }
    } else if (Array.isArray(v)) for (const x of v) visit(x, key);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(props, "");
  return out;
}

/**
 * Lint of a page: every section (library or signature) and the page as a whole. Library patterns are trusted for
 * their code (the ui-kit CI lints them); signature sections get lintPattern and the source rules.
 */
export function lintPage(input: LintPageInput): PageLintIssue[] {
  const out: PageLintIssue[] = [];
  const anchors = new Set(input.sections.map((s) => s.id));
  if (input.design) {
    for (const f of [input.design.fonts.display.family, input.design.fonts.text.family])
      if (FORBIDDEN_FONTS.has(f)) out.push(issue("default-font", "error", f));
  }
  const purple = purpleAccent(input.design);
  /** Heading outline of the page: per section its distinct levels, shallowest first (see sectionOutline). */
  const levels: number[] = [];
  let h1 = 0;
  let prev: LintSection | undefined;
  for (const s of input.sections) {
    const signature = s.type === "signature";
    if (signature) {
      for (const p of lintPattern(s.source, `${s.id}.tsx`))
        out.push(
          issue(p.code, PATTERN_ERRORS.has(p.code) ? "error" : "warn", p.evidence, s.id, p.message_ru),
        );
      for (const str of sourceStrings(s.source)) {
        if (!str.jsx && DEFAULT_FONT_RE.test(str.text))
          out.push(issue("default-font", "error", str.text, s.id));
        if (!str.jsx && PURPLE_STOP_RE.test(str.text))
          out.push(issue("purple-gradient", "error", str.text, s.id));
        else if (!str.jsx && purple && GRADIENT_RE.test(str.text))
          out.push(issue("purple-gradient", "error", str.text, s.id));
        // Copy is what the visitor reads: JSX text and Russian strings (classes and prop names are ASCII).
        if (str.jsx || /[а-яё]/i.test(str.text))
          for (const c of copyIssues(str.text, input.numbers))
            out.push(issue(c.code, c.severity, c.evidence, s.id));
      }
      const cards = threeCardsInSource(s.source);
      if (cards) out.push(issue("three-cards", "error", cards, s.id));
    }
    for (const c of propsIssues(s.props, input.numbers)) out.push({ ...c, section: s.id });
    if (threeCardsInProps(s.props) && (signature || ["card", "grid", "columns"].includes(s.layout ?? "")))
      out.push(issue("three-cards", "error", s.pattern, s.id));
    for (const l of linkProblems(s.props, input, anchors)) out.push(issue("broken-link", "error", l, s.id));
    if (
      prev &&
      !CHROME.has(s.type) &&
      !CHROME.has(prev.type) &&
      s.layout &&
      prev.layout === s.layout &&
      !signature
    )
      out.push(issue("layout-repeat", "error", `${prev.pattern} → ${s.pattern}`, s.id));
    const own = headingLevels(s.source);
    // A section whose content sets `level` (rubric-*, V3-24) draws its heading at that level with a dynamic tag and
    // its items one level below.
    const level = (s.props as { level?: unknown } | null)?.level;
    if (level === 1 || level === 2) own.push(level, level + 1);
    h1 += own.filter((l) => l === 1).length;
    levels.push(...sectionOutline(own));
    prev = s;
  }
  if (h1 === 0) out.push(issue("no-h1", "error"));
  if (h1 > 1) out.push(issue("multiple-h1", "error", `${h1} h1`));
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1] as number;
    const b = levels[i] as number;
    if (b > a + 1) out.push(issue("heading-order", "error", `h${a} → h${b}`));
  }
  return out;
}

/** Errors only. */
export const lintErrors = (issues: readonly PageLintIssue[]): PageLintIssue[] =>
  issues.filter((i) => i.severity === "error");
