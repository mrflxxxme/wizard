// wz-id injection (specs/ui/ui-kit.yaml#wz_id): every JSX element imported from @wizard/ui-kit gets
// wzId="<fileKey>:<ordinal>"; the map entry {file, line, componentName} goes to wz-map.json. A v3 system's copies of
// the ui-kit pattern library (ui/patterns/<id>.tsx, builder-v3.md C3) count as ui-kit too: the sections a page file
// imports from there get the prop the same way (their roots carry data-wz-component and data-wz-id).
import ts from "typescript";
import { sha256Hex } from "./hash.js";

export const UI_KIT = "@wizard/ui-kit";
/** Folder of the v3 pattern library copied into a system (the composer's page files import their sections from it). */
export const PATTERNS_DIR = "ui/patterns/";

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
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    // v3: the default import of a pattern of the system's library (ui/patterns/<id>) — the section component.
    if (spec.startsWith(".") && resolveRelative(file, spec).startsWith(PATTERNS_DIR)) {
      const local = st.importClause?.isTypeOnly ? undefined : st.importClause?.name?.text;
      if (local) named.set(local, local);
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
  return { named, namespaces };
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
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const kit = collectKitImports(sf, file);
  const entries: Array<[string, WzEntry]> = [];
  if (kit.named.size === 0 && kit.namespaces.size === 0) return { code: source, entries };
  const key = fileKey(file);
  const inserts: Array<{ at: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = componentName(node.tagName, kit);
      if (name) {
        const id = `${key}:${entries.length + 1}`;
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        entries.push([id, { file, line, componentName: name }]);
        inserts.push({ at: node.attributes.end, text: ` wzId="${id}"` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  let code = source;
  for (const ins of [...inserts].sort((a, b) => b.at - a.at)) {
    code = code.slice(0, ins.at) + ins.text + code.slice(ins.at);
  }
  return { code, entries };
}
