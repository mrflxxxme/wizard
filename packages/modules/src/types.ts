// Code side of a beta v2 module (specs/modules/modules.yaml#manifest, #compile): the manifest is data, the definition
// adds what data cannot express — the compile hook, screen generators and runtime function sources.
import type {
  AppSpec,
  ModuleCatalog,
  ModuleFragments,
  ModuleManifest,
  ModuleMetric,
  Page,
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
 * Context of a file generator: the compiled spec (entities, roles, merged permissions, workflows and
 * integrations; functions and pages are not final yet) and the goal-panel metrics of the plan — the list compilePlan returns.
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
  /**
   * Pages of the system known before the screens render (B2-49): every generated screen and the role cabinets, and the
   * owner's cabinet route (the first login role's); absent when a generator is called outside the engine.
   */
  site?: { pages: readonly Page[]; cabinet: string | undefined };
}

/** Screen generator: TSX source of the page (pure and deterministic). */
export type ScreenGenerator = (ctx: ScreenContext) => string;

/** Source of a module file generated per plan (pure and deterministic); "" — the plan needs no such file (a helper). */
export type FileGenerator = (ctx: GenContext) => string;

/**
 * Status flow of an entity in the cabinets (V3-18): instead of a button per enum value (a plain update of the status),
 * the buttons of the statuses `next` allows from the record's status call `fn` with {id, status} — the module's
 * function checks the transition on the server; `actions` — more function buttons of a record (e.g. a refund) shown
 * in the listed statuses. A button shows only to the roles its function allows.
 */
export interface StatusFlow {
  fn: string;
  next: Readonly<Record<string, readonly string[]>>;
  actions?: readonly {
    id: string;
    label: string;
    fn: string;
    confirm?: string;
    when: readonly string[];
  }[];
}

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
  /** Status flows of the module's entities in the cabinets, by entity (V3-18: the shop's order). */
  statusFlows?: (ctx: ModuleContext) => Readonly<Record<string, StatusFlow>>;
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
