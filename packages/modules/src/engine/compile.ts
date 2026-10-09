// Module engine (B2-11, specs/modules/modules.yaml#compile): a validated SystemPlan → AppSpec, page and function files,
// goal-panel metrics and goal scenarios — without models, byte-for-byte deterministic (no clock, no randomness; arrays
// in application order, objects built in a fixed key order). Plan problems are rejected before compilation with
// Russian PlanErrors; a compiled spec that fails validateSpec, or a module breaking its own declarations, is MODULE_BUG.
import {
  type Acceptance,
  type AppFunction,
  type AppSpec,
  type Entity,
  type EntityIndex,
  evalCondition,
  type Field,
  type GoalScenario,
  type Integration,
  isReservedName,
  type ModuleFragments,
  type ModuleManifest,
  markExtraPii,
  type Page,
  PERMISSION_OPS,
  type Permission,
  type PermissionOp,
  type PlanError,
  type PlanErrorCode,
  pointer,
  type Role,
  SECTION_CATALOG,
  type SectionTypeSpec,
  SYSTEM_FIELDS,
  type SystemPlan,
  validateModuleCatalog,
  validateSpec,
  validateSystemPlan,
  type Workflow,
} from "@wizard/appspec";
import { cabinetPage, cabinetRoute, can } from "../screens/cabinet.js";
import { homePage } from "../screens/home.js";
import { pascal } from "../screens/jsx.js";
import {
  type CompiledMetric,
  type FileGenerator,
  type GenContext,
  type ModuleContext,
  type ModuleDefinition,
  type ModuleRegistry,
  planCatalog,
  type ScreenContext,
} from "../types.js";
import {
  type FrontMode,
  orphanUiFiles,
  PUBLIC_AUDIENCES,
  type PublicFront,
  type PublicHook,
  type PublicScreen,
  publicActions,
  publicFunctions,
  type ScenarioSurface,
  scenarioFront,
  V2_FRONT_NOTES,
} from "./front.js";
import { planSiteName } from "./name.js";
import { applicationOrder } from "./order.js";
import { canonical, sameJson, substitute } from "./substitute.js";

/** Route of the shared role cabinet: a cabinet screen without a generator lists the module's entities there. */
export const CABINET_ROUTE = "/cabinet";
/** Base roles of every compiled system (#compile.order step 1). */
export const BASE_ROLES: readonly Role[] = [
  { name: "guest", label: "Посетитель", access: "public" },
  { name: "owner", label: "Владелец", access: "login", loginMethods: ["email_otp"], isAdmin: true },
];
const BASE_COMPLIANCE = { consentTemplateId: "default", policyPage: "/privacy" } as const;

export interface CompileOptions {
  /** Name the owner gave the system; default — the plan's niche as a short site name (planSiteName, B2-44). */
  appName?: string;
  /**
   * Origin of the platform the system is built on and the system's id there (B2-28, for B2-27): generators get them
   * as ModuleContext.platform — the owner's page of the system is `${platformUrl}/s/${systemId}` (platformSystemUrl).
   * Both or neither; the planner's previews compile without them.
   */
  platformUrl?: string;
  systemId?: string;
  /**
   * V3-10 (C5): "v2" (default) — module pages as before; "backend" — AppSpec, functions, automations, metrics, goal
   * scenarios and staff cabinets without the public pages (landing, home, booking, showcase, client cabinet): v3
   * generates them on the client's design system with the headless hooks of the result's publicFront.
   */
  front?: FrontMode;
}

/** The owner's page of the system on the platform (`${url}/s/${systemId}`), or null when compiled without it. */
export function platformSystemUrl(ctx: Pick<ModuleContext, "platform">): string | null {
  return ctx.platform ? `${ctx.platform.url}/s/${encodeURIComponent(ctx.platform.systemId)}` : null;
}

export type { CompiledMetric } from "../types.js";

/** A goal scenario of a plan module whose condition holds and whose withModules are all in the plan. */
export interface CompiledScenario extends GoalScenario {
  module: string;
  /** Backend mode: public — a visitor or client acts on pages of the v3 front; cabinet — staff cabinets only. */
  surface?: ScenarioSurface;
  /** Backend mode: headless hooks of the public actions the scenario goes through (its modules). */
  hooks?: PublicHook[];
}

/** Reserved names and paths of a custom item for the custom-code stage (B2-23); not in the spec yet. */
export interface CustomSlot {
  id: string;
  kind: "screen" | "function";
  title: string;
  /** Page component or function name (custom_ / custom prefix). */
  name: string;
  file: string;
  route?: string;
  budgetRub: number;
  module?: string;
  goal?: string;
}

export interface CompileSuccess {
  ok: true;
  spec: AppSpec;
  /** ui/** and functions/** sources by path (sorted). */
  files: Record<string, string>;
  /** Module ids in application order. */
  order: string[];
  /** Optional links applied (both modules in the plan). */
  links: { from: string; to: string; effect: string }[];
  metrics: CompiledMetric[];
  scenarios: CompiledScenario[];
  customSlots: CustomSlot[];
  /** The plan with modules[].version set to the manifest versions it was compiled with. */
  plan: SystemPlan;
  /** Russian notes for the plan screen. */
  warnings: string[];
  /** Backend mode only: the compiled front ("backend") and what its public front must provide. */
  front?: "backend";
  publicFront?: PublicFront;
}

