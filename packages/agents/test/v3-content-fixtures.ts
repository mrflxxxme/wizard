// V3-24 fixtures: the dental clinic of the V3-12 fixtures (landing, catalog, leads, notify) with «Контент и блог» —
// articles with rubrics and pages of the site — compiled in backend mode, so its public screens (/blog, /blog/:slug,
// /blog/rubric/:slug, /pages, /pages/:slug) come to the page composer. Shared by the composer tests and the browser
// test of @wizard/build.
import type { SystemPlan } from "@wizard/appspec";
import { compilePlan } from "@wizard/modules";
import type { V3BuildContext } from "../src/builder/v3/contract.js";
import { DEFAULT_REGISTRY } from "../src/planner/index.js";
import { composeContext } from "./v3-compose-fixtures.js";

/** The plan of the clinic with the content module (parameters of the module — `params`). */
export function contentPlan(base: SystemPlan, params: Record<string, unknown> = {}): SystemPlan {
  return {
    ...base,
    modules: [...base.modules.filter((m) => m.id !== "content"), { id: "content", params }],
  };
}

/** A build context of the clinic with «Контент и блог»; `params` — of the module. */
export function contentContext(
  o: { params?: Record<string, unknown>; systemId?: string; photos?: boolean } = {},
): V3BuildContext {
  const base = composeContext({ ...(o.systemId ? { systemId: o.systemId } : {}), photos: o.photos });
  const r = compilePlan(contentPlan(base.plan, o.params), DEFAULT_REGISTRY, {
    appName: "Белая линия",
    front: "backend",
  });
  if (!r.ok || !r.publicFront) throw new Error(JSON.stringify(r.ok ? "no public front" : r.errors));
  return {
    ...base,
    plan: r.plan,
    spec: { ...r.spec, compliance: base.spec.compliance },
    publicFront: r.publicFront,
    files: new Map(Object.entries(r.files)),
  };
}
