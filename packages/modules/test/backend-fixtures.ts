// V3-10: the plans backend mode is checked on — every CI matrix row of the modules with code, the plan of all modules
// and the plans of the D76 measurement briefs (mvp-01, mvp-07, mvp-08, mvp-09, mvp-10) — and a compile helper.
import type { SystemPlan } from "@wizard/appspec";
import {
  type CompileOptions,
  type CompileSuccess,
  compilePlan,
  MODULES_WITH_CODE,
  type ModuleRegistry,
  matrixPlan,
} from "../src/index.js";
import { allModulesPlan, dealsNotifyReportsPlans, landingLeadsPlan } from "./fixtures.js";
import { libraryPlan, yogaPlan } from "./fixtures-b218.js";
import { crmLandingPlan } from "./fixtures-b249.js";

/** mvp-01 as the D76 plan approves it: landing, catalog, leads, notify by e-mail and Telegram. */
export function mvp01Plan(): SystemPlan {
  return {
    ...landingLeadsPlan(),
    modules: [
      { id: "landing" },
      { id: "catalog" },
      { id: "leads", params: { form_fields: ["name", "phone", "comment"], contact: "any" } },
      { id: "notify", params: { channels: ["email", "telegram"] } },
    ],
    outOfScope: [],
    custom: [],
  };
}

/** Plans of the measurement briefs with module names: mvp-01, mvp-07 CRM, mvp-08 workshop, mvp-09, mvp-10. */
export function mvpPlans(registry: ModuleRegistry): { name: string; plan: SystemPlan }[] {
  return [
    { name: "mvp-01 стоматология", plan: mvp01Plan() },
    { name: "mvp-07 CRM агентства", plan: crmLandingPlan() },
    ...dealsNotifyReportsPlans(registry).map((p) => ({ name: `mvp-08 ${p.name}`, plan: p.plan })),
    { name: "mvp-09 школьная библиотека", plan: libraryPlan() },
    { name: "mvp-10 йога по абонементам", plan: yogaPlan() },
    { name: "все модули", plan: allModulesPlan() },
  ];
}

/** Every CI matrix row of the modules with code: [module, row name, plan]. */
export function matrixPlans(registry: ModuleRegistry): [string, string, SystemPlan][] {
  return MODULES_WITH_CODE.flatMap((d) =>
    (d.manifest.tests?.matrix ?? []).map(
      (row) =>
        [d.manifest.id, row.name, matrixPlan(registry, d.manifest.id, row)] as [string, string, SystemPlan],
    ),
  );
}

export function compiled(plan: unknown, registry: ModuleRegistry, opts: CompileOptions = {}): CompileSuccess {
  const r = compilePlan(plan, registry, { appName: "Проверка", ...opts });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}
