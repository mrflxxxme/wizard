import type { ActionDef, AnyAction, ConnectorDefinition } from "./types.js";

export function defineAction<I, O>(def: ActionDef<I, O>): ActionDef<I, O> {
  return def;
}

export function defineConnector<C, A extends Record<string, AnyAction>>(
  def: ConnectorDefinition<C, A>,
): ConnectorDefinition<C, A> {
  return def;
}
