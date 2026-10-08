// route(): architecture.yaml#interfaces.llm_call; models.yaml#routing_algorithm, #fallback_rules, #call_policy.retries.
import { randomUUID } from "node:crypto";
import { modelViolation } from "./allowlist.js";
import { BALANCE_BLOCK_MS, CircuitBreaker } from "./circuit.js";
import { LlmError } from "./errors.js";
import {
  briefHash,
  type FixtureLine,
  FixtureStore,
  type FixtureSuite,
  loadAllowedBriefHashes,
  requestKey,
  schemaHash,
  withoutAttachmentBytes,
} from "./fixtures.js";
import { forbidsT1, orgPolicyBus, type PolicyBus } from "./org-policy.js";
import {
  assertNoTokens,
  assertTierAllowed,
  containsTokens,
  decideTier,
  isCallType,
  type PolicyDecision,
  t1Forbidden,
} from "./policy.js";
import { type Env, LiveCallError, liveCall, providerBaseUrl } from "./providers.js";
import {
  createRegistry,
  HIGH_REASONING,
  type ModelDef,
  modelFamily,
  type ProviderId,
  policyVersion,
  type Registry,
  type RouteDef,
} from "./registry.js";
import type {
  CallType,
  LlmEvent,
  LlmMode,
  LlmResult,
  LlmUsage,
  OrgPolicy,
  RouteInput,
  RouteOutput,
  RouteReason,
  UsageRecord,
  UsageSink,
} from "./types.js";
import { costRub, creditsMilli, JsonlUsageSink } from "./usage.js";

export interface FixtureOptions {
  suite: FixtureSuite;
  name: string;
  dir?: string;
  lenient?: boolean;
  /** record mode: the brief of this run; its sha256 must be in tools/eval/briefs or the demo briefs. */
  brief?: string;
  allowedBriefHashes?: ReadonlySet<string>;
}

/** A provider stopped serving calls (models.yaml#fallback_rules, D76): the platform alerts the founder once. */
export interface ProviderDegraded {
  provider: ProviderId;
  /** balance_exhausted — the account ran out of money (blocked for balanceBlockMs); circuit_open — a model's breaker opened. */
  reason: "balance_exhausted" | "circuit_open";
  /** The model whose breaker opened (circuit_open only). */
  model?: string;
}

