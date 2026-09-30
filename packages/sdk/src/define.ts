// query / mutation / action: pure descriptors. Execution belongs to the host (apps/runtime, testing host).
import type {
  ActionCtx,
  ArgsShape,
  Def,
  FnKind,
  FunctionDef,
  InferArgs,
  MutationCtx,
  QueryCtx,
} from "./types.js";

/** Runtime shape of a definition (the public FunctionDef type hides the handler). */
export interface RegisteredFunction<K extends FnKind = FnKind> extends FunctionDef<K, unknown, unknown> {
  readonly handler: (ctx: never, args: never) => unknown;
  readonly __wizardFunction: true;
}

function define<K extends FnKind>(kind: K, d: { args: ArgsShape; handler: unknown }) {
  if (typeof d?.handler !== "function") throw new TypeError(`${kind}: handler must be a function`);
  return Object.freeze({ kind, args: d.args ?? {}, handler: d.handler, __wizardFunction: true as const });
}

export function query<S extends ArgsShape, R>(d: Def<S, QueryCtx, R>): FunctionDef<"query", InferArgs<S>, R> {
  return define("query", d);
}

export function mutation<S extends ArgsShape, R>(
  d: Def<S, MutationCtx, R>,
): FunctionDef<"mutation", InferArgs<S>, R> {
  return define("mutation", d);
}

export function action<S extends ArgsShape, R>(
  d: Def<S, ActionCtx, R>,
): FunctionDef<"action", InferArgs<S>, R> {
  return define("action", d);
}

export function isFunctionDef(x: unknown): x is RegisteredFunction {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { __wizardFunction?: unknown }).__wizardFunction === true &&
    typeof (x as { handler?: unknown }).handler === "function"
  );
}
