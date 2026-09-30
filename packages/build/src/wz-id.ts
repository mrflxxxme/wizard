// wz-id injection (specs/ui/ui-kit.yaml#wz_id): every JSX element imported from @wizard/ui-kit gets
// wzId="<fileKey>:<ordinal>"; the map entry {file, line, componentName} goes to wz-map.json.
import ts from "typescript";
import { sha256Hex } from "./hash.js";

export const UI_KIT = "@wizard/ui-kit";

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

function collectKitImports(sf: ts.SourceFile): KitImports {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (st.moduleSpecifier.text !== UI_KIT) continue;
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
  const kit = collectKitImports(sf);
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
