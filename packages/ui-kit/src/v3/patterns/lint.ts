// lintPattern: the rules a pattern (and later a signature section) must keep before it is copied into a system —
// theme colours and fonts only, allowed imports only, no invented facts, accessible images, buttons and links,
// motion that respects prefers-reduced-motion (builder-v3.md C3, catalog B, D49).
import ts from "typescript";
import { forbiddenSourceIn } from "./origins.js";
import { PATTERN_THEME } from "./theme.js";

export type PatternLintCode =
  | "import"
  | "dynamic-code"
  | "default-export"
  | "arbitrary-color"
  | "arbitrary-font"
  | "palette"
  | "raw-color"
  | "inline-style"
  | "slop"
  | "fabricated"
  | "img-alt"
  | "button-type"
  | "button-name"
  | "link-href"
  | "link-name"
  | "link-color"
  | "click-target"
  | "reduced-motion"
  | "motion-lazy"
  | "forbidden-source";

export interface PatternLintIssue {
  code: PatternLintCode;
  message_ru: string;
  line: number;
  evidence: string;
}

/** Bare imports a pattern may use (C3); siblings ("./x") are allowed too. */
export const PATTERN_IMPORTS = ["react", "motion/react", "@wizard/ui-kit/v3/headless"] as const;

const VARIANTS = String.raw`(?:[\w-]+(?:\[[^\]]*\])?:)*!?-?`;
const COLOR_UTILS =
  "text|bg|border(?:-[xytrblse])?|ring|ring-offset|outline|fill|stroke|from|via|to|decoration|divide|placeholder|caret|accent|shadow|inset-shadow|drop-shadow|inset-ring";
// Arbitrary value or CSS variable on a colour or text utility: text-[#fff], bg-(--x), text-[15px], from-[oklch(…)].
const ARBITRARY_COLOR_RE = new RegExp(
  String.raw`^${VARIANTS}(?:text|bg|from|via|to|fill|stroke|caret|accent|decoration|placeholder|shadow|inset-shadow|drop-shadow)-[\[(]`,
);
// Arbitrary colour on width-or-colour utilities: border-[#ccc], ring-[rgb(…)] (border-[3px] stays allowed).
const ARBITRARY_LINE_COLOR_RE = new RegExp(
  String.raw`^${VARIANTS}(?:border(?:-[xytrblse])?|ring|outline|divide)-[\[(](?:#|rgb|hsl|oklch|oklab|lab|lch|color|var|--)`,
);
const ARBITRARY_PROPERTY_RE =
  /^(?:[\w-]+:)*!?\[(?:color|background|font|fill|stroke|border-color|outline-color)[\w-]*:/;
const ARBITRARY_FONT_RE = new RegExp(String.raw`^${VARIANTS}font-[\[(]`);
const PALETTE =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|taupe|mauve|mist|olive|black|white";
const PALETTE_RE = new RegExp(
  String.raw`^${VARIANTS}(?:${COLOR_UTILS})-(?:${PALETTE})(?:-\d{2,3})?(?:\/\d+)?$`,
);
const RAW_COLOR_RE =
  /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/;
const SLOP_RE = /^(?:[\w-]+:)*(?:bg-clip-text|text-transparent|animate-(?:ping|pulse|bounce|spin)|marquee)$/;
const STYLE_PROP_RE = /color|background|fill|stroke|font|shadow/i;
// Invented facts and placeholder copy (catalog K02–K04, D49): content comes from the brief through slots.
const FABRICATED_RE =
  /более\s+\d|\d+\s*\+?\s*(?:довольных\s+)?(?:клиент|покупател|гост|отзыв)|№\s?1\b|лучш(?:ий|ая|ее|ие)(?![а-яё])|сам(?:ый|ая|ое|ые)\s+(?:лучш|популяр|надёжн|надежн)|гарантир|lorem|ipsum|иван\s+иванов|ромашк|★/i;
// A base (no variant) text colour of the theme on a link: the ui-kit document rule colours bare links otherwise.
const LINK_COLOR_RE = new RegExp(
  String.raw`^!?text-(?:inherit|current|${PATTERN_THEME.color.join("|")})(?:\/\d+)?$`,
);
const NON_INTERACTIVE = new Set([
  "div",
  "span",
  "p",
  "li",
  "ul",
  "section",
  "article",
  "img",
  "header",
  "footer",
]);
const MOTION_PROPS = new Set([
  "animate",
  "initial",
  "exit",
  "whileInView",
  "whileHover",
  "whileTap",
  "transition",
]);

const MESSAGES: Record<PatternLintCode, string> = {
  import:
    "Импорт вне списка: паттерн импортирует только react, motion/react, @wizard/ui-kit/v3/headless и свои файлы",
  "dynamic-code":
    "Динамический код запрещён (import(), require, eval, new Function, dangerouslySetInnerHTML)",
  "default-export": "Паттерн экспортирует компонент по умолчанию (export default function …)",
  "arbitrary-color": "Произвольный цвет или кегль: только цвета и ступени шкалы темы (bg-primary, text-h2)",
  "arbitrary-font": "Произвольный шрифт: только шрифты темы (font-display, font-sans)",
  palette: "Цвет палитры Tailwind по умолчанию: только цвета темы (bg-background, text-muted-foreground)",
  "raw-color": "Цвет значением (#hex, rgb(), oklch()): только цвета темы",
  "inline-style": "Цвет, фон или шрифт в style: только классы темы",
  slop: "Приём из анти-слопа: градиентный текст, пульсация, бегущая строка (каталог C04, M06, M07)",
  fabricated: "Текст с фактами или рыбой в коде паттерна: тексты и числа приходят из брифа через слоты (D49)",
  "img-alt": "У изображения нет alt (пустой alt — только у декоративных с aria-hidden)",
  "button-type": "У кнопки нет type",
  "button-name": "У кнопки нет текста или aria-label",
  "link-href": "У ссылки нет адреса (или он «#», javascript:)",
  "link-name": "У ссылки нет текста или aria-label",
  "link-color":
    "Цвет ссылки не задан: платформа красит ссылки без класса цвета, задайте text-* темы, text-inherit или text-current",
  "click-target": "onClick на неинтерактивном элементе: используйте button или a",
  "reduced-motion": "Анимация Motion без учёта prefers-reduced-motion (useReducedMotion или MotionConfig)",
  "motion-lazy":
    "Motion — только m.* внутри <LazyMotion features={domAnimation}>: полный motion.* тянет в бандл сайта проекцию, раскладку и перетаскивание",
  "forbidden-source": "Упоминание запрещённого источника (Tailwind Plus, Aceternity, Magic UI Pro, GSAP)",
};

function tagName(n: ts.JsxTagNameExpression): string {
  return n.getText();
}

function attrs(el: ts.JsxOpeningLikeElement): Map<string, ts.JsxAttribute> {
  const out = new Map<string, ts.JsxAttribute>();
  for (const a of el.attributes.properties) if (ts.isJsxAttribute(a)) out.set(a.name.getText(), a);
  return out;
}

function hasSpread(el: ts.JsxOpeningLikeElement): boolean {
  return el.attributes.properties.some((a) => ts.isJsxSpreadAttribute(a));
}

function stringValue(a: ts.JsxAttribute | undefined): string | undefined {
  const init = a?.initializer;
  if (!init) return undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression))
    return init.expression.text;
  return undefined;
}

