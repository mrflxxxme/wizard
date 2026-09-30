// Code-vs-spec AST checks: G0-SPEC-03, G0-SPEC-04, G0-FN-01 and the literal-limit part of G0-IDX-01.
import type { AppSpec } from "@wizard/appspec";
import ts from "typescript";
import type { Finding } from "../report.js";
import { importGraph, reachable } from "./imports.js";
import {
  defaultExport,
  isMemberAccess,
  memberName,
  nodeLine,
  type SourceInfo,
  snippet,
  topLevelConst,
  topLevelFunction,
  unwrap,
} from "./source.js";

/** sdk.md §2.1 / G0-IDX-01 limits. */
export const LIST_LIMIT_NO_WHERE = 100;
export const LIST_LIMIT_WITH_WHERE = 1000;
export const PAGINATE_MAX_ITEMS = 200;

function isComponent(sf: ts.SourceFile, node: ts.Node | null): boolean {
  if (!node) return false;
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    return true;
  if (ts.isClassDeclaration(node)) return false;
  if (ts.isIdentifier(node)) {
    const fn = topLevelFunction(sf, node.text);
    if (fn) return true;
    const init = topLevelConst(sf, node.text);
    return init !== null && isComponent(sf, unwrap(init));
  }
  // memo(Component) / forwardRef(() => …)
  if (ts.isCallExpression(node)) return node.arguments.some((a) => isComponent(sf, unwrap(a)));
  return false;
}

/** G0-SPEC-03: page and function files exist; every page default-exports a component. */
export function checkFilesExist(
  spec: AppSpec,
  files: ReadonlyMap<string, string>,
  sources: Map<string, SourceInfo>,
): Finding[] {
  const out: Finding[] = [];
  (spec.pages ?? []).forEach((p, i) => {
    if (!files.has(p.file)) {
      out.push({
        message_ru: `Нет файла страницы «${p.title}»: ${p.file}`,
        path: `/pages/${i}/file`,
        file: p.file,
        fixHint: "Создайте файл страницы с export default function",
      });
      return;
    }
    const src = sources.get(p.file);
    if (!src || !isComponent(src.sf, defaultExport(src.sf))) {
      out.push({
        message_ru: `Страница «${p.title}» не экспортирует компонент по умолчанию`,
        path: `/pages/${i}/file`,
        file: p.file,
        fixHint: "Добавьте export default function <Страница>() { … }",
      });
    }
  });
  for (const [i, f] of (spec.functions ?? []).entries()) {
    if (!files.has(f.file)) {
      out.push({
        message_ru: `Нет файла функции «${f.name}»: ${f.file}`,
        path: `/functions/${i}/file`,
        file: f.file,
        fixHint: `Создайте ${f.file} с export default ${f.kind}({ args, handler })`,
      });
    }
  }
  return out;
}

/** G0-SPEC-04 (warning): ui/** and functions/** files not reachable from page/function files. */
export function checkOrphans(
  spec: AppSpec,
  files: ReadonlyMap<string, string>,
  sources: SourceInfo[],
): Finding[] {
  const roots = [...(spec.pages ?? []).map((p) => p.file), ...(spec.functions ?? []).map((f) => f.file)];
  const seen = reachable(
    roots.filter((r) => files.has(r)),
    importGraph(sources, files),
  );
  return sources
    .filter((s) => !seen.has(s.path) && !s.path.endsWith(".d.ts"))
    .map((s) => ({
      message_ru: `Файл ${s.path} нигде не используется`,
      file: s.path,
      fixHint: "Удалите файл или подключите его со страницы/из функции",
    }));
}

export function definer(
  src: SourceInfo,
  node: ts.Node | null,
): { kind: string; call: ts.CallExpression } | null {
  if (!node) return null;
  let e: ts.Node = node;
  if (ts.isIdentifier(e)) {
    const init = topLevelConst(src.sf, e.text);
    if (!init) return null;
    e = unwrap(init);
  }
  if (!ts.isCallExpression(e)) return null;
  const callee = unwrap(e.expression);
  if (!ts.isIdentifier(callee)) return null;
  const kind = src.sdkImports.get(callee.text);
  return kind === "query" || kind === "mutation" || kind === "action" ? { kind, call: e } : null;
}

function isValidatorCall(src: SourceInfo, e: ts.Expression): boolean {
  const u = unwrap(e);
  if (!ts.isCallExpression(u)) return false;
  let cur = unwrap(u.expression);
  while (isMemberAccess(cur)) cur = unwrap(cur.expression);
  return ts.isIdentifier(cur) && src.sdkImports.get(cur.text) === "v";
}

export function propOf(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return (
    obj.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === name) ??
    obj.properties.find((p) => p.name && ts.isStringLiteral(p.name) && p.name.text === name)
  );
}

