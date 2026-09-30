// Credits estimate and cap computed by code (orchestrator.yaml#estimation; principle "оценка считается кодом").
import { type CallType, createRegistry, type OrgPolicy, type Registry, type Tier } from "@wizard/llm";
import coefficients from "./estimate.coefficients.json" with { type: "json" };
import type { Estimate } from "./schemas.js";

export type Coefficients = typeof coefficients;
export const COEFFICIENTS: Coefficients = coefficients;

export interface CardShape {
  data?: { fields: unknown[] }[];
  screens?: unknown[];
  automations?: unknown[];
  integrations?: unknown[];
  roles?: unknown[];
  acceptance?: unknown[];
}

export function tokensExpected(card: CardShape, k: Coefficients = COEFFICIENTS): number {
  const t = k.tokens;
  const data = card.data ?? [];
  const fields = data.reduce((s, d) => s + d.fields.length, 0);
  return (
    t.base +
    t.perEntity * data.length +
    t.perField * fields +
    t.perScreen * (card.screens?.length ?? 0) +
    t.perAutomation * (card.automations?.length ?? 0) +
    t.perIntegration * (card.integrations?.length ?? 0) +
    t.perRole * (card.roles?.length ?? 0) +
    t.perAcceptance * (card.acceptance?.length ?? 0)
  );
}

/** Tier of the build calls: T0 when the org is RU-only or T1-restricted (fail-safe as in route()), or by the switch. */
export function buildTier(reg: Registry, orgPolicy: OrgPolicy | null | undefined): Tier {
  if (!orgPolicy || orgPolicy.ruOnly || orgPolicy.t1Restricted !== false) return "T0";
  return reg.buildDefaultTier;
}

/** ₽ per 1M tokens blended over build call types (first enabled model of each route chain for the tier). */
export function priceBlended(reg: Registry, tier: Tier, k: Coefficients = COEFFICIENTS): number {
  let sum = 0;
  for (const [callType, share] of Object.entries(k.shares) as [CallType, number][]) {
    const chain = reg.routes[callType].chain[tier] ?? reg.routes[callType].chain.T0 ?? [];
    const model = chain
      .map((id) => reg.models.find((m) => m.id === id))
      .find((m) => m?.enabled && reg.providers[m.provider].enabled);
    if (!model) throw new Error(`no enabled model for ${callType}/${tier}`);
    sum += share * (k.blend.input * model.price.input + k.blend.output * model.price.output);
  }
  return sum;
}

export interface EstimateResult {
  estimate: Estimate;
  cap: { credits: number };
  tokens: number;
  tier: Tier;
}

export interface EstimateOptions {
  registry?: Registry;
  orgPolicy?: OrgPolicy | null;
  /** change_requests.small_edit: cap floor 3 instead of 10. */
  kind?: "create" | "change";
  coefficients?: Coefficients;
}

export function estimateCard(card: CardShape, opts: EstimateOptions = {}): EstimateResult {
  const reg = opts.registry ?? createRegistry();
  const k = opts.coefficients ?? COEFFICIENTS;
  const tier = buildTier(reg, opts.orgPolicy);
  const tokens = tokensExpected(card, k);
  const expected = Math.ceil((tokens * priceBlended(reg, tier, k)) / 1e6 / reg.rubPerCredit);
  const floor = opts.kind === "change" ? k.cap.changeFloor : k.cap.floor;
  return {
    estimate: {
      credits: { min: Math.ceil(k.range.min * expected), expected, max: Math.ceil(k.range.max * expected) },
      minutes: {
        min: Math.ceil(tokens / k.minutes.fastTokensPerMinute),
        max: Math.ceil(tokens / k.minutes.slowTokensPerMinute),
      },
    },
    cap: { credits: Math.max(floor, Math.ceil(k.cap.factor * expected)) },
    tokens,
    tier,
  };
}
