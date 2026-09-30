// Shared AST layer for G0: every system file is parsed once (TypeScript parser, no type-check).
import { posix } from "node:path";
import ts from "typescript";

export type Area = "ui" | "functions";

export interface SourceInfo {
  path: string;
  area: Area;
  text: string;
  sf: ts.SourceFile;
  /** Every name declared anywhere in the file (variables, params, functions, imports…). */
  declared: ReadonlySet<string>;
  /** Local binding → imported name, for imports from @wizard/sdk. */
  sdkImports: ReadonlyMap<string, string>;
  imports: ImportRef[];
}

export interface ImportRef {
  specifier: string;
  line: number;
  kind: "import" | "export" | "import-equals" | "import-type" | "reference";
  hasAttributes: boolean;
}

const AREA_RE = /^(ui|functions)\//;

export function areaOf(path: string): Area | null {
  const m = AREA_RE.exec(path);
  return m ? (m[1] as Area) : null;
}

export function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

export function nodeLine(node: ts.Node): number {
  const sf = node.getSourceFile();
  return lineOf(sf, node.getStart(sf));
}

export function snippet(node: ts.Node, max = 160): string {
  const t = node.getText().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function collectDeclared(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const addName = (n: ts.BindingName | ts.Identifier | undefined) => {
    if (!n) return;
    if (ts.isIdentifier(n)) out.add(n.text);
    else for (const el of n.elements) if (!ts.isOmittedExpression(el)) addName(el.name);
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isBindingElement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isImportClause(node) ||
      ts.isImportSpecifier(node) ||
      ts.isNamespaceImport(node) ||
      ts.isEnumDeclaration(node)
    ) {
      addName(node.name as ts.BindingName | undefined);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function collectImports(sf: ts.SourceFile): { imports: ImportRef[]; sdk: Map<string, string> } {
  const imports: ImportRef[] = [];
  const sdk = new Map<string, string>();
  const add = (spec: ts.Expression | undefined, node: ts.Node, kind: ImportRef["kind"], attrs: boolean) => {
    if (!spec) return;
    const specifier = ts.isStringLiteralLike(spec) ? spec.text : spec.getText(sf);
    imports.push({ specifier, line: lineOf(sf, node.getStart(sf)), kind, hasAttributes: attrs });
  };
  for (const r of [...sf.referencedFiles, ...sf.typeReferenceDirectives, ...sf.libReferenceDirectives]) {
    imports.push({ specifier: r.fileName, line: lineOf(sf, r.pos), kind: "reference", hasAttributes: false });
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier, node, "import", node.attributes !== undefined);
      const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
      const bindings = node.importClause?.namedBindings;
      if (spec === "@wizard/sdk" && bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) sdk.set(el.name.text, (el.propertyName ?? el.name).text);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node.moduleSpecifier, node, "export", node.attributes !== undefined);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, node, "import-equals", false);
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      add(
        ts.isLiteralTypeNode(arg) ? (arg.literal as ts.Expression) : undefined,
        node,
        "import-type",
        node.attributes !== undefined,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { imports, sdk };
}

const cache = new Map<string, { text: string; info: SourceInfo }>();

export function parseSource(path: string, text: string): SourceInfo | null {
  const area = areaOf(path);
  if (!area || !/\.tsx?$/.test(path)) return null;
  const hit = cache.get(path);
  if (hit && hit.text === text) return hit.info;
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ES2023, true, kind);
  const { imports, sdk } = collectImports(sf);
  const info: SourceInfo = { path, area, text, sf, declared: collectDeclared(sf), sdkImports: sdk, imports };
  if (cache.size > 2000) cache.clear();
  cache.set(path, { text, info });
  return info;
}

export function parseAll(files: ReadonlyMap<string, string>): SourceInfo[] {
  const out: SourceInfo[] = [];
  for (const [p, t] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const s = parseSource(p, t);
    if (s) out.push(s);
  }
  return out;
}

/** Resolves a relative specifier of `from` to a key of `files` (TS-style: no extension, .js → .ts). */
export function resolveRelative(
  from: string,
  specifier: string,
  files: ReadonlyMap<string, string>,
): string | null {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stem = base.replace(/\.(js|jsx|mjs)$/, "");
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  for (const c of candidates) if (files.has(c) && /\.tsx?$/.test(c)) return c;
  return null;
}

/** Value reference (not a declaration name, property name, label or type position). */
export function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p)) return false;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p) ||
      ts.isJsxAttribute(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isLabeledStatement(p) ||
      ts.isBreakOrContinueStatement(p)) &&
    (p as { name?: ts.Node; label?: ts.Node }).name === id
  ) {
    return false;
  }
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return false;
  if (
    (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) &&
    p.tagName === id &&
    /^[a-z]/.test(id.text)
  ) {
    return false;
  }
  for (let a: ts.Node | undefined = p; a; a = a.parent) {
    if (ts.isTypeNode(a) && !ts.isExpressionWithTypeArguments(a)) return false;
    if (ts.isInterfaceDeclaration(a) || ts.isTypeAliasDeclaration(a)) return false;
    if (ts.isStatement(a) || ts.isSourceFile(a)) break;
  }
  return true;
}

/** Member name for `a.b` and `a["b"]` (literal key); null for a non-literal computed key. */
export function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const a = node.argumentExpression;
  if (ts.isStringLiteralLike(a) || ts.isNumericLiteral(a)) return a.text;
  return null;
}

export function isMemberAccess(
  node: ts.Node,
): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

/** Strips parentheses, `as`, `!` and `satisfies` around an expression. */
export function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = cur.expression;
    } else return cur;
  }
}

/** Initializer of a top-level `const name = …`. */
export function topLevelConst(sf: ts.SourceFile, name: string): ts.Expression | null {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
    }
  }
  return null;
}

export function topLevelFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | null {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
  }
  return null;
}

/** Expression of `export default <expr>` / `export { x as default }` / `export default function`. */
export function defaultExport(sf: ts.SourceFile): ts.Node | null {
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st) && !st.isExportEquals) return unwrap(st.expression);
    if (
      (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      return st;
    }
    if (
      ts.isExportDeclaration(st) &&
      !st.moduleSpecifier &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      for (const el of st.exportClause.elements) {
        if (el.name.text === "default") {
          const local = (el.propertyName ?? el.name).text;
          return topLevelFunction(sf, local) ?? topLevelConst(sf, local) ?? el;
        }
      }
    }
  }
  return null;
}
