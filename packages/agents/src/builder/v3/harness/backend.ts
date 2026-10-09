// Stage «backend» of the harness v3 (builder-v3.md C5) and the spec of the public pages: the brief's plan compiled with
// {front: "backend"} (entities, roles and RLS, ПДн, functions, automations, goal scenarios and staff cabinets — no
// public pages), the extension operations applied under the RLS, ПДн and migration gates (applyExtensions), the staff
// cabinets in the client's design (designSystemTheme). No model. The public pages reach the spec from the composer's
// site model in the files (compose/site.ts withSitePages over readSite, V3-12).
import {
  type AppSpec,
  applyExtensions,
  type RejectedExtension,
  type SystemPlan,
  validateSpec,
} from "@wizard/appspec";
import {
  type CompiledScenario,
  type CompileOptions,
  compilePlan,
  type ModuleRegistry,
  type PublicFront,
} from "@wizard/modules";
import { type DesignSystemV3, designSystemTheme } from "@wizard/ui-kit/v3/design";
import { designCss as composerDesignCss } from "../compose/codegen.js";

/** The client's design system file (packages/build DESIGN_CSS_PATH: switches Tailwind v4 on for the system). */
export const DESIGN_CSS_FILE = "ui/design.css";

/**
 * CSS of the design system — the same file the page composer writes (variables of both schemes by the visitor's
 * colour scheme, @font-face of its two families, the Tailwind @theme, the document colours): one producer, so the
 * base layer and the skeleton never disagree.
 */
export const designCss = (ds: DesignSystemV3): string => composerDesignCss(ds);

export interface BackendBuilt {
  spec: AppSpec;
  /** Module files (functions/**, staff cabinets ui/**) and extension functions, by path. */
  files: Record<string, string>;
  publicFront: PublicFront;
  scenarios: CompiledScenario[];
  plan: SystemPlan;
  rejected: RejectedExtension[];
}

export type BackendResult =
  | ({ ok: true } & BackendBuilt)
  | { ok: false; code: "PLAN_INVALID" | "MODULE_BUG"; message_ru: string };

/** Compiles the backend of a plan, applies the extensions and the theme of the design system. */
export function compileBackend(o: {
  plan: SystemPlan;
  registry: ModuleRegistry;
  extensions: readonly unknown[];
  design: DesignSystemV3;
  options: Omit<CompileOptions, "front">;
}): BackendResult {
  const r = compilePlan(o.plan, o.registry, { ...o.options, front: "backend" });
  if (!r.ok) {
    const bug = r.errors.find((e) => e.code === "MODULE_BUG" || e.code === "CATALOG_INVALID");
    return bug
      ? {
          ok: false,
          code: "MODULE_BUG",
          message_ru: `Ошибка в модуле платформы: ${bug.message_ru}. Мы её исправим; бриф сохранён.`,
        }
      : {
          ok: false,
          code: "PLAN_INVALID",
          message_ru: `По брифу не собирается основа системы: ${r.errors[0]?.message_ru ?? "ошибка плана"}. Поправьте бриф — сборка начнётся заново.`,
        };
  }
  const ext = applyExtensions(r.spec, o.extensions, { files: r.files });
  // Staff cabinets take the client's colour, fonts, radius and density; a theme the spec refuses keeps the module one.
  const themed = { ...ext.spec, theme: designSystemTheme(o.design) } as AppSpec;
  const spec = validateSpec(themed).ok ? themed : ext.spec;
  return {
    ok: true,
    spec,
    files: { ...r.files, ...ext.files },
    publicFront: r.publicFront ?? { screens: [], actions: [], functions: [] },
    scenarios: r.scenarios,
    plan: r.plan,
    rejected: ext.rejected,
  };
}
