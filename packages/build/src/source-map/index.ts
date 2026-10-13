// V4-15 (D79 (9), правки в три слоя): the texts and images of a system's public pages mapped to their source — the
// string literal in ui/**.tsx (a pattern's props written by the composer, or free TSX of V4-06). A draft build carries
// the map (source-map.json, served as /_wizard/source-map.json) and marks the elements of free TSX statically with
// data-wz-src; the preview bridge finds the elements a pattern renders from a literal by its value. An instant edit
// replaces one literal in its file — no model, the file stays valid TSX.
import ts from "typescript";
import { fileKey, kitElements, PATTERNS_DIR } from "../wz-id.js";

export type LiteralKind = "text" | "image" | "alt";

/** How the literal is written: a JS string ("…" or '…'), a JSX attribute string, or JSX text between tags. */
export type LiteralForm = "string" | "attribute" | "jsx-text";

export interface SourceLiteral {
  /** `<fileKey>:<start>` — stable within one revision of the file. */
  ref: string;
  file: string;
  /** Range of the literal in the file (quotes included for strings; the trimmed text for JSX text). */
  start: number;
  end: number;
  kind: LiteralKind;
  form: LiteralForm;
  value: string;
  /**
   * wzId of the innermost ui-kit or pattern element holding the literal (a prop or a child): the bridge tells apart
   * literals of the same value by the data-wz-id of the element shown.
   */
  wz?: string;
}

export type SourceMap = Record<string, SourceLiteral>;

/** Keys whose strings are never shown as text (links, data bindings, layout). */
const HIDDEN_KEYS = new Set([
  "href",
  "path",
  "route",
  "entity",
  "id",
  "pattern",
  "kind",
  "type",
  "anchor",
  "mime",
  "file",
  "icon",
  "variant",
  "layout",
  "module",
  "field",
  "role",
  "className",
  "class",
  "style",
  "target",
  "rel",
  "key",
  "slot",
  "data-testid",
  "lang",
  "loading",
  "decoding",
  "width",
  "height",
  "sizes",
  "srcSet",
  "srcset",
]);
const IMAGE_KEYS = new Set(["src", "image", "photo", "poster"]);
const URLISH = /^(?:\/|#|https?:|tel:|mailto:|data:)/;
const IMAGE_URL = /^(?:\/_wizard\/photos\/|\/api\/files\/|https?:\/\/)/;
const VISIBLE = /\p{L}/u;

/** The files of a system whose literals are mapped: page and component sources, not the copied pattern library. */
export const isMappedFile = (path: string): boolean =>
  path.startsWith("ui/") && path.endsWith(".tsx") && !path.startsWith(PATTERNS_DIR);

function keyOf(node: ts.Node): string | null {
  const p = node.parent;
  if (p && ts.isPropertyAssignment(p) && p.initializer === node) {
    const n = p.name;
    return ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null;
  }
  if (p && ts.isJsxAttribute(p)) return p.name.getText();
  return null;
}

/** Inside JSX: a JSX child, attribute, or any expression nested in a JSX expression or spread. */
function inJsx(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isJsxExpression(cur) || ts.isJsxAttribute(cur) || ts.isJsxSpreadAttribute(cur)) return true;
    if (ts.isJsxElement(cur) || ts.isJsxSelfClosingElement(cur) || ts.isJsxFragment(cur)) return true;
    if (ts.isFunctionLike(cur) && !ts.isArrowFunction(cur)) return false;
  }
  return false;
}

function classify(key: string | null, value: string): LiteralKind | null {
  if (key === "alt") return VISIBLE.test(value) ? "alt" : null;
  if (key !== null && IMAGE_KEYS.has(key)) return IMAGE_URL.test(value) ? "image" : null;
  if (key !== null && HIDDEN_KEYS.has(key)) return null;
  if (URLISH.test(value) || !VISIBLE.test(value)) return null;
  return "text";
}