export type CompileResult = CompileSuccess | { ok: false; errors: PlanError[] };

function perr(
  code: PlanErrorCode,
  path: readonly PropertyKey[],
  message: string,
  extra: { allowed?: readonly string[]; hint?: string } = {},
): PlanError {
  const e: PlanError = { code, path: pointer(path), message_ru: message };
  if (extra.allowed) e.allowed = [...extra.allowed];
  if (extra.hint) e.hint = extra.hint;
  return e;
}

/**
 * Checks the registry: manifests by validateModuleCatalog (CATALOG_INVALID) and the code of ready modules — hook ↔
 * compile, sources of declared functions, a generator for every screen except shared cabinet screens (MODULE_BUG).
 */
export function checkRegistry(registry: ModuleRegistry): PlanError[] {
  const cat = validateModuleCatalog(registry.modules.map((d) => d.manifest));
  if (!cat.ok) return cat.errors;
  const errors: PlanError[] = [];
  registry.modules.forEach((d, i) => {
    const m = d.manifest;
    const bug = (path: PropertyKey[], msg: string) =>
      errors.push(perr("MODULE_BUG", [i, ...path], `Модуль «${m.name}»: ${msg}`));
    if (m.status !== "ready") {
      if (d.compile || d.screens || d.files) bug([], "у черновика (draft) не должно быть кода");
      return;
    }
    if (Boolean(m.hook) !== Boolean(d.compile))
      bug(
        ["hook"],
        m.hook ? "в манифесте hook, но нет compile" : "есть compile, но в манифесте нет hook: true",
      );
    (m.functions ?? []).forEach((f, k) => {
      if (d.files?.[f.file] === undefined) bug(["functions", k, "file"], `нет кода функции ${f.file}`);
    });
    (m.screens ?? []).forEach((s, k) => {
      if (d.screens?.[s.id]) {
        if (!(m.provides?.routes ?? []).includes(s.route))
          bug(["screens", k, "route"], `маршрут экрана «${s.route}» не объявлен в provides.routes`);
      } else if (!(s.audience === "cabinet" && s.route === CABINET_ROUTE))
        bug(
          ["screens", k],
          `у экрана «${s.id}» нет генератора; без генератора — только экран audience cabinet на ${CABINET_ROUTE}`,
        );
    });
    for (const id of Object.keys(d.screens ?? {}))
      if (!(m.screens ?? []).some((s) => s.id === id))
        bug(["screens"], `генератор «${id}» без экрана в манифесте`);
  });
  return errors;
}

/** Landing sections whose variant exists in the library but not yet in ui-kit (B2-35 adds them). */
export function unimplementedSections(plan: SystemPlan, sections: readonly SectionTypeSpec[]): PlanError[] {
  const types = new Map(sections.map((s) => [s.type, s]));
  const errors: PlanError[] = [];
  (plan.landing?.sections ?? []).forEach((s, i) => {
    const t = types.get(s.type);
    if (!t || t.ready.includes(s.variant)) return;
    errors.push(
      perr(
        "SECTION_NOT_IMPLEMENTED",
        ["landing", "sections", i, "variant"],
        `Вариант «${s.variant}» секции «${t.label}» ещё не реализован`,
        t.ready.length
          ? { allowed: t.ready, hint: "Выберите готовый вариант раскладки" }
          : { hint: "Секции этого типа появятся с библиотекой секций (B2-35); пока уберите её из плана" },
      ),
    );
  });
  return errors;
}

type Raw = Record<string, unknown>;
const opRank = (op: string) => PERMISSION_OPS.indexOf(op as PermissionOp);
const unionOrdered = (a: readonly string[] = [], b: readonly string[] = []) => [...new Set([...a, ...b])];

/** Deep merge of integration configs: objects recursively, other values must be equal. */
function mergeConfig(a: unknown, b: unknown, path: string[], conflict: (p: string) => void): unknown {
  const isObj = (v: unknown): v is Raw => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const out: Raw = { ...a };
    for (const [k, v] of Object.entries(b))
      out[k] = k in out ? mergeConfig(out[k], v, [...path, k], conflict) : structuredClone(v);
    return out;
  }
  if (!sameJson(a, b)) conflict(path.join("."));
  return a;
}

/**
 * Compiles a system plan with the module registry (#compile): validation (catalog, plan with requireReady, landing
 * variants), modules in topological order with substitutions and hooks, links, merged permissions, theme, screens
 * and functions, validateSpec (MODULE_BUG) and the metric check.
 */
