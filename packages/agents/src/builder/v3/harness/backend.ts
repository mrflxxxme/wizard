// Stage «backend» of the harness v3 (builder-v3.md C5) and the spec of the public pages: the brief's plan compiled with
// {front: "backend"} (entities, roles and RLS, ПДн, functions, automations, goal scenarios and staff cabinets — no
// public pages), the extension operations applied under the RLS, ПДн and migration gates (applyExtensions), the staff
// cabinets in the client's design (designSystemTheme). The public pages the composer writes are registered in the spec
// here (route, title, file, roles of the public front). No model.
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
import { type DesignSystemV3, designSystemCss, designSystemTheme } from "@wizard/ui-kit/v3/design";
import type { V3PagePlan } from "../contract.js";

/** The client's design system file (packages/build DESIGN_CSS_PATH: switches Tailwind v4 on for the system). */
export const DESIGN_CSS_FILE = "ui/design.css";

/** CSS of the design system: variables of both schemes, @font-face of its two families, the Tailwind @theme. */
export const designCss = (ds: DesignSystemV3): string => designSystemCss(ds, { fonts: true });

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

/** Conventional file of a public page: «/» → ui/pages/Home.tsx, «/blog/:slug» → ui/pages/BlogSlug.tsx. */
export function pageFile(route: string): string {
  const parts = route
    .split("/")
    .filter(Boolean)
    .map((p) => p.replace(/^:/, ""))
    .flatMap((p) => p.split(/[-_]/))
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1));
  return `ui/pages/${parts.length ? parts.join("") : "Home"}.tsx`;
}

const baseName = (path: string) => (path.split("/").pop() ?? "").replace(/\.tsx$/, "").toLowerCase();

/**
 * The file of a composer's page: its own `file` when the composer gives one, the conventional file when it exists,
 * else the one page file the step wrote whose name is the route's last segment (home or index for «/»).
 */
export function pageFileOf(
  page: V3PagePlan & { file?: string },
  files: ReadonlyMap<string, string>,
  written: readonly string[],
): string | null {
  if (page.file && files.has(page.file)) return page.file;
  const conv = pageFile(page.route);
  if (files.has(conv)) return conv;
  const last = page.route.split("/").filter(Boolean).pop()?.replace(/^:/, "").toLowerCase() ?? "";
  const names = last ? [last, last.replace(/[-_]/g, "")] : ["home", "index"];
  const hit = written.filter(
    (p) => p.startsWith("ui/pages/") && p.endsWith(".tsx") && names.includes(baseName(p)),
  );
  return hit.length === 1 ? (hit[0] as string) : null;
}

/** Roles of a public page: those of the module screen on its route, else of the public front, else the public roles. */
function pageRoles(route: string, spec: AppSpec, front: PublicFront): string[] {
  const screen = front.screens.find((s) => s.route === route);
  if (screen?.roles.length) return [...screen.roles];
  const all = [...new Set(front.screens.flatMap((s) => s.roles))];
  if (all.length) return all;
  const roles = spec.roles.filter((r) => r.access === "public" || r.isAdmin).map((r) => r.name);
  return roles.length ? roles : spec.roles.slice(0, 1).map((r) => r.name);
}

/**
 * The spec with the composer's public pages (route, title, file, roles); a module's staff page on the same route
 * stays. Pages without a file are left out and named in `missing`.
 */
export function withPublicPages(
  spec: AppSpec,
  pages: readonly (V3PagePlan & { file?: string; written?: readonly string[] })[],
  files: ReadonlyMap<string, string>,
  front: PublicFront,
): { spec: AppSpec; missing: string[] } {
  const own = spec.pages ?? [];
  const taken = new Set(own.map((p) => p.route));
  const out = [...own];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (taken.has(page.route) || seen.has(page.route)) continue;
    const file = pageFileOf(page, files, page.written ?? []);
    if (!file) {
      missing.push(page.route);
      continue;
    }
    seen.add(page.route);
    out.push({ route: page.route, title: page.title, file, roles: pageRoles(page.route, spec, front) });
  }
  return { spec: { ...spec, pages: out }, missing };
}
