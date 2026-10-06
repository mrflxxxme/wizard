// Code side of a beta v2 module (specs/modules/modules.yaml#manifest, #compile): the manifest is data, the definition
// adds what data cannot express — the compile hook, screen generators and runtime function sources.
import type {
  AppSpec,
  ModuleCatalog,
  ModuleFragments,
  ModuleManifest,
  SectionTypeSpec,
  SystemPlan,
} from "@wizard/appspec";

export type ModuleScreen = NonNullable<ModuleManifest["screens"]>[number];

/** What a module's hook and generators see: the validated plan and this module's parameters with defaults. */
export interface ModuleContext {
  plan: SystemPlan;
  /** Parameters of this module with manifest defaults (resolveParams). */
  params: Readonly<Record<string, unknown>>;
  /** Parameters of every plan module with defaults. */
  allParams: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Module ids of the plan. */
  present: ReadonlySet<string>;
}

/** Context of a screen generator: the compiled spec (entities, roles, merged permissions) and the screen's roles. */
export interface ScreenContext extends ModuleContext {
  spec: AppSpec;
  screen: ModuleScreen;
  /** Concrete role names of the screen (symbolic roles expanded). */
  roles: readonly string[];
}

/** Screen generator: TSX source of the page (pure and deterministic). */
export type ScreenGenerator = (ctx: ScreenContext) => string;

export interface ModuleDefinition {
  manifest: ModuleManifest;
  /** compile.ts (manifest.hook): pure params → fragments for what substitution cannot express. */
  compile?: (ctx: ModuleContext) => ModuleFragments;
  /**
   * Screen generators by screen id. A screen without one must be a cabinet screen on /cabinet: the engine shows the
   * module's entities in the shared cabinet of each of its roles.
   */
  screens?: Readonly<Record<string, ScreenGenerator>>;
  /** Sources of the runtime functions declared in manifest.functions, by file path (functions/**.ts). */
  files?: Readonly<Record<string, string>>;
  /** Russian notes for the plan screen (e.g. «форма заявки не стоит на лендинге»). */
  warnings?: (ctx: ModuleContext) => string[];
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
