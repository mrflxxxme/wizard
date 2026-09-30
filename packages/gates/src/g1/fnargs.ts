// G1-FN-01: minimal valid args of a function from its v.* validators (read from the AST, never executed).
import ts from "typescript";
import { definer, propOf } from "../g0/code.js";
import { defaultExport, parseSource, unwrap } from "../g0/source.js";
import { syntheticEmail, syntheticPhone } from "./seed.js";

export interface ArgContext {
  now: Date;
  /** Id of a row of the entity visible to the caller (v.id). */
  idOf(entity: string): string | null;
}

const OMIT = Symbol("omit");

function literal(e: ts.Expression | undefined): unknown {
  if (!e) return undefined;
  const u = unwrap(e);
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.text;
  if (ts.isNumericLiteral(u)) return Number(u.text);
  if (
    ts.isPrefixUnaryExpression(u) &&
    u.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(u.operand)
  )
    return -Number(u.operand.text);
  if (u.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (u.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function options(e: ts.Expression | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const u = e && unwrap(e);
  if (!u || !ts.isObjectLiteralExpression(u)) return out;
  for (const p of u.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) out[p.name.text] = literal(p.initializer);
  }
  return out;
}

function argValue(e: ts.Expression, ctx: ArgContext): unknown {
  const u = unwrap(e);
  if (!ts.isCallExpression(u) || !ts.isPropertyAccessExpression(u.expression)) return OMIT;
  const kind = u.expression.name.text;
  const [a0] = u.arguments;
  const o = options(a0);
  const num = (fallback: number) => {
    const min = typeof o.min === "number" ? o.min : undefined;
    const max = typeof o.max === "number" ? o.max : undefined;
    let v = min ?? fallback;
    if (max !== undefined && v > max) v = max;
    return v;
  };
  switch (kind) {
    case "string": {
      const min = typeof o.min === "number" ? o.min : 1;
      const max = typeof o.max === "number" ? o.max : 100;
      return "Тестовая строка".padEnd(min, "а").slice(0, Math.max(max, 1));
    }
    case "int":
      return Math.ceil(num(1));
    case "number":
      return num(1);
    case "money":
      return num(100);
    case "boolean":
      return true;
    case "date":
      return ctx.now.toISOString().slice(0, 10);
    case "datetime":
      return ctx.now.toISOString();
    case "email":
      return syntheticEmail(1);
    case "phone":
      return syntheticPhone(1);
    case "id": {
      const entity = literal(a0);
      return typeof entity === "string" ? (ctx.idOf(entity) ?? OMIT) : OMIT;
    }
    case "literal":
      return literal(a0) ?? OMIT;
    case "enum":
      return literal(a0) ?? OMIT;
    case "array":
      return [];
    case "object": {
      const shape = a0 && unwrap(a0);
      return shape && ts.isObjectLiteralExpression(shape) ? shapeValue(shape, ctx) : OMIT;
    }
    case "optional":
      return OMIT;
    case "nullable":
      return a0 ? argValue(a0, ctx) : null;
    case "pagination":
      return { cursor: null, numItems: 10 };
    default:
      return OMIT;
  }
}

function shapeValue(shape: ts.ObjectLiteralExpression, ctx: ArgContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of shape.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
    if (!name) continue;
    const v = argValue(p.initializer, ctx);
    if (v !== OMIT) out[name] = v;
  }
  return out;
}

/** Minimal args for `export default query/mutation/action({args})`, or null when the file has no such export. */
export function minimalArgs(path: string, source: string, ctx: ArgContext): Record<string, unknown> | null {
  const src = parseSource(path, source);
  if (!src) return null;
  const d = definer(src, defaultExport(src.sf));
  const arg = d?.call.arguments[0] && unwrap(d.call.arguments[0]);
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  const args = propOf(arg, "args");
  if (!args || !ts.isPropertyAssignment(args)) return {};
  const shape = unwrap(args.initializer);
  return ts.isObjectLiteralExpression(shape) ? shapeValue(shape, ctx) : {};
}
