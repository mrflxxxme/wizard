// V5-02: the live judge — one vision model through the product router (callType critic_visual forced to the model).
// Needs provider keys in the environment (the eval-v5 workflow has them). Snapshots go abroad like the critic's (D79 (3)).
import {
  createRegistry,
  createRouter,
  type Registry,
  type UsageRecord,
} from "../../../packages/llm/src/index.ts";
import { forceModel } from "../../fixtures/probe/run.ts";

export interface LiveJudgeOptions {
  judges: string[];
  capRub: number;
  env?: NodeJS.ProcessEnv;
  /** Tests: a router in place of the live one. */
  router?: (registry: Registry, onUsage: (u: UsageRecord) => void) => { route: ReturnType<typeof createRouter>["route"] };
}

export interface JudgeInput {
  system: string;
  text: string;
  attachments: { mime: "image/jpeg" | "image/png" | "image/webp"; data: string; name?: string }[];
}

/** → judge(model, input) → {text, costRub}; stops with BUDGET_EXCEEDED once the spend reaches the cap. */
export function createLiveJudge(o: LiveJudgeOptions) {
  const env = o.env ?? process.env;
  let spent = 0;
  const routers = new Map<string, { route: ReturnType<typeof createRouter>["route"] }>();
  const routerFor = (model: string) => {
    let r = routers.get(model);
    if (!r) {
      const registry = forceModel(createRegistry({ buildDefaultTier: "T1" }, env), ["critic_visual"], model);
      const onUsage = (u: UsageRecord) => {
        spent += u.costRub;
      };
      r = o.router ? o.router(registry, onUsage) : createRouter({ mode: "live", registry, env, sink: { write: onUsage }, t1Reserve: false });
      routers.set(model, r);
    }
    return r;
  };
  return async (model: string, input: JudgeInput): Promise<{ text: string; costRub: number }> => {
    if (spent >= o.capRub) throw new Error(`потолок трат ${o.capRub} ₽ достигнут`);
    const before = spent;
    const out = await routerFor(model).route({
      callType: "critic_visual",
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.text, attachments: input.attachments },
      ],
      ctx: { orgId: "eval-v5", systemId: "eval-v5" },
    });
    return { text: out.result.text ?? "", costRub: Math.round((spent - before) * 100) / 100 };
  };
}
