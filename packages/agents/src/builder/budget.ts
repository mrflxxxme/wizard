// upper_bound(call) = estimated input tokens × input price + max_tokens × output price (builder.yaml#budgets.credits_cap).
// The tier is decided by the router after this check, so the most expensive model of the route chain is assumed.
// Input tokens per model (@wizard/llm estimateInputTokens): text chars / 3.2, images by the model's rule — not base64.
import {
  type CallType,
  costRub,
  createRegistry,
  creditsMilli,
  estimateInputTokens,
  type LlmMessage,
  type LlmTool,
  type Registry,
} from "@wizard/llm";

/** models.yaml#call_policy.context_too_long: characters / 3.2 (@wizard/llm). */
export { estimateTokens } from "@wizard/llm";

export function upperBoundCredits(
  callType: CallType,
  messages: readonly LlmMessage[],
  tools: readonly LlmTool[] = [],
  reg: Registry = createRegistry(),
): number {
  const route = reg.routes[callType];
  const ids = [...(route.chain.T1 ?? []), ...(route.chain.T0 ?? [])];
  const models = reg.models.filter((m) => ids.includes(m.id) && m.enabled);
  let worst = 0;
  for (const m of models) {
    const input = estimateInputTokens(messages, tools, m);
    const cost = costRub(m.price, { inputTokens: input, cachedTokens: 0, outputTokens: route.maxTokens });
    worst = Math.max(worst, creditsMilli(cost, reg.rubPerCredit));
  }
  return worst / 1000;
}

/** workflows.yaml#run_lifecycle.budget.check: N = 25% of cap rounded up to a whole credit. */
export function raiseStep(cap: number): number {
  return Math.max(1, Math.ceil(0.25 * cap));
}