/** The mapped literals of one file. */
export function fileLiterals(file: string, source: string): SourceLiteral[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const k = fileKey(file);
  const out: SourceLiteral[] = [];
  const push = (start: number, end: number, kind: LiteralKind, form: LiteralForm, value: string) =>
    out.push({ ref: `${k}:${start}`, file, start, end, kind, form, value });
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const raw = node.getText();
      const trimmed = raw.trim();
      if (trimmed && VISIBLE.test(trimmed)) {
        const start = node.getStart() + raw.indexOf(trimmed);
        push(start, start + trimmed.length, "text", "jsx-text", trimmed.replace(/\s+/g, " "));
      }
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const isKey = ts.isPropertyAssignment(node.parent) && node.parent.name === node;
      if (!isKey && inJsx(node)) {
        const kind = classify(keyOf(node), node.text);
        if (kind) {
          const form: LiteralForm = ts.isJsxAttribute(node.parent) ? "attribute" : "string";
          push(node.getStart(), node.getEnd(), kind, form, node.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const elements = kitElements(file, source);
  for (const l of out) {
    let best: (typeof elements)[number] | undefined;
    for (const e of elements) {
      if (e.start <= l.start && l.end <= e.end && (!best || e.end - e.start < best.end - best.start))
        best = e;
    }
    if (best) l.wz = best.id;
  }
  return out;
}

/** The source map of a system: every mapped literal of its ui/**.tsx files. */
export function buildSourceMap(files: ReadonlyMap<string, string>): SourceMap {
  const map: SourceMap = {};
  for (const [file, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!isMappedFile(file)) continue;
    for (const l of fileLiterals(file, text)) map[l.ref] = l;
  }
  return map;
}

/**
 * Free TSX (V4-06): an intrinsic element with mapped text children or a mapped src/alt attribute gets
 * data-wz-src="<ref> <ref>…" right after its tag name (the same line: wz-map lines stay true).
 */
export function annotateSource(file: string, source: string): string {
  const literals = fileLiterals(file, source);
  if (!literals.length) return source;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const byStart = new Map(literals.map((l) => [l.start, l]));
  const inserts: { at: number; text: string }[] = [];
  const refsIn = (nodes: readonly ts.Node[]): string[] =>
    nodes.flatMap((n) =>
      literals.filter((l) => l.start >= n.getStart() && l.end <= n.getEnd()).map((l) => l.ref),
    );
  const visit = (node: ts.Node) => {
    const open = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (open && ts.isIdentifier(open.tagName) && /^[a-z]/.test(open.tagName.text)) {
      const own: string[] = [];
      if (ts.isJsxElement(node)) {
        // Direct text children: JSX text and {"literal"}.
        const direct = node.children.filter(
          (c) =>
            ts.isJsxText(c) ||
            (ts.isJsxExpression(c) && c.expression !== undefined && ts.isStringLiteral(c.expression)),
        );
        own.push(...refsIn(direct));
      }
      for (const a of open.attributes.properties) {
        if (!ts.isJsxAttribute(a) || !a.initializer) continue;
        const name = a.name.getText();
        if (name !== "src" && name !== "alt") continue;
        const lit = ts.isStringLiteral(a.initializer)
          ? a.initializer
          : ts.isJsxExpression(a.initializer) &&
              a.initializer.expression &&
              ts.isStringLiteral(a.initializer.expression)
            ? a.initializer.expression
            : null;
        const l = lit ? byStart.get(lit.getStart()) : undefined;
        if (l) own.push(l.ref);
      }
      const already = open.attributes.properties.some(
        (a) => ts.isJsxAttribute(a) && a.name.getText() === "data-wz-src",
      );
      if (own.length && !already)
        inserts.push({ at: open.tagName.getEnd(), text: ` data-wz-src="${own.join(" ")}"` });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  let out = source;
  for (const i of inserts.sort((a, b) => b.at - a.at)) out = out.slice(0, i.at) + i.text + out.slice(i.at);
  return out;
}

export interface LiteralEdit {
  ref: string;
  value: string;
}

export type EditOutcome =
  | { ok: true; files: Map<string, string> }
  | { ok: false; code: "UNKNOWN_REF" | "INVALID_VALUE"; ref: string; message: string };

/** Max length of a text or image path after an instant edit. */
export const LITERAL_MAX = 500;

function written(l: SourceLiteral, value: string): string {
  if (l.form === "string") return JSON.stringify(value);
  if (l.form === "attribute") return /["{}<>&]/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`;
  return /[{}<>]/.test(value) ? `{${JSON.stringify(value)}}` : value;
}

/**
 * Applies instant edits to the files (each ref of the given source map); returns the changed files. A text must be
 * non-empty, one line and ≤ 500 characters; an image a photo of the library (/_wizard/photos/…, /api/files/…).
 */
export function applyLiteralEdits(
  files: ReadonlyMap<string, string>,
  edits: readonly LiteralEdit[],
): EditOutcome {
  const map = buildSourceMap(files);
  const byFile = new Map<string, { l: SourceLiteral; value: string }[]>();
  for (const e of edits) {
    const l = map[e.ref];
    if (!l)
      return {
        ok: false,
        code: "UNKNOWN_REF",
        ref: e.ref,
        message: "Элемента нет в этой версии — обновите превью",
      };
    const v = l.kind === "image" ? e.value.trim() : e.value.replace(/\s+/g, " ").trim();
    if (!v || v.length > LITERAL_MAX)
      return {
        ok: false,
        code: "INVALID_VALUE",
        ref: e.ref,
        message: `Текст должен быть от 1 до ${LITERAL_MAX} символов`,
      };
    if (l.kind === "image" && !/^\/(?:_wizard\/photos|api\/files)\/[0-9a-f-]{36}(?:\/[\w.-]+)*$/.test(v))
      return {
        ok: false,
        code: "INVALID_VALUE",
        ref: e.ref,
        message: "Фото можно выбрать только из библиотеки системы",
      };
    const list = byFile.get(l.file) ?? [];
    list.push({ l, value: v });
    byFile.set(l.file, list);
  }
  const out = new Map<string, string>();
  for (const [file, list] of byFile) {
    let text = files.get(file) as string;
    for (const { l, value } of list.sort((a, b) => b.l.start - a.l.start))
      text = text.slice(0, l.start) + written(l, value) + text.slice(l.end);
    out.set(file, text);
  }
  return { ok: true, files: out };
}