/** G0-FN-01: default export = query|mutation|action matching function.kind; args are v.* validators. */
export function checkFunctionDefs(spec: AppSpec, sources: Map<string, SourceInfo>): Finding[] {
  const out: Finding[] = [];
  const declaredFiles = new Set<string>();
  for (const [i, f] of (spec.functions ?? []).entries()) {
    declaredFiles.add(f.file);
    const src = sources.get(f.file);
    if (!src) continue; // G0-SPEC-03
    const fail = (message_ru: string, node?: ts.Node, fixHint?: string): void => {
      out.push({
        message_ru,
        file: f.file,
        path: `/functions/${i}`,
        ...(node ? { line: nodeLine(node), evidence: snippet(node) } : {}),
        fixHint:
          fixHint ?? `Экспортируйте по умолчанию ${f.kind}({ args: { … v.* }, handler }) из @wizard/sdk`,
      });
    };
    const d = definer(src, defaultExport(src.sf));
    if (!d) {
      fail(`Файл функции «${f.name}» не экспортирует ${f.kind}(…) из @wizard/sdk по умолчанию`);
      continue;
    }
    if (d.kind !== f.kind) {
      fail(`Функция «${f.name}» объявлена как ${f.kind}, а в коде — ${d.kind}`, d.call.expression);
      continue;
    }
    const arg = d.call.arguments[0] && unwrap(d.call.arguments[0]);
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
      fail(`У функции «${f.name}» нет описания { args, handler }`, d.call);
      continue;
    }
    const args = propOf(arg, "args");
    if (!args || !ts.isPropertyAssignment(args) || !ts.isObjectLiteralExpression(unwrap(args.initializer))) {
      fail(
        `У функции «${f.name}» не описаны аргументы (args: { … })`,
        d.call,
        "Добавьте args: {} с валидаторами v.* для каждого аргумента",
      );
      continue;
    }
    for (const p of (unwrap(args.initializer) as ts.ObjectLiteralExpression).properties) {
      if (!ts.isPropertyAssignment(p) || !isValidatorCall(src, p.initializer)) {
        fail(
          `Аргумент функции «${f.name}» без валидатора v.*: ${snippet(p, 60)}`,
          p,
          "Опишите каждый аргумент валидатором v.* из @wizard/sdk",
        );
      }
    }
  }
  for (const [path, src] of sources) {
    if (src.area !== "functions" || declaredFiles.has(path)) continue;
    const d = definer(src, defaultExport(src.sf));
    if (d) {
      out.push({
        message_ru: `В ${path} объявлена функция (${d.kind}), которой нет в описании системы`,
        file: path,
        line: nodeLine(d.call),
        fixHint:
          "Добавьте функцию в спеку (add_function) или сделайте файл вспомогательным модулем без default-экспорта",
      });
    }
  }
  return out;
}

export interface WhereRange {
  file: string;
  start: number;
  end: number;
}

/** G0-IDX-01 (AST part): literal limits of ctx.db/systemDb reads; also collects `where` ranges for tsc mapping. */
export function checkDataLimits(sources: Iterable<SourceInfo>): {
  findings: Finding[];
  whereRanges: WhereRange[];
} {
  const findings: Finding[] = [];
  const whereRanges: WhereRange[] = [];
  for (const src of sources) {
    if (src.area !== "functions") continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isMemberAccess(node.expression)) {
        const method = memberName(node.expression);
        const table = unwrap(node.expression.expression);
        const db = isMemberAccess(table) ? unwrap(table.expression) : null;
        const dbName = db && isMemberAccess(db) ? memberName(db) : null;
        if (
          (dbName === "db" || dbName === "systemDb") &&
          method &&
          ["list", "first", "count", "paginate"].includes(method)
        ) {
          const opts = node.arguments[0] && unwrap(node.arguments[0]);
          const obj = opts && ts.isObjectLiteralExpression(opts) ? opts : null;
          const where = obj ? propOf(obj, "where") : undefined;
          if (where) whereRanges.push({ file: src.path, start: where.getStart(src.sf), end: where.getEnd() });
          const limit = obj ? propOf(obj, "limit") : undefined;
          if (method === "list" && limit && ts.isPropertyAssignment(limit)) {
            const v = unwrap(limit.initializer);
            const max = where ? LIST_LIMIT_WITH_WHERE : LIST_LIMIT_NO_WHERE;
            if (ts.isNumericLiteral(v) && Number(v.text) > max) {
              findings.push({
                message_ru: `list ${where ? "с where" : "без where"} читает до ${v.text} записей, допустимо не больше ${max}`,
                file: src.path,
                line: nodeLine(limit),
                evidence: snippet(node),
                fixHint: where
                  ? "Уменьшите limit до 1000 или используйте paginate"
                  : "Добавьте where по индексу или уменьшите limit до 100",
              });
            }
          }
          const page = method === "paginate" && node.arguments[1] ? unwrap(node.arguments[1]) : null;
          if (page && ts.isObjectLiteralExpression(page)) {
            const n = propOf(page, "numItems");
            const v = n && ts.isPropertyAssignment(n) ? unwrap(n.initializer) : null;
            if (v && ts.isNumericLiteral(v) && Number(v.text) > PAGINATE_MAX_ITEMS) {
              findings.push({
                message_ru: `paginate запрашивает ${v.text} записей на страницу, допустимо не больше ${PAGINATE_MAX_ITEMS}`,
                file: src.path,
                line: nodeLine(n as ts.Node),
                evidence: snippet(node),
                fixHint: "Уменьшите numItems до 200",
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(src.sf);
  }
  return { findings, whereRanges };
}
