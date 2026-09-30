// upper_bound(call) = estimated input tokens × input price + max_tokens × output price (builder.yaml#budgets.credits_cap).
// The tier is decided by the router after this check, so the most expensive model of the route chain is assumed.
import {
  type CallType,
  costRub,
  createRegistry,
  creditsMilli,
  type LlmMessage,
  type LlmTool,
  type Registry,
} from "@wizard/llm";

/** models.yaml#call_policy.context_too_long: characters / 3.2. */
export function estimateTokens(value: unknown): number {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(s.length / 3.2);
}

export function upperBoundCredits(
  callType: CallType,
  messages: readonly LlmMessage[],
  tools: readonly LlmTool[] = [],
  reg: Registry = createRegistry(),
): number {
  const route = reg.routes[callType];
  const ids = [...(route.chain.T1 ?? []), ...(route.chain.T0 ?? [])];
  const models = reg.models.filter((m) => ids.includes(m.id) && m.enabled);
  const input = estimateTokens(messages) + estimateTokens(tools);
  let worst = 0;
  for (const m of models) {
    const cost = costRub(m.price, { inputTokens: input, cachedTokens: 0, outputTokens: route.maxTokens });
    worst = Math.max(worst, creditsMilli(cost, reg.rubPerCredit));
  }
  return worst / 1000;
}

/** workflows.yaml#run_lifecycle.budget.check: N = 25% of cap rounded up to a whole credit. */
export function raiseStep(cap: number): number {
  return Math.max(1, Math.ceil(0.25 * cap));
}