export function compilePlan(
  input: unknown,
  registry: ModuleRegistry,
  opts: CompileOptions = {},
): CompileResult {
  const regErrors = checkRegistry(registry);
  if (regErrors.length) return { ok: false, errors: regErrors };
  const v = validateSystemPlan(input, planCatalog(registry), { requireReady: true });
  if (!v.ok) return v;
  const notReady = unimplementedSections(v.plan, registry.sections ?? SECTION_CATALOG);
  if (notReady.length) return { ok: false, errors: notReady };
  return new Compilation(v.plan, v.params, registry, opts).run();
}

class Compilation {
  private readonly errors: PlanError[] = [];
  private readonly defs: Map<string, ModuleDefinition>;
  private readonly present: ReadonlySet<string>;
  private readonly planIndex: Map<string, number>;
  private readonly order: string[];
  private readonly spec: AppSpec;
  private readonly entityOwner = new Map<string, string>();
  private readonly roleOwner = new Map<string, string>();
  private readonly extraFields = new Map<string, PropertyKey[]>();
  private readonly rawPerms: { module: string; value: Raw }[] = [];
  private readonly rawAcceptance: { module: string; value: Raw }[] = [];
  private readonly workflows: Workflow[] = [];
  private readonly integrations: Integration[] = [];
  private readonly functions: AppFunction[] = [];
  private readonly pages: Page[] = [];
  private readonly files = new Map<string, string>();
  /** Generated module files, rendered once the plan's metrics are known. */
  private readonly generated: { module: string; file: string; gen: FileGenerator }[] = [];
  private planMetrics: CompiledMetric[] = [];
  private readonly links: CompileSuccess["links"] = [];
  private readonly warnings: string[] = [];

  private readonly platform: ModuleContext["platform"];
  private readonly front: FrontMode;
  /** Backend mode: module screens left to the v3 front. */
  private readonly publicScreens: PublicScreen[] = [];
  private readonly functionOwner = new Map<string, string>();

  constructor(
    private readonly plan: SystemPlan,
    private readonly params: Record<string, Record<string, unknown>>,
    registry: ModuleRegistry,
    opts: CompileOptions,
  ) {
    this.platform =
      opts.platformUrl && opts.systemId
        ? { url: opts.platformUrl.replace(/\/+$/, ""), systemId: opts.systemId }
        : undefined;
    this.front = opts.front ?? "v2";
    this.defs = new Map(registry.modules.map((d) => [d.manifest.id, d]));
    this.present = new Set(plan.modules.map((m) => m.id));
    this.planIndex = new Map(plan.modules.map((m, i) => [m.id, i]));
    this.order = applicationOrder(plan.modules.map((m) => this.manifest(m.id)));
    const name = (opts.appName ?? planSiteName(plan)).slice(0, 80);
    this.spec = {
      specVersion: "1",
      app: { name, locale: "ru" },
      entities: [],
      roles: BASE_ROLES.map((r) => structuredClone(r)),
      permissions: [],
    };
    for (const r of BASE_ROLES) this.roleOwner.set(r.name, "");
  }

  private manifest(id: string): ModuleManifest {
    const d = this.defs.get(id);
    if (!d) throw new Error(`module ${id} is not in the registry`);
    return d.manifest;
  }

  private ctx(id: string): ModuleContext {
    return {
      plan: this.plan,
      params: this.params[id] ?? {},
      allParams: this.params,
      present: this.present,
      ...(this.platform ? { platform: this.platform } : {}),
    };
  }

  private bug(module: string, msg: string, path: PropertyKey[] = []): void {
    const i = this.planIndex.get(module);
    this.errors.push(
      perr(
        "MODULE_BUG",
        i === undefined ? [] : ["modules", i, ...path],
        `Модуль «${this.manifest(module).name}»: ${msg}`,
      ),
    );
  }

