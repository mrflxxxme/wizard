// @wizard/agents/host: the canonical agent_host contract (architecture.yaml#interfaces.agent_host) for durable hosts
// (platform-api in M0, apps/worker in M1) and adapters from host.route to the agents' RouteFn.
import type { CallType, Registry, RouteInput, RouteOutput } from "@wizard/llm";
import { upperBoundCredits } from "../builder/budget.js";
import type { HostRouteInput } from "../builder/types.js";

/** Host side of «Запросы на развитие» (D73): optional recordDevelopmentRequest of BuildHost and orchestrator deps. */
export type {
  DevelopmentRequestCategory,
  DevelopmentRequestInput,
  RecordDevelopmentRequest,
} from "../gaps.js";

import type { RouteFn, RunStepFn } from "../core/index.js";
import { createQaAgent } from "../qa/agent.js";
import type { QaCache } from "../qa/types.js";

export type {
  BuildCard,
  BuilderGateLevel,
  BuilderQa,
  BuildHost,
  BuildMode,
  BuildOutcome,
  BuildParams,
  BuildStore,
  FailureCode,
  HostRouteInput,
  InputAnswer,
  InputOption,
  InputRequest,
  OrchestratorAnswer,
  QaExplainInput,
  QaGenerateInput,
} from "../builder/types.js";

/** host.route: RouteInput without ctx/orgPolicy/signal (the host fills them and enforces the credits cap). */
export type HostRoute = (input: HostRouteInput) => Promise<RouteOutput>;

export interface HostRouteOptions {
  /** Usage record step; default the callType. */
  step?: string;
  /** Registry for upper_bound(call) (default createRegistry()). */
  registry?: Registry;
}

/**
 * Adapts host.route to the agents' RouteFn: drops ctx/orgPolicy/signal of the agent's RouteInput (the host sets
 * them) and adds upperBoundCredits so the host's budget check covers the call (builder.yaml#budgets.credits_cap).
 */
export function hostRouteFn(route: HostRoute, opts: HostRouteOptions = {}): RouteFn {
  return (input: RouteInput) => {
    const { ctx: _ctx, orgPolicy: _policy, signal: _signal, ...rest } = input;
    let ub = 0;
    try {
      ub = upperBoundCredits(input.callType as CallType, input.messages, input.tools ?? [], opts.registry);
    } catch {
      ub = 0; // unknown callType: the router rejects it anyway
    }
    return route({ ...rest, step: opts.step ?? input.callType, upperBoundCredits: ub });
  };
}

export interface HostQaOptions {
  cache?: QaCache;
  milestone?: string;
  registry?: Registry;
}

/** QA agent whose LLM calls go through host.route: its credits count in the run budget (agents/qa.yaml). */
export function createHostQa(
  host: { route: HostRoute; runStep: RunStepFn; signal?: AbortSignal },
  opts: HostQaOptions = {},
): ReturnType<typeof createQaAgent> {
  return createQaAgent({
    route: hostRouteFn(host.route, opts.registry ? { registry: opts.registry } : {}),
    runStep: host.runStep,
    ...(host.signal ? { signal: host.signal } : {}),
    ...(opts.cache ? { cache: opts.cache } : {}),
    ...(opts.milestone ? { milestone: opts.milestone } : {}),
  });
}
