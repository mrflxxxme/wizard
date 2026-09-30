// createQaAgent(opts) → {generate, explain}: the BuilderQa the build host hands to runBuild (agents/qa.yaml).
import type { AppSpec } from "@wizard/appspec";
import { g1Checks, type QaCheck } from "@wizard/gates";
import type { QaExplainInput, QaGenerateInput } from "../builder/types.js";
import { classify, type ExplainCtx, explainAmbiguous } from "./explain.js";
import {
  acPermissionCheck,
  type CardAc,
  cacheKey,
  generateScenarios,
  invalidCheck,
  isLater,
  permissionChecks,
  resolveMilestone,
  scenarioChecks,
} from "./generate.js";
import type { CachedAc, Explanation, QaAgent, QaAgentOptions, QaCache } from "./types.js";

/** In-memory scenario cache (the default). */
export function memoryQaCache(): QaCache & { size(): number } {
  const m = new Map<string, CachedAc>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      m.set(k, structuredClone(v));
    },
    size: () => m.size,
  };
}

const acsOf = (card: QaGenerateInput["card"], spec: AppSpec): CardAc[] =>
  card.acceptance?.length ? card.acceptance : ((spec.acceptance ?? []) as CardAc[]);

export function createQaAgent(opts: QaAgentOptions): QaAgent & { lastChecks(): QaCheck[] } {
  const cache = opts.cache ?? memoryQaCache();
  const milestone = resolveMilestone(opts.milestone);
  let last: QaCheck[] = [];
  const invalid = new Map<string, string[]>();

  async function generate(input: QaGenerateInput): Promise<QaCheck[]> {
    const { spec, specVersion } = input;
    invalid.clear();
    const acs = acsOf(input.card, spec).filter((a) => !isLater(a.check.milestone, milestone));
    const out: QaCheck[] = permissionChecks(spec, acs);
    const specAc = new Map((spec.acceptance ?? []).map((a) => [a.id, a]));
    const need: CardAc[] = [];
    const found = new Map<string, CachedAc>();
    for (const ac of acs) {
      const perm = acPermissionCheck(ac);
      if (perm) {
        out.push(perm);
        continue;
      }
      if (ac.check.type === "permission") continue;
      // Steps already in the spec: G1 derives SC-<AC> from them itself (gates g1Checks).
      if (specAc.get(ac.id)?.check.steps?.length) continue;
      const hit = await cache.get(cacheKey(specVersion, ac));
      if (hit) found.set(ac.id, hit);
      else need.push(ac);
    }
    if (need.length) {
      const fresh = await generateScenarios({ opts, spec, acs: need, files: input.files });
      for (const ac of need) {
        const v = fresh.get(ac.id) ?? { scenarios: [], invalid: [`Нет сценария для ${ac.id}`] };
        await cache.set(cacheKey(specVersion, ac), v);
        found.set(ac.id, v);
      }
    }
    for (const ac of acs) {
      const v = found.get(ac.id);
      if (!v) continue;
      if (v.scenarios.length) out.push(...scenarioChecks(ac, v.scenarios));
      else {
        out.push(invalidCheck(ac));
        invalid.set(`SC-${ac.id}`, v.invalid ?? []);
      }
    }
    last = out;
    return out;
  }

  async function explain(input: QaExplainInput): Promise<Explanation[]> {
    const { spec, report } = input;
    const ran = g1Checks(spec, last);
    const ctx: ExplainCtx = {
      spec,
      acs: acsOf(input.card, spec),
      checks: new Map(ran.map((c) => [c.id, c])),
      invalid,
    };
    const failed = report.checks.filter((c) => c.status === "fail" || c.status === "error");
    const out: Explanation[] = [];
    const ambiguous = [];
    for (const c of failed) {
      const e = classify(c, ctx);
      if (e) out.push(e);
      else ambiguous.push(c);
    }
    if (ambiguous.length) out.push(...(await explainAmbiguous(opts, ctx, ambiguous)));
    const order = new Map(failed.map((c, i) => [c.id, i]));
    return out.sort((a, b) => (order.get(a.checkId) ?? 0) - (order.get(b.checkId) ?? 0));
  }

  return { generate, explain, lastChecks: () => last };
}