  run(): CompileResult {
    // 3. Modules: fragments with a true condition → substitutions → hook → extra fields.
    for (const id of this.order) {
      const m = this.manifest(id);
      this.applyFragments(id, m.fragments, "фрагменты");
      const hook = this.defs.get(id)?.compile;
      if (hook) this.applyFragments(id, hook(this.ctx(id)), "compile.ts");
      this.addExtraFields(id);
    }
    // 4. Links: after all modules, in the order of the source modules.
    for (const id of this.order)
      for (const l of this.manifest(id).links ?? []) {
        if (!this.present.has(l.module)) continue;
        this.links.push({ from: id, to: l.module, effect: l.effect });
        this.applyFragments(id, l.fragments, `связь с «${l.module}»`);
      }
    if (this.errors.length) return { ok: false, errors: this.errors };
    this.markExtraPii();

    // 5. Permissions with symbolic roles expanded and merged per role and entity.
    this.spec.permissions = this.mergePermissions();
    // 7. Design.
    const d = this.plan.design;
    this.spec.theme = {
      accent: d.accent,
      preset: d.theme as NonNullable<AppSpec["theme"]>["preset"],
      font: d.fontPair.body as NonNullable<AppSpec["theme"]>["font"],
      headingFont: d.fontPair.heading as NonNullable<AppSpec["theme"]>["font"],
    };
    // 8. Functions, metrics (generated files and screens see them), screens (6. the landing is the landing module's
    // screen), shared cabinets, start page.
    this.addFunctions();
    if (this.errors.length) return { ok: false, errors: this.errors };
    // Metric bugs are reported after validateSpec (a spec error explains a broken metric better).
    this.planMetrics = this.metrics({ ...this.spec, functions: this.functions });
    const metricErrors = this.errors.splice(0);
    this.renderGenerated();
    if (this.errors.length) return { ok: false, errors: metricErrors.length ? metricErrors : this.errors };
    this.addScreens();
    if (this.errors.length) return { ok: false, errors: metricErrors.length ? metricErrors : this.errors };

    const spec = this.finalSpec();
    // 9. validateSpec: an error here is a bug of a module (its CI matrix should have caught it).
    const checked = validateSpec(spec);
    if (!checked.ok)
      return {
        ok: false,
        errors: checked.errors.map((e) =>
          perr(
            "MODULE_BUG",
            [],
            `Ошибка модуля: скомпилированная спека не проходит проверку — ${e.message_ru} (${e.path || "/"})`,
          ),
        ),
      };
    if (metricErrors.length) return { ok: false, errors: metricErrors };
    const metrics = this.planMetrics;

    for (const id of this.order) {
      // Backend mode: notes about the v2 public pages (lead form, showcase on the landing) do not apply.
      if (this.front === "backend" && V2_FRONT_NOTES.has(id)) continue;
      this.warnings.push(...(this.defs.get(id)?.warnings?.(this.ctx(id)) ?? []));
    }
    const backend = this.front === "backend" ? this.backendFront(spec) : undefined;
    return {
      ok: true,
      spec,
      files: Object.fromEntries([...this.files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      order: [...this.order],
      links: this.links,
      metrics,
      scenarios: backend
        ? this.scenarios().map((s) => ({ ...s, ...scenarioFront(s, backend.actions) }))
        : this.scenarios(),
      customSlots: this.customSlots(),
      plan: {
        ...this.plan,
        modules: this.plan.modules.map(({ id, version: _v, ...rest }) => ({
          id,
          version: this.manifest(id).version,
          ...rest,
        })),
      },
      warnings: this.warnings,
      ...(backend ? { front: "backend" as const, publicFront: backend } : {}),
    };
  }

  /**
   * Backend mode (V3-10): ui/** helpers no remaining page imports are dropped (they served the pages left to v3); the
   * public front gets the skipped screens, the public data actions and the public functions of the spec.
   */
  private backendFront(spec: AppSpec): PublicFront {
    const pages = (spec.pages ?? []).map((p) => p.file);
    for (const f of orphanUiFiles(this.files, pages)) this.files.delete(f);
    return {
      screens: this.publicScreens,
      actions: publicActions(spec, this.entityOwner, this.functionOwner, this.params),
      functions: publicFunctions(spec, this.functionOwner),
    };
  }

  // ------------------------------------------------------------------ fragments

  private applyFragments(mod: string, fr: ModuleFragments | undefined, where: string): void {
    if (!fr) return;
    const m = this.manifest(mod);
    const params = this.params[mod] ?? {};
    const known = new Set(m.params.map((p) => p.name));
    const on = (w: Parameters<typeof evalCondition>[0]) => evalCondition(w, params, this.present);
    const sub = (value: unknown) => substitute(value, params, known) as Raw;
    const ownsEntities = new Set(m.provides?.entities ?? []);
    const ownsRoles = new Set(m.provides?.roles ?? []);

    for (const it of fr.entities ?? []) {
      if (!on(it.when)) continue;
      const e = sub(it.value) as unknown as Entity;
      if (!ownsEntities.has(e.name))
        this.bug(mod, `${where}: сущность «${e.name}» не объявлена в provides.entities`);
      else if (this.entityOwner.has(e.name)) this.bug(mod, `${where}: сущность «${e.name}» объявлена дважды`);
      else {
        this.spec.entities.push(e);
        this.entityOwner.set(e.name, mod);
      }
    }
    for (const it of fr.fields ?? []) {
      if (!on(it.when)) continue;
      const entity = this.spec.entities.find((e) => e.name === it.entity);
      if (!entity) {
        this.bug(mod, `${where}: поле для несуществующей сущности «${it.entity}»`);
        continue;
      }
      this.addField(mod, entity, sub(it.value) as unknown as Field, where);
    }
    for (const it of fr.indexes ?? []) {
      if (!on(it.when)) continue;
      const entity = this.spec.entities.find((e) => e.name === it.entity);
      if (!entity) {
        this.bug(mod, `${where}: индекс для несуществующей сущности «${it.entity}»`);
        continue;
      }
      const idx = sub(it.value) as unknown as EntityIndex;
      entity.indexes ??= [];
      if (!entity.indexes.some((x) => sameJson(x, idx))) entity.indexes.push(idx);
    }
    for (const it of fr.roles ?? []) {
      if (!on(it.when)) continue;
      const r = sub(it.value) as unknown as Role;
      const prev = this.spec.roles.find((x) => x.name === r.name);
      if (!ownsRoles.has(r.name)) this.bug(mod, `${where}: роль «${r.name}» не объявлена в provides.roles`);
      else if (prev && !sameJson(prev, r)) this.bug(mod, `${where}: роль «${r.name}» объявлена по-разному`);
      else if (!prev) {
        this.spec.roles.push(r);
        this.roleOwner.set(r.name, mod);
      }
    }
    for (const it of fr.permissions ?? [])
      if (on(it.when)) this.rawPerms.push({ module: mod, value: sub(it.value) });
    for (const it of fr.workflows ?? []) {
      if (!on(it.when)) continue;
      const w = sub(it.value) as unknown as Workflow;
      const prev = this.workflows.find((x) => x.name === w.name);
      if (prev && !sameJson(prev, w))
        this.bug(mod, `${where}: автоматизация «${w.name}» объявлена по-разному`);
      else if (!prev) this.workflows.push(w);
    }
    for (const it of fr.integrations ?? []) {
      if (!on(it.when)) continue;
      const x = sub(it.value) as unknown as Integration;
      const i = this.integrations.findIndex((y) => y.name === x.name);
      const prev = this.integrations[i];
      if (!prev) {
        this.integrations.push(x);
        continue;
      }
      if (prev.connector !== x.connector) {
        this.bug(mod, `${where}: подключение «${x.name}» уже есть с другим коннектором`);
        continue;
      }
      const config = mergeConfig(prev.config ?? {}, x.config ?? {}, [], (p) =>
        this.bug(mod, `${where}: подключение «${x.name}»: разные значения config.${p}`),
      ) as Raw;
      const secretRefs = unionOrdered(prev.secretRefs, x.secretRefs);
      this.integrations[i] = {
        name: prev.name,
        connector: prev.connector,
        ...(Object.keys(config).length ? { config } : {}),
        ...(secretRefs.length ? { secretRefs } : {}),
      };
    }
    for (const it of fr.acceptance ?? [])
      if (on(it.when)) this.rawAcceptance.push({ module: mod, value: sub(it.value) });
  }

  private addField(mod: string, entity: Entity, f: Field, where: string): void {
    const prev = entity.fields.find((x) => x.name === f.name);
    if (!prev) {
      entity.fields.push(f);
      return;
    }
    const extra = this.extraFields.get(`${entity.name}.${f.name}`);
    if (extra)
      this.errors.push(
        perr(
          "FIELD_NAME_CONFLICT",
          extra,
          `Дополнительное поле «${f.name}» совпадает с полем, которое добавляет модуль «${this.manifest(mod).name}» (${where})`,
          { hint: "Переименуйте дополнительное поле" },
        ),
      );
    else if (!sameJson(prev, f))
      this.bug(mod, `${where}: поле «${entity.name}.${f.name}» объявлено по-разному`);
  }

  /** Fields of `fields` parameters go to the module's main entity (provides.entities[0]). */
  private addExtraFields(mod: string): void {
    const m = this.manifest(mod);
    const params = this.params[mod] ?? {};
    const mi = this.planIndex.get(mod) ?? 0;
    for (const p of m.params) {
      if (p.type !== "fields") continue;
      const list = (params[p.name] ?? []) as {
        name: string;
        label: string;
        type: Field["type"];
        required?: boolean;
        options?: { value: string; label: string }[];
      }[];
      if (!list.length) continue;
      const target = m.provides?.entities?.[0];
      const entity = this.spec.entities.find((e) => e.name === target);
      if (!entity) {
        this.bug(mod, `параметр «${p.name}»: нет основной сущности модуля для дополнительных полей`);
        continue;
      }
      list.forEach((x, k) => {
        const path = ["modules", mi, "params", p.name, k, "name"];
        const reserved = (SYSTEM_FIELDS as readonly string[]).includes(x.name) || isReservedName(x.name);
        if (reserved || entity.fields.some((f) => f.name === x.name)) {
          this.errors.push(
            perr(
              "FIELD_NAME_CONFLICT",
              path,
              reserved
                ? `Имя дополнительного поля «${x.name}» зарезервировано`
                : `Поле «${x.name}» уже есть у сущности «${entity.label}» модуля «${m.name}»`,
              { hint: "Выберите другое имя поля" },
            ),
          );
          return;
        }
        // pii is set by markExtraPii once all fields of the entity are known.
        entity.fields.push({
          name: x.name,
          label: x.label,
          type: x.type,
          ...(x.required ? { required: true } : {}),
          ...(x.options ? { enum: x.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
        });
        this.extraFields.set(`${entity.name}.${x.name}`, path);
      });
    }
  }

  /**
   * B2-46 (mvp-07 of D76): extra fields that look like personal data by the G2-PII-02 criterion (@wizard/appspec
   * piiNameReason, on the final entity) are marked pii basic; marking makes the entity a subject, so weak names are
   * re-checked until nothing changes. An entity that has personal data only thanks to them and no retention of its
   * own keeps them ten years after creation and then clears them (anonymize: the record stays) — G2-PII-05. The rule
   * is @wizard/appspec markExtraPii, shared with the spec extensions of v3 (V3-10).
   */
  private markExtraPii(): void {
    const byEntity = new Map<string, Set<string>>();
    for (const key of this.extraFields.keys()) {
      const [entity = "", field = ""] = key.split(".");
      byEntity.set(entity, (byEntity.get(entity) ?? new Set()).add(field));
    }
    for (const [name, extras] of byEntity) {
      const entity = this.spec.entities.find((e) => e.name === name);
      if (entity) markExtraPii(entity, extras);
    }
  }

  // ------------------------------------------------------------------ roles and permissions

  /**
   * Concrete roles of a role reference: $public, $owner, $staff (the staff roles in scope of `mod`, else owner),
   * $visitor, or a name.
   */
  private expand(ref: unknown, mod: string): string[] {
    const owned = (m: string) =>
      this.spec.roles.filter((r) => this.roleOwner.get(r.name) === m).map((r) => r.name);
    switch (ref) {
      case "$public":
        return ["guest"];
      case "$owner":
        return ["owner"];
      case "$staff": {
        const staff = this.present.has("staff") ? owned("staff") : [];
        if (!staff.length) return ["owner"];
        const scope = this.defs.get("staff")?.roleScope;
        if (!scope) return staff;
        const inScope = new Set(scope(this.ctx("staff"), mod));
        return staff.filter((r) => inScope.has(r));
      }
      case "$visitor":
        return this.present.has("visitor_cabinet") ? owned("visitor_cabinet") : [];
      default:
        if (typeof ref === "string" && this.spec.roles.some((r) => r.name === ref)) return [ref];
        this.bug(mod, `ссылка на неизвестную роль «${String(ref)}»`);
        return [];
    }
  }

  private expandAll(refs: readonly unknown[], mod: string): string[] {
    return unionOrdered(refs.flatMap((r) => this.expand(r, mod)));
  }

  /** ops — union; rowFilter — all conditions (the narrowest), rowFilterOps — the union of filtered ops. */
  private mergePermissions(): Permission[] {
    const merged = new Map<string, Permission & { filtered: string[] }>();
    for (const { module, value } of this.rawPerms) {
      for (const role of this.expand(value.role, module)) {
        const p = { ...(value as unknown as Permission), role };
        const filtered = p.rowFilter ? [...(p.rowFilterOps ?? p.ops)] : [];
        const key = `${role}\u0000${p.entity}`;
        const prev = merged.get(key);
        if (!prev) {
          merged.set(key, { ...structuredClone(p), filtered });
          continue;
        }
        prev.ops = unionOrdered(prev.ops, p.ops) as PermissionOp[];
        if (p.rowFilter) {
          const rf = { ...(prev.rowFilter ?? {}) };
          for (const [k, x] of Object.entries(p.rowFilter)) {
            if (k in rf && rf[k] !== x)
              this.bug(
                module,
                `права роли «${role}» на «${p.entity}»: противоречивые условия rowFilter по «${k}»`,
              );
            rf[k] = x;
          }
          prev.rowFilter = rf;
        }
        prev.filtered = unionOrdered(prev.filtered, filtered);
        for (const k of ["hiddenFields", "readonlyFields"] as const) {
          const u = unionOrdered(prev[k], p[k]);
          if (u.length) prev[k] = u;
        }
      }
    }
    return [...merged.values()].map(({ filtered, ...p }) => {
      const ops = [...p.ops].sort((a, b) => opRank(a) - opRank(b));
      const fOps = [...filtered].sort((a, b) => opRank(a) - opRank(b)) as PermissionOp[];
      const out: Permission = { role: p.role, entity: p.entity, ops };
      if (p.rowFilter && Object.keys(p.rowFilter).length) {
        out.rowFilter = p.rowFilter;
        if (fOps.length < ops.length) out.rowFilterOps = fOps;
      }
      if (p.hiddenFields?.length) out.hiddenFields = p.hiddenFields;
      if (p.readonlyFields?.length) out.readonlyFields = p.readonlyFields;
      return out;
    });
  }

  // ------------------------------------------------------------------ functions and screens

  private addFunctions(): void {
    for (const id of this.order) {
      const m = this.manifest(id);
      const d = this.defs.get(id);
      for (const f of m.functions ?? []) {
        if (!evalCondition(f.when, this.params[id] ?? {}, this.present)) continue;
        if (this.functions.some((x) => x.name === f.name)) {
          this.bug(id, `функция «${f.name}» уже объявлена другим модулем`);
          continue;
        }
        const roles = f.roles ? this.expandAll(f.roles, id) : undefined;
        this.functions.push({
          name: f.name,
          kind: f.kind,
          file: f.file,
          ...(f.public ? { public: true } : {}),
          ...(roles?.length ? { roles } : {}),
          ...(f.systemDbReason ? { systemDbReason: f.systemDbReason } : {}),
          ...(f.collectsPii ? { collectsPii: true } : {}),
        });
        this.functionOwner.set(f.name, id);
        this.setFile(id, f.file, d?.files?.[f.file] ?? "");
      }
      // Helper files (not declared as functions): emitted whenever the module is in the plan.
      const declared = new Set((m.functions ?? []).map((f) => f.file));
      for (const [file, src] of Object.entries(d?.files ?? {}))
        if (!declared.has(file)) {
          if (!/^(functions|ui)\/[A-Za-z0-9_/-]+\.tsx?$/.test(file))
            this.bug(id, `файл «${file}» вне functions/** и ui/**`);
          else if (this.files.has(file) || this.generated.some((g) => g.file === file))
            this.bug(id, `файл «${file}» уже есть`);
          else this.setFile(id, file, src);
        }
    }
  }

  private setFile(module: string, file: string, src: string | FileGenerator): void {
    if (typeof src === "string") this.files.set(file, src);
    else this.generated.push({ module, file, gen: src });
  }

  /**
   * Context of a module's generators: the spec so far with every module's workflows and integrations (B2-47: the
   * notify page lists the notifications of other modules too, e.g. the reports digest) and the plan's metrics.
   */
  private genCtx(id: string): GenContext {
    const spec: AppSpec = {
      ...this.spec,
      ...(this.workflows.length ? { workflows: this.workflows } : {}),
      ...(this.integrations.length ? { integrations: this.integrations } : {}),
    };
    return { ...this.ctx(id), spec, metrics: this.planMetrics };
  }

  private renderGenerated(): void {
    for (const { module, file, gen } of this.generated) {
      try {
        // A helper the plan does not need (V3-23: the СДЭК client without СДЭК delivery) generates "": no file.
        const src = gen(this.genCtx(module));
        if (src !== "") this.files.set(file, src);
      } catch (e) {
        this.bug(module, `генератор файла «${file}» упал: ${(e as Error).message}`);
      }
    }
  }

  private addScreens(): void {
    const cabinet = new Map<string, string[]>();
    const rendered: { id: string; page: Page; render: (site: ScreenContext["site"]) => string }[] = [];
    for (const id of this.order) {
      const m = this.manifest(id);
      const d = this.defs.get(id);
      for (const s of m.screens ?? []) {
        if (!evalCondition(s.when, this.params[id] ?? {}, this.present)) continue;
        const roles = this.expandAll(s.roles, id);
        if (!roles.length) continue;
        // Backend mode (V3-10): the site and the client cabinet are the v3 front's; staff cabinets stay.
        if (this.front === "backend" && PUBLIC_AUDIENCES.has(s.audience)) {
          this.publicScreens.push({
            module: id,
            id: s.id,
            audience: s.audience as PublicScreen["audience"],
            route: s.route,
            title: s.title,
            roles,
          });
          continue;
        }
        const gen = d?.screens?.[s.id];
        if (gen) {
          const file = s.route === "/" ? "ui/pages/Home.tsx" : `ui/pages/${pascal(id)}${pascal(s.id)}.tsx`;
          const page: Page = { route: s.route, title: s.title, file, roles, ...(s.nav ? { nav: true } : {}) };
          rendered.push({
            id,
            page,
            render: (site) => gen({ ...this.genCtx(id), screen: s, roles, site }),
          });
          continue;
        }
        const own = (m.provides?.entities ?? []).filter((e) => this.spec.entities.some((x) => x.name === e));
        for (const r of roles) cabinet.set(r, unionOrdered(cabinet.get(r), own));
      }
    }
    // Shared role cabinets: a login role with readable entities of cabinet screens.
    const roleCabinets = this.spec.roles
      .filter((r) => r.access === "login")
      .flatMap((role) => {
        const entities = (cabinet.get(role.name) ?? []).filter((e) => can(this.spec, role.name, e, "read"));
        if (!entities.length) return [];
        const { route, file } = cabinetRoute(role.name, role.name === "owner");
        const page: Page = { route, title: `Кабинет: ${role.label}`.slice(0, 80), file, roles: [role.name] };
        return [{ role, entities, page }];
      });
    const cabinets = roleCabinets.map((c) => c.page.route);
    // Generators see the final roles, entities and permissions, and the pages known so far (B2-49: the landing of a
    // back-office system leads to the team's sign-in).
    const site = {
      pages: [...rendered.map((r) => r.page), ...roleCabinets.map((c) => c.page)],
      cabinet: cabinets[0],
    };
    for (const { id, page, render } of rendered) {
      if (this.pages.some((p) => p.route === page.route)) {
        this.bug(id, `страница «${page.route}» уже есть`);
        continue;
      }
      try {
        this.files.set(page.file, render(site));
        this.pages.push(page);
      } catch (e) {
        this.bug(id, `генератор экрана «${page.route}» упал: ${(e as Error).message}`);
      }
    }
    for (const { role, entities, page } of roleCabinets) {
      this.pages.push(page);
      this.files.set(page.file, cabinetPage(this.spec, role.name, role.label, entities));
    }
    if (this.front === "v2" && !this.pages.some((p) => p.route === "/")) {
      this.pages.push({
        route: "/",
        title: "Главная",
        file: "ui/pages/Home.tsx",
        roles: this.spec.roles.map((r) => r.name),
        nav: true,
      });
      // B2-45: the public actions of the plan's modules (or a staff sign-in page), not a lone cabinet button.
      this.files.set(
        "ui/pages/Home.tsx",
        homePage({
          spec: { ...this.spec, pages: this.pages },
          niche: this.plan.niche,
          present: this.present,
          params: this.params,
          cabinet: cabinets[0],
        }),
      );
    }
  }

  // ------------------------------------------------------------------ result

  private finalSpec(): AppSpec {
    const acceptance: Acceptance[] = [];
    for (const { module, value } of this.rawAcceptance) {
      const check = { ...((value.check ?? {}) as Acceptance["check"]) };
      if (check.role !== undefined) {
        const role = this.expand(check.role, module)[0];
        if (!role) continue;
        check.role = role;
      }
      acceptance.push({ id: `AC${acceptance.length + 1}`, text: String(value.text ?? ""), check });
    }
    const s = this.spec;
    return {
      specVersion: s.specVersion,
      app: s.app,
      ...(s.theme ? { theme: s.theme } : {}),
      entities: s.entities,
      roles: s.roles,
      permissions: s.permissions,
      ...(this.workflows.length ? { workflows: this.workflows } : {}),
      ...(this.integrations.length ? { integrations: this.integrations } : {}),
      ...(this.functions.length ? { functions: this.functions } : {}),
      ...(this.pages.length ? { pages: this.pages } : {}),
      ...(acceptance.length ? { acceptance } : {}),
      compliance: { ...BASE_COMPLIANCE },
    };
  }

  /** Metrics of plan modules; every entity, date field, field and `where` value must exist in the compiled spec. */
  private metrics(spec: AppSpec): CompiledMetric[] {
    const goals = new Set<string>(this.plan.goals.map((g) => g.id));
    const out: CompiledMetric[] = [];
    for (const id of this.order) {
      for (const x of this.manifest(id).metrics) {
        if (!evalCondition(x.when, this.params[id] ?? {}, this.present)) continue;
        const where = `метрика «${x.id}»`;
        const c = x.compute;
        if (c.kind === "function") {
          if (!(spec.functions ?? []).some((f) => f.name === c.name))
            this.bug(id, `${where}: нет функции «${c.name}»`);
        } else {
          const e = spec.entities.find((y) => y.name === c.entity);
          if (!e) this.bug(id, `${where}: нет сущности «${c.entity}»`);
          else {
            const field = (n: string) => e.fields.find((f) => f.name === n);
            const has = (n: string) =>
              (SYSTEM_FIELDS as readonly string[]).includes(n) || field(n) !== undefined;
            const need = [c.dateField, ...("field" in c ? [c.field] : []), ...("by" in c ? [c.by] : [])];
            for (const n of need) if (!has(n)) this.bug(id, `${where}: нет поля «${c.entity}.${n}»`);
            const wheres = [
              ...("where" in c && c.where ? [c.where] : []),
              ...("numerator" in c ? [c.numerator] : []),
              ...("denominator" in c && c.denominator ? [c.denominator] : []),
            ];
            for (const w of wheres)
              for (const [k, val] of Object.entries(w)) {
                const f = field(k);
                if (!f && !has(k)) this.bug(id, `${where}: нет поля «${c.entity}.${k}»`);
                else if (f?.type === "enum") {
                  const allowed = new Set((f.enum ?? []).map((o) => o.value));
                  for (const one of Array.isArray(val) ? val : [val])
                    if (!allowed.has(String(one)))
                      this.bug(id, `${where}: значения «${String(one)}» нет в «${c.entity}.${k}»`);
                }
              }
          }
        }
        out.push({ ...structuredClone(x), module: id, planGoal: goals.has(x.goal) });
      }
    }
    return out;
  }

  private scenarios(): CompiledScenario[] {
    const out: CompiledScenario[] = [];
    for (const id of this.order)
      for (const s of this.manifest(id).goalScenarios)
        if (
          evalCondition(s.when, this.params[id] ?? {}, this.present) &&
          (s.withModules ?? []).every((w) => this.present.has(w))
        )
          out.push({ ...structuredClone(s), module: id });
    return out;
  }

  private customSlots(): CustomSlot[] {
    return this.plan.custom.map((c) => {
      const base = {
        id: c.id,
        kind: c.kind,
        title: c.title,
        budgetRub: c.budgetRub,
        ...(c.module ? { module: c.module } : {}),
        ...(c.goal ? { goal: c.goal } : {}),
      };
      return c.kind === "screen"
        ? {
            ...base,
            name: `custom_${c.id}`,
            file: `ui/custom/Custom${pascal(c.id)}.tsx`,
            route: `/custom-${c.id.replace(/_/g, "-")}`,
          }
        : { ...base, name: `custom${pascal(c.id)}`, file: `functions/custom/${c.id}.ts` };
    });
  }
}

/** Canonical JSON of a compile result's spec and files: the text the determinism test and caches compare. */
export function compiledFingerprint(r: Pick<CompileSuccess, "spec" | "files">): string {
  return canonical({ spec: r.spec, files: r.files });
}
