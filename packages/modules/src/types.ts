// Code side of a beta v2 module (specs/modules/modules.yaml#manifest, #compile): the manifest is data, the definition
// adds what data cannot express — the compile hook, screen generators and runtime function sources.
import type {
  AppSpec,
  ModuleCatalog,
  ModuleFragments,
  ModuleManifest,
  ModuleMetric,
  SectionTypeSpec,
  SystemPlan,
} from "@wizard/appspec";

export type ModuleScreen = NonNullable<ModuleManifest["screens"]>[number];

/** A goal-panel metric of a plan module (when true); planGoal — its goal is one of the plan's goals. */
export interface CompiledMetric extends ModuleMetric {
  module: string;
  planGoal: boolean;
}

/** What a module's hook and generators see: the validated plan and this module's parameters with defaults. */
export interface ModuleContext {
  plan: SystemPlan;
  /** Parameters of this module with manifest defaults (resolveParams). */
  params: Readonly<Record<string, unknown>>;
  /** Parameters of every plan module with defaults. */
  allParams: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Module ids of the plan. */
  present: ReadonlySet<string>;
  /**
   * Where the system is built (CompileOptions.platformUrl/systemId, B2-28): the platform's origin without a trailing
   * slash and the system's id; absent in previews. Link of the owner's page — platformSystemUrl(ctx).
   */
  platform?: { url: string; systemId: string };
}

/**
 * Context of a file generator: the compiled spec (entities, roles, merged permissions; functions and pages are not
 * final yet) and the goal-panel metrics of the plan — the list compilePlan returns.
 */
export interface GenContext extends ModuleContext {
  spec: AppSpec;
  metrics: readonly CompiledMetric[];
}

/** Context of a screen generator: a file generator's context plus the screen and its roles. */
export interface ScreenContext extends GenContext {
  screen: ModuleScreen;
  /** Concrete role names of the screen (symbolic roles expanded). */
  roles: readonly string[];
}

/** Screen generator: TSX source of the page (pure and deterministic). */
export type ScreenGenerator = (ctx: ScreenContext) => string;

/** Source of a module file generated per plan (pure and deterministic). */
export type FileGenerator = (ctx: GenContext) => string;

export interface ModuleDefinition {
  manifest: ModuleManifest;
  /** compile.ts (manifest.hook): pure params → fragments for what substitution cannot express. */
  compile?: (ctx: ModuleContext) => ModuleFragments;
  /**
   * Screen generators by screen id. A screen without one must be a cabinet screen on /cabinet: the engine shows the
   * module's entities in the shared cabinet of each of its roles.
   */
  screens?: Readonly<Record<string, ScreenGenerator>>;
  /**
   * Sources by file path: the runtime functions of manifest.functions (functions/**.ts) and helper files they or the
   * module's pages import (functions/**, ui/**; emitted whenever the module is in the plan) — text, or a generator
   * called once per compiled plan.
   */
  files?: Readonly<Record<string, string | FileGenerator>>;
  /** Russian notes for the plan screen (e.g. «форма заявки не стоит на лендинге»). */
  warnings?: (ctx: ModuleContext) => string[];
  /**
   * Roles of this module that a symbolic reference from `module` expands to (the staff module: `$staff` of a section
   * module — only the staff roles with that section). Without it — all roles of the module.
   */
  roleScope?: (ctx: ModuleContext, module: string) => readonly string[];
}

/** Module definitions the engine compiles from (ready ones with code, drafts with the manifest only) and catalogs. */
export interface ModuleRegistry {
  modules: readonly ModuleDefinition[];
  /** Theme preset ids (default THEME_PRESETS; B2-36 extends). */
  themes?: readonly string[];
  /** Font families (default THEME_FONTS). */
  fonts?: readonly string[];
  /** Landing sections (default SECTION_CATALOG; B2-35 extends). */
  sections?: readonly SectionTypeSpec[];
}

/** The ModuleCatalog of a registry for validateSystemPlan (plan screen, planner). */
export function planCatalog(registry: ModuleRegistry): ModuleCatalog {
  return {
    modules: registry.modules.map((d) => d.manifest),
    ...(registry.themes ? { themes: registry.themes } : {}),
    ...(registry.fonts ? { fonts: registry.fonts } : {}),
    ...(registry.sections ? { sections: registry.sections } : {}),
  };
}