export interface RouterOptions {
  /** Default: env WIZARD_LLM_MODE, else "fixture". */
  mode?: LlmMode;
  registry?: Registry;
  /** Default: JsonlUsageSink(.data/usage.jsonl). */
  sink?: UsageSink;
  /** Default: process.env. Provider keys and base URLs are read only from here. */
  env?: Env;
  /** Default: env WIZARD_FIXTURE="<suite>/<name>" (fixture and record modes). */
  fixture?: FixtureOptions;
  /**
   * Fixture mode only: recorded answers cost nothing — usage records carry cost_rub 0 and no credits (the demo replay
   * of staff orgs, B2-02; models.yaml#credits.demo_replay). Default: the recorded usage is priced (offline budgets).
   */
  free?: boolean;
  fetch?: typeof globalThis.fetch;
  /** Internal journal only (run_events with internal: true); never the user's SSE (L3-42). */
  onEvent?: (e: LlmEvent) => void;
  /** Policy changes: in-flight T1 calls of an org whose new policy forbids T1 are aborted and repeated on T0. */
  policyBus?: PolicyBus;
  /** Share it between routers: provider blocks and breakers then hold for every run of the process. */
  circuit?: CircuitBreaker;
  /** Called once per degradation episode of a provider (never with prompt data). Must not throw. */
  onProviderDegraded?: (e: ProviderDegraded) => void;
  /** How long a provider with an empty balance is skipped; default BALANCE_BLOCK_MS (30 min). */
  balanceBlockMs?: number;
  /**
   * Z.ai as the reserve of Cloud.ru (D76): a call the policy left on T0 only by default (reason default_T0, e.g.
   * WIZARD_BUILD_DEFAULT_TIER=T0) tries the route's T1 chain, scrubbed, after the whole T0 chain failed. Never for
   * T0-only calls or T0 chosen for data reasons. Default: env WIZARD_LLM_T1_RESERVE=1.
   */
  t1Reserve?: boolean;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface Router {
  readonly mode: LlmMode;
  readonly registry: Registry;
  route(input: RouteInput): Promise<RouteOutput>;
  /** Number of T1 HTTP attempts in flight (all orgs, or one org). */
  inflightT1?(orgId?: string): number;
}

/** A T1 attempt aborted because the org policy now forbids T1. */
class PolicyAbort extends Error {
  constructor(
    readonly policy: OrgPolicy,
    readonly from: ModelDef,
    readonly charged: number,
  ) {
    super("policy changed");
  }
}

const MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF = [1000, 4000, 16000];

function fixtureFromEnv(env: Env): FixtureOptions | undefined {
  const spec = env.WIZARD_FIXTURE;
  if (!spec) return undefined;
  const [suite, name] = spec.split("/");
  if ((suite !== "demo" && suite !== "eval" && suite !== "unit") || !name) {
    throw new Error(`WIZARD_FIXTURE must be <demo|eval|unit>/<name>, got ${spec}`);
  }
  return { suite, name, lenient: env.WIZARD_FIXTURE_LENIENT === "1" };
}

export function createRouter(opts: RouterOptions = {}): Router {
  const env = opts.env ?? process.env;
  const mode: LlmMode = opts.mode ?? (env.WIZARD_LLM_MODE as LlmMode | undefined) ?? "fixture";
  if (mode !== "fixture" && mode !== "live" && mode !== "record")
    throw new Error(`unknown WIZARD_LLM_MODE ${mode}`);
  const reg = opts.registry ?? createRegistry({}, env);
  const sink = opts.sink ?? new JsonlUsageSink();
  const circuit = opts.circuit ?? new CircuitBreaker(opts.now);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const random = opts.random ?? Math.random;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
  const version = policyVersion(reg);
  const fixtureOpts = opts.fixture ?? fixtureFromEnv(env);
  const balanceBlockMs = opts.balanceBlockMs ?? BALANCE_BLOCK_MS;
  const t1Reserve = opts.t1Reserve ?? env.WIZARD_LLM_T1_RESERVE === "1";
  const degraded = (e: ProviderDegraded) => {
    try {
      opts.onProviderDegraded?.(e);
    } catch {
      // An alert hook never breaks a model call.
    }
  };

  let store: FixtureStore | null = null;
  if (mode !== "live") {
    if (!fixtureOpts) {
      throw new Error(
        `WIZARD_LLM_MODE=${mode} needs a fixture (option fixture or env WIZARD_FIXTURE=<suite>/<name>)`,
      );
    }
    store = new FixtureStore(fixtureOpts);
  }
  const free = opts.free === true;
  if (free && mode !== "fixture") throw new Error(`free routing needs WIZARD_LLM_MODE=fixture, got ${mode}`);
  if (mode === "record") {
    // eval.yaml#fixtures.rules: only repository briefs are recorded.
    const allowed = fixtureOpts?.allowedBriefHashes ?? loadAllowedBriefHashes();
    if (!fixtureOpts?.brief || !allowed.has(briefHash(fixtureOpts.brief))) {
      throw new LlmError(
        "RECORD_NOT_ALLOWED",
        "Запись фикстур разрешена только для брифов из tools/eval/briefs и демо-брифов.",
      );
    }
  }

  // In-flight T1 attempts per org; the bus subscription lives only while there are any (routers are per run).
  const policyBus = opts.policyBus ?? orgPolicyBus;
  const inflight = new Map<string, Set<AbortController>>();
  let unsubscribe: (() => void) | null = null;
  const onPolicy = (c: { orgId: string; policy: OrgPolicy }) => {
    if (!forbidsT1(c.policy)) return;
    for (const ctrl of inflight.get(c.orgId) ?? []) ctrl.abort(c.policy);
  };
  const track = (orgId: string, ctrl: AbortController) => {
    let set = inflight.get(orgId);
    if (!set) {
      set = new Set();
      inflight.set(orgId, set);
    }
    set.add(ctrl);
    unsubscribe ??= policyBus.subscribe(onPolicy);
  };
  const untrack = (orgId: string, ctrl: AbortController) => {
    const set = inflight.get(orgId);
    set?.delete(ctrl);
    if (set?.size === 0) inflight.delete(orgId);
    if (inflight.size === 0 && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  const modelsById = new Map(reg.models.map((x) => [x.id, x]));
  const usable = (id: string): ModelDef | null => {
    const model = modelsById.get(id);
    return model?.enabled && reg.providers[model.provider].enabled ? model : null;
  };

  async function route(input: RouteInput): Promise<RouteOutput> {
    try {
      return await routeOnce(input, null);
    } catch (e) {
      if (!(e instanceof PolicyAbort)) throw e;
      // ru_only.effect: the interrupted call is repeated under the new policy (always T0).
      return routeOnce({ ...input, orgPolicy: e.policy }, e);
    }
  }

  async function routeOnce(input: RouteInput, switched: PolicyAbort | null): Promise<RouteOutput> {
    const { callType } = input;
    if (!isCallType(callType)) {
      throw new LlmError("UNKNOWN_CALL_TYPE", "Неизвестный тип вызова модели.", { callType });
    }
    const budget = input.ctx.budget;
    if (budget && budget.spentCredits >= budget.capCredits) {
      throw new LlmError("BUDGET_EXCEEDED", "Бюджет кредитов прогона исчерпан.", { ...budget });
    }
    const routeDef = reg.routes[callType];
    const decision: PolicyDecision = decideTier(
      {
        callType,
        messages: input.messages,
        ...(input.containsPiiHint !== undefined ? { containsPiiHint: input.containsPiiHint } : {}),
        ...(input.orgPolicy !== undefined ? { orgPolicy: input.orgPolicy } : {}),
      },
      reg,
    );
    if (decision.tier === "T1") assertNoTokens(decision.scrubbedMessages);

    // Step 8 + fallback_rules: the T1 chain only when the policy chose T1; T0 is always the reserve. T0 → T1 only as
    // the opt-in reserve of a call that is T0 by default alone (t1Reserve, D76), scrubbed and token-free.
    // T0-only calls (runtime_ai_*, support, multimodal) never get a T1 chain, whatever the registry says (M3-02).
    const t0Only = t1Forbidden(callType, input.messages);
    const reserveT1 =
      t1Reserve &&
      !t0Only &&
      decision.tier === "T0" &&
      decision.reason === "default_T0" &&
      !containsTokens(decision.scrubbedMessages);
    const tiers =
      decision.tier === "T1" && !t0Only
        ? (["T1", "T0"] as const)
        : reserveT1
          ? (["T0", "T1"] as const)
          : (["T0"] as const);
    const chain: ModelDef[] = [];
    const avoid = new Set(input.avoidFamilies ?? []);
    for (const tier of tiers) {
      for (const id of routeDef.chain[tier] ?? []) {
        const model = usable(id);
        if (model && model.tier === tier && !avoid.has(modelFamily(model))) chain.push(model);
      }
    }

    const toolNames = (input.tools ?? []).map((t) => t.name);
    const lastMsg = decision.scrubbedMessages.at(-1);
    const lastText = lastMsg
      ? typeof lastMsg.content === "string"
        ? lastMsg.content
        : JSON.stringify(lastMsg.content)
      : "";
    let reason: RouteReason = decision.reason;
    let fallbackFrom: string | null = switched ? switched.from.id : null;
    let charged = switched ? switched.charged : 0;
    if (switched && chain[0]) {
      opts.onEvent?.({
        type: "model_switched",
        fromModel: switched.from.id,
        toModel: chain[0].id,
        reason: "fallback_error",
      });
    }
    // T1 chosen but no enabled T1 model: the call goes to T0 as a fallback (fallback_rules).
    if (decision.tier === "T1" && chain[0]?.tier === "T0") reason = "fallback_error";

    const writeRecord = async (
      model: ModelDef,
      fields: Pick<UsageRecord, "attempt" | "status" | "errorCode" | "latencyMs" | "requestHash"> & {
        usage?: LlmUsage;
        toolCalls?: number;
      },
    ): Promise<number> => {
      const usage = fields.usage ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
      const ok = fields.status === "ok";
      const cost = ok && !free ? costRub(model.price, usage) : 0;
      const milli = ok ? creditsMilli(cost, reg.rubPerCredit) : 0;
      const rec: UsageRecord = {
        id: randomUUID(),
        runId: input.ctx.runId ?? null,
        orgId: input.ctx.orgId,
        systemId: input.ctx.systemId ?? null,
        step: input.ctx.step ?? null,
        callType,
        agentRole: routeDef.role,
        tier: model.tier,
        provider: model.provider,
        modelId: model.id,
        attempt: fields.attempt,
        status: fields.status,
        errorCode: fields.errorCode,
        routeReason: reason,
        fallbackFrom,
        policyVersion: version,
        scrubbed: model.tier === "T1",
        piiCategoriesCount: { ...decision.dlp.counts },
        inputTokens: usage.inputTokens,
        cachedTokens: usage.cachedTokens,
        outputTokens: usage.outputTokens,
        toolCalls: fields.toolCalls ?? 0,
        latencyMs: fields.latencyMs,
        ttftMs: null,
        costRub: cost,
        creditsMilli: milli,
        billable: ok,
        mode,
        requestHash: fields.requestHash,
        createdAt: new Date(now()).toISOString(),
      };
      await sink.write(rec);
      return milli;
    };

    const done = (model: ModelDef, result: LlmResult, usage: LlmUsage): RouteOutput => ({
      tier: model.tier,
      model: model.id,
      result,
      usage,
      creditsCharged: charged / 1000,
      creditsMilli: charged,
      routeReason: reason,
      scrubbed: model.tier === "T1",
      ruFallback: (decision.tier === "T1" || switched !== null) && model.tier === "T0",
    });

    // Providers skipped or refused for an empty balance in this call (LLM_UNAVAILABLE details).
    const balanceOut = new Set<ProviderId>();

    const switchTo = (from: ModelDef, why: "fallback_circuit_open" | "fallback_error") => {
      reason = why;
      fallbackFrom = from.id;
    };

    for (let idx = 0; idx < chain.length; idx++) {
      const model = chain[idx] as ModelDef;
      const next = chain[idx + 1];
      // Last line of defence: nothing T0-only reaches a T1 model, in any mode (fixture included).
      assertTierAllowed(callType, model.tier, input.messages);
      const key = requestKey({
        callType,
        modelId: model.id,
        messages: decision.scrubbedMessages,
        ...(input.tools ? { tools: input.tools } : {}),
        temperature: routeDef.temperature,
        maxTokens: routeDef.maxTokens,
        ...(input.ctx.runId ? { runId: input.ctx.runId } : {}),
        ...(input.ctx.systemId ? { systemId: input.ctx.systemId } : {}),
      });

      // Gateway allowlist (D18), in every mode: a western host or model is never called; the chain goes on.
      const provider = reg.providers[model.provider];
      if (modelViolation(provider, model, providerBaseUrl(provider, env))) {
        await writeRecord(model, {
          attempt: 0,
          status: "error",
          errorCode: "MODEL_NOT_ALLOWED",
          latencyMs: 0,
          requestHash: key,
        });
        if (next) {
          opts.onEvent?.({
            type: "model_switched",
            fromModel: model.id,
            toModel: next.id,
            reason: "fallback_error",
          });
          switchTo(model, "fallback_error");
        }
        continue;
      }

      if (mode === "fixture" && store) {
        const line = store.lookup({ callType, key, toolNames, lastMessage: lastText });
        const usage: LlmUsage = {
          inputTokens: line.usage.promptTokens,
          cachedTokens: line.usage.cachedPromptTokens,
          outputTokens: line.usage.completionTokens,
        };
        charged += await writeRecord(model, {
          attempt: 1,
          status: "ok",
          errorCode: null,
          latencyMs: line.latencyMs,
          requestHash: key,
          usage,
          toolCalls: line.response.toolCalls.length,
        });
        return done(model, line.response, usage);
      }

      const cKey = `${model.provider}:${model.id}`;
      const blocked = circuit.providerBlocked(model.provider);
      if (blocked) balanceOut.add(model.provider);
      if (blocked || !circuit.allow(cKey)) {
        await writeRecord(model, {
          attempt: 0,
          status: "circuit_open",
          errorCode: blocked ? "PROVIDER_BALANCE_EXHAUSTED" : null,
          latencyMs: 0,
          requestHash: key,
        });
        if (next) {
          opts.onEvent?.({
            type: "model_switched",
            fromModel: model.id,
            toModel: next.id,
            reason: "fallback_circuit_open",
          });
          switchTo(model, "fallback_circuit_open");
        }
        continue;
      }

      // T1 gets only scrubbed messages; T0 may receive the original ones (fallback_rules MAY).
      const messages = model.tier === "T1" ? decision.scrubbedMessages : input.messages;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // The breaker may open (or the provider run dry) during our own retries: stop hitting this model.
        if (attempt > 1 && (circuit.providerBlocked(model.provider) || !circuit.allow(cKey))) break;
        const started = now();
        const timeout = AbortSignal.timeout(routeDef.timeoutMs);
        const policyCtrl = model.tier === "T1" ? new AbortController() : null;
        const signals = [
          timeout,
          ...(input.signal ? [input.signal] : []),
          ...(policyCtrl ? [policyCtrl.signal] : []),
        ];
        const signal = signals.length === 1 ? timeout : AbortSignal.any(signals);
        if (policyCtrl) track(input.ctx.orgId, policyCtrl);
        try {
          const out = await liveCall({
            provider,
            model,
            messages,
            ...(input.tools ? { tools: input.tools } : {}),
            toolChoice: input.toolChoice ?? "auto",
            temperature: routeDef.temperature,
            maxTokens: routeDef.maxTokens,
            signal,
            env,
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
            reasoning: HIGH_REASONING.has(input.callType as CallType) ? "high" : "low",
          });
          const latencyMs = now() - started;
          circuit.record(cKey, true);
          charged += await writeRecord(model, {
            attempt,
            status: "ok",
            errorCode: null,
            latencyMs,
            requestHash: key,
            usage: out.usage,
            toolCalls: out.result.toolCalls.length,
          });
          if (mode === "record" && store)
            store.append(fixtureLine(key, callType, model, routeDef, decision, input, out, latencyMs));
          return done(model, out.result, out.usage);
        } catch (e) {
          const err = e instanceof LiveCallError ? e : new LiveCallError("NETWORK");
          if (err.code === "NO_API_KEY") break;
          if (policyCtrl?.signal.aborted && !input.signal?.aborted) {
            // Not the provider's fault: the circuit is untouched.
            await writeRecord(model, {
              attempt,
              status: "aborted",
              errorCode: "POLICY_CHANGED",
              latencyMs: now() - started,
              requestHash: key,
            });
            throw new PolicyAbort(policyCtrl.signal.reason as OrgPolicy, model, charged);
          }
          if (err.code === "PROVIDER_BALANCE_EXHAUSTED") {
            // Not overload: no retry, no breaker of the model — the whole provider is skipped by every route.
            balanceOut.add(model.provider);
            if (circuit.blockProvider(model.provider, balanceBlockMs))
              degraded({ provider: model.provider, reason: "balance_exhausted" });
          } else if (circuit.record(cKey, false)) {
            degraded({ provider: model.provider, reason: "circuit_open", model: model.id });
          }
          await writeRecord(model, {
            attempt,
            status: err.code === "TIMEOUT" ? "timeout" : err.code === "ABORTED" ? "aborted" : "error",
            errorCode: err.code,
            latencyMs: now() - started,
            requestHash: key,
          });
          if (err.code === "ABORTED") throw new LlmError("ABORTED", "Вызов модели отменён.");
          if (!err.retryable || attempt === MAX_ATTEMPTS) break;
          const base = backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 0;
          const jittered = base * (0.8 + 0.4 * random());
          await sleep(err.retryAfterMs ?? jittered);
        } finally {
          if (policyCtrl) untrack(input.ctx.orgId, policyCtrl);
        }
      }
      if (next) {
        opts.onEvent?.({
          type: "model_switched",
          fromModel: model.id,
          toModel: next.id,
          reason: "fallback_error",
        });
        switchTo(model, "fallback_error");
      }
    }
    throw new LlmError("LLM_UNAVAILABLE", "Модели сейчас недоступны. Попробуйте позже.", {
      callType,
      ...(balanceOut.size ? { balanceExhausted: [...balanceOut] } : {}),
    });
  }

  const inflightT1 = (orgId?: string) =>
    orgId === undefined
      ? [...inflight.values()].reduce((n, s) => n + s.size, 0)
      : (inflight.get(orgId)?.size ?? 0);

  return { mode, registry: reg, route, inflightT1 };
}

function fixtureLine(
  key: string,
  callType: FixtureLine["callType"],
  model: ModelDef,
  route: RouteDef,
  decision: PolicyDecision,
  input: RouteInput,
  out: { result: LlmResult; usage: LlmUsage },
  latencyMs: number,
): FixtureLine {
  return {
    v: 1,
    key,
    callType,
    modelId: model.id,
    // eval.yaml#fixtures.line.request: stored after scrub for any tier.
    request: {
      messages: withoutAttachmentBytes(decision.scrubbedMessages),
      tools: (input.tools ?? []).map((t) => ({ name: t.name, schemaHash: schemaHash(t.parameters) })),
      params: { temperature: route.temperature, max_tokens: route.maxTokens },
    },
    response: out.result,
    usage: {
      promptTokens: out.usage.inputTokens,
      cachedPromptTokens: out.usage.cachedTokens,
      completionTokens: out.usage.outputTokens,
    },
    latencyMs,
    recordedAt: new Date().toISOString(),
  };
}

let defaultRouter: Router | null = null;

/** route() with a router built from env on first use (WIZARD_LLM_MODE, WIZARD_FIXTURE, provider keys). */
export function route(input: RouteInput): Promise<RouteOutput> {
  defaultRouter ??= createRouter();
  return defaultRouter.route(input);
}