function hasChildren(el: ts.JsxOpeningLikeElement): boolean {
  if (!ts.isJsxOpeningElement(el)) return false;
  const parent = el.parent;
  return parent.children.some((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
}

/** String constants of the file (`const fooClass = "…"`): class strings shared by several elements. */
function stringConstants(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isStringLiteralLike(n.initializer)
    )
      out.set(n.name.text, n.initializer.text);
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** Class tokens an attribute can produce: its string literals and the string constants it names. */
function classTokens(a: ts.JsxAttribute | undefined, consts: Map<string, string>): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))
      out.push(...n.text.split(/\s+/));
    else if (ts.isIdentifier(n) && consts.has(n.text)) out.push(...(consts.get(n.text) ?? "").split(/\s+/));
    n.forEachChild(visit);
  };
  if (a?.initializer) visit(a.initializer);
  return out.filter(Boolean);
}

/** Problems of a pattern's TSX; an empty list — the pattern may be copied into a system. */
export function lintPattern(source: string, file = "pattern.tsx"): PatternLintIssue[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const consts = stringConstants(sf);
  const out: PatternLintIssue[] = [];
  const add = (code: PatternLintCode, node: ts.Node, evidence: string) =>
    out.push({
      code,
      message_ru: MESSAGES[code],
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      evidence: evidence.slice(0, 120),
    });

  let defaultExport = false;
  let usesMotionProps = false;
  let fullMotion: ts.Node | null = null;
  let lazyElements = false;
  const motionImported = /from\s+["']motion\/react["']/.test(source);
  const reducedHandled = /\buseReducedMotion\b|\bMotionConfig\b/.test(source);

  const checkText = (node: ts.Node, text: string) => {
    if (FABRICATED_RE.test(text)) add("fabricated", node, text);
    if (RAW_COLOR_RE.test(text)) add("raw-color", node, text);
    for (const tok of text.split(/\s+/)) {
      if (!tok) continue;
      if (ARBITRARY_FONT_RE.test(tok)) add("arbitrary-font", node, tok);
      else if (
        ARBITRARY_COLOR_RE.test(tok) ||
        ARBITRARY_LINE_COLOR_RE.test(tok) ||
        ARBITRARY_PROPERTY_RE.test(tok)
      )
        add("arbitrary-color", node, tok);
      else if (PALETTE_RE.test(tok)) add("palette", node, tok);
      else if (SLOP_RE.test(tok)) add("slop", node, tok);
    }
  };

  const checkElement = (el: ts.JsxOpeningLikeElement) => {
    const name = tagName(el.tagName);
    // motion.div and m.div (LazyMotion) are the same element for the rules.
    const base = name.replace(/^(?:motion|m)\./, "");
    const a = attrs(el);
    const spread = hasSpread(el);
    const named = a.has("aria-label") || a.has("aria-labelledby") || hasChildren(el);
    if (base === "img" && !spread) {
      const alt = a.get("alt");
      if (!alt) add("img-alt", el, name);
      else if (
        stringValue(alt) === "" &&
        stringValue(a.get("aria-hidden")) !== "true" &&
        !a.has("aria-hidden")
      )
        add("img-alt", el, `${name} alt=""`);
    }
    if (base === "button" && !spread) {
      if (!a.has("type")) add("button-type", el, name);
      if (!named) add("button-name", el, name);
    }
    if (base === "a" && !spread) {
      const href = a.get("href");
      const v = stringValue(href);
      if (!href || v === "#" || v === "" || v?.startsWith("javascript:"))
        add("link-href", el, `${name} href`);
      if (!named) add("link-name", el, name);
      if (!classTokens(a.get("className"), consts).some((t) => LINK_COLOR_RE.test(t)))
        add("link-color", el, name);
    }
    if (NON_INTERACTIVE.has(base) && a.has("onClick")) add("click-target", el, `${name} onClick`);
    const style = a.get("style")?.initializer;
    if (
      style &&
      ts.isJsxExpression(style) &&
      style.expression &&
      ts.isObjectLiteralExpression(style.expression)
    ) {
      for (const p of style.expression.properties)
        if (p.name && STYLE_PROP_RE.test(p.name.getText())) add("inline-style", p, p.getText());
    }
    for (const k of a.keys()) if (MOTION_PROPS.has(k) && base !== name) usesMotionProps = true;
    if (name.startsWith("motion.")) fullMotion ??= el;
    if (name.startsWith("m.")) lazyElements = true;
  };

  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      const spec = n.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) {
        const s = spec.text;
        const sibling = s.startsWith("./") && !s.includes("..");
        if (!sibling && !(PATTERN_IMPORTS as readonly string[]).includes(s)) add("import", n, s);
      }
      if (ts.isExportDeclaration(n)) n.forEachChild(visit);
      if (ts.isImportDeclaration(n)) return;
    }
    if (ts.isExportAssignment(n) && !n.isExportEquals) defaultExport = true;
    if (
      (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) &&
      n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    )
      defaultExport = true;
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword || callee === "require" || callee === "eval")
        add("dynamic-code", n, callee);
    }
    if (ts.isNewExpression(n) && n.expression.getText(sf) === "Function")
      add("dynamic-code", n, "new Function");
    if (ts.isJsxAttribute(n) && n.name.getText(sf) === "dangerouslySetInnerHTML")
      add("dynamic-code", n, "dangerouslySetInnerHTML");
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) checkElement(n);
    if (ts.isJsxText(n) && !n.containsOnlyTriviaWhiteSpaces) {
      const t = n.getText(sf);
      if (/\d/.test(t)) add("fabricated", n, t.trim());
      else if (FABRICATED_RE.test(t)) add("fabricated", n, t.trim());
    }
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    )
      checkText(n, n.text);
    n.forEachChild(visit);
  };
  visit(sf);

  if (!defaultExport) add("default-export", sf, file);
  if (motionImported && usesMotionProps && !reducedHandled) add("reduced-motion", sf, "motion/react");
  // Bundle size of the site (V3-12): the full motion component brings layout projection and drag along.
  if (fullMotion) add("motion-lazy", fullMotion, "motion.*");
  else if (lazyElements && !/<LazyMotion\b/.test(source)) add("motion-lazy", sf, "m.* без LazyMotion");
  const forbidden = forbiddenSourceIn(source);
  if (forbidden) add("forbidden-source", sf, forbidden.id);
  return out;
}
