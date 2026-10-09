// V3-18: the site of a brief as the harness v3 composes its skeleton without a model — the plan of the brief, the
// design of its direction, the backend, the skeleton of the page composer (the seed of the system id). Shared by the
// composer tests of the eval and feature briefs.
import { type SystemBrief, type SystemBriefInput, systemBriefSchema } from "@wizard/appspec";
import { designSystemV3 } from "@wizard/ui-kit/v3/design";
import {
  briefNiche,
  briefPlan,
  compileBackend,
  createPageComposer,
  readSite,
  type SiteModel,
} from "../src/builder/index.js";
import type { V3BuildContext } from "../src/builder/v3/contract.js";
import { DEFAULT_REGISTRY } from "../src/planner/index.js";

/** The composed site of a brief, the files of the system and its build context. */
export async function briefSite(id: string, input: SystemBriefInput) {
  const brief: SystemBrief = systemBriefSchema.parse(input);
  const systemId = `sys-${id}`;
  const bp = briefPlan(brief, DEFAULT_REGISTRY, [], { appName: "Проверка" });
  if (!bp) throw new Error(`${id}: no plan`);
  const design = designSystemV3({
    archetype: brief.design.archetype as never,
    seed: systemId,
    niche: briefNiche(brief),
  });
  const backend = compileBackend({
    plan: bp.plan,
    registry: DEFAULT_REGISTRY,
    extensions: [],
    design,
    options: { appName: "Проверка" },
  });
  if (!backend.ok) throw new Error(backend.message_ru);
  const files = new Map(Object.entries(backend.files));
  const ctx: V3BuildContext = {
    systemId,
    brief,
    briefVersion: 1,
    plan: backend.plan,
    spec: backend.spec,
    publicFront: backend.publicFront,
    design,
    files,
    route: async () => {
      throw new Error("0 ₽: no model");
    },
    budgetRub: 0,
  };
  const out = await createPageComposer().skeleton(ctx);
  for (const [p, v] of out.files) v === null ? files.delete(p) : files.set(p, v);
  return {
    files,
    site: readSite(files) as SiteModel,
    front: backend.publicFront,
    spec: backend.spec,
    plan: backend.plan,
    ctx,
    notes: out.notes,
  };
}
