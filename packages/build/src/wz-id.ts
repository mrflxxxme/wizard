// wz-id injection (specs/ui/ui-kit.yaml#wz_id): every JSX element imported from @wizard/ui-kit gets
// wzId="<fileKey>:<ordinal>"; the map entry {file, line, componentName} goes to wz-map.json. A v3 system's copies of
// the ui-kit pattern library (ui/patterns/<id>.tsx, builder-v3.md C3) count as ui-kit too: the sections a page file
// imports from there get the prop the same way (their roots carry data-wz-component and data-wz-id). The sections the
// model wrote as code (ui/sections/<page>-<id>.tsx, V4-06) know nothing of wzId: their element is wrapped in a div that
// carries both attributes, so the owner can point at them and tell their texts apart.
import ts from "typescript";
import { sha256Hex } from "./hash.js";

export const UI_KIT = "@wizard/ui-kit";
/** Folder of the v3 pattern library copied into a system (the composer's page files import their sections from it). */
export const PATTERNS_DIR = "ui/patterns/";
/** Folder of the v3 sections written as code (V4-06): their elements are wrapped, not given the prop. */
export const SECTIONS_DIR = "ui/sections/";

export interface WzEntry {
  file: string;
  line: number;
  componentName: string;
}
export type WzMap = Record<string, WzEntry>;

/** First 8 hex of sha256 of the system-relative path, e.g. "ui/Landing.tsx". */
export function fileKey(file: string): string {
  return sha256Hex(file).slice(0, 8);
}

interface KitImports {
  named: Map<string, string>; // local name -> exported name
  namespaces: Set<string>;
  /** Local names of the sections written as code (wrapped). */
  sections: Set<string>;
}

/** A relative import of a system file resolved against the importing file («ui/pages/site» + «../../patterns/x»). */
function resolveRelative(file: string, spec: string): string {
  const out = file.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
  }
  return out.join("/");
}

function collectKitImports(sf: ts.SourceFile, file: string): KitImports {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  const sections = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    // v3: the default import of a pattern of the system's library (ui/patterns/<id>) — the section component; of a
    // section written as code (ui/sections/<page>-<id>) — wrapped.
    const local = st.importClause?.isTypeOnly ? undefined : st.importClause?.name?.text;
    const target = spec.startsWith(".") ? resolveRelative(file, spec) : "";
    if (target.startsWith(PATTERNS_DIR) || target.startsWith(SECTIONS_DIR)) {
      if (local) named.set(local, local);
      if (local && target.startsWith(SECTIONS_DIR)) sections.add(local);
      continue;
    }
    if (spec !== UI_KIT) continue;
    const clause = st.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (el.isTypeOnly) continue;
        named.set(el.name.text, (el.propertyName ?? el.name).text);
      }
    }
  }
  return { named, namespaces, sections };
}

/** "AppShell.Login" for `<AppShell.Login>`, "Button" for `<Kit.Button>`; null if not from ui-kit. */
function componentName(tag: ts.JsxTagNameExpression, kit: KitImports): string | null {
  const parts: string[] = [];
  let cur: ts.Node = tag;
  while (ts.isPropertyAccessExpression(cur)) {
    parts.unshift(cur.name.text);
    cur = cur.expression;
  }
  if (!ts.isIdentifier(cur)) return null;
  const root = cur.text;
  const imported = kit.named.get(root);
  if (imported !== undefined) return [imported, ...parts].join(".");
  if (kit.namespaces.has(root) && parts.length > 0) return parts.join(".");
  return null;
}

export interface WzTransform {
  code: string;
  entries: Array<[string, WzEntry]>;
}

/**
 * Pure per-file transform: the result depends only on (file, source), so editing another file never
 * changes wzIds here. The prop goes after all attributes, overriding a hand-written wzId or spread.
 */
export function injectWzIds(file: string, source: string): WzTransform {
  const elements = kitElements(file, source);
  const entries: Array<[string, WzEntry]> = elements.map((e) => [e.id, e.entry]);
  // Insertions from the end of the file, so the offsets before each stay valid.
  const edits: Array<{ at: number; text: string }> = [];
  for (const e of elements) {
    if (e.wrap) {
      const name = e.entry.componentName;
      edits.push({ at: e.start, text: `<div data-wz-component="${name}" data-wz-id="${e.id}">` });
      edits.push({ at: e.end, text: "</div>" });
    } else edits.push({ at: e.attrsEnd, text: ` wzId="${e.id}"` });
  }
  let code = source;
  for (const ed of edits.sort((a, b) => b.at - a.at))
    code = `${code.slice(0, ed.at)}${ed.text}${code.slice(ed.at)}`;
  return { code, entries };
}

/** A ui-kit or pattern JSX element of a file with its wzId and source range (the whole element, children included). */
export interface KitElement {
  id: string;
  entry: WzEntry;
  start: number;
  end: number;
  /** Where injectWzIds writes the prop: the end of the element's attributes. */
  attrsEnd: number;
  /** A section written as code: wrapped in a div with data-wz-component and data-wz-id instead of the prop. */
  wrap?: boolean;
}

/** The ui-kit and pattern elements of a file in document order — the ordinals of their wzIds. */
export function kitElements(file: string, source: string): KitElement[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const kit = collectKitImports(sf, file);
  const out: KitElement[] = [];
  if (kit.named.size === 0 && kit.namespaces.size === 0) return out;
  const key = fileKey(file);
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = componentName(node.tagName, kit);
      if (name) {
        const whole = ts.isJsxOpeningElement(node) ? node.parent : node;
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        out.push({
          id: `${key}:${out.length + 1}`,
          entry: { file, line, componentName: name },
          start: whole.getStart(sf),
          end: whole.getEnd(),
          attrsEnd: node.attributes.end,
          ...(ts.isIdentifier(node.tagName) && kit.sections.has(node.tagName.text) ? { wrap: true } : {}),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
