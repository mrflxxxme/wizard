// What the goal interview and the planner may use from the module registry (specs/modules/modules.yaml#ai_rules):
// modules that can compile today (ready, with every unconditional requires available), landing sections with ready
// variants, themes and fonts — as compact Russian prompt digests and a deterministic default design.
import {
  GOALS,
  type ModuleManifest,
  type ParamSpec,
  SECTION_CATALOG,
  type SectionTypeSpec,
  type SystemPlan,
  THEME_FONTS,
  THEME_PRESETS,
} from "@wizard/appspec";
import { CATALOG, type ModuleRegistry } from "@wizard/modules";

/** The registry the beta v2 path compiles with by default (@wizard/modules CATALOG). */
export const DEFAULT_REGISTRY: ModuleRegistry = CATALOG;

const manifests = (registry: ModuleRegistry): ModuleManifest[] => registry.modules.map((d) => d.manifest);

/**
 * Modules a plan may contain today: status ready and every unconditional `requires` available (fixpoint), so the
 * compiler accepts them. Draft modules and ready ones that need a draft module are «coming soon» (outOfScope).
 */
export function availableModules(registry: ModuleRegistry): Set<string> {
  const byId = new Map(manifests(registry).map((m) => [m.id, m]));
  const ok = new Set([...byId.values()].filter((m) => m.status === "ready").map((m) => m.id));
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of [...ok]) {
      const m = byId.get(id);
      if ((m?.requires ?? []).some((r) => r.when === undefined && !ok.has(r.module))) {
        ok.delete(id);
        changed = true;
      }
    }
  }
  return ok;
}

/** Section types with at least one ready variant (only those may go into a plan, SECTION_NOT_IMPLEMENTED). */
export function readySections(registry: ModuleRegistry): SectionTypeSpec[] {
  return (registry.sections ?? SECTION_CATALOG).filter((s) => s.ready.length > 0);
}

function paramLine(p: ParamSpec): string {
  const opts = "options" in p && p.options ? ` [${p.options.map((o) => o.value).join("|")}]` : "";
  const def = "default" in p && p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : "";
  const req = p.required ? " (обязателен)" : "";
  return `${p.name}: ${p.type}${opts}${def}${req} — ${p.label}`;
}

/** Goals vocabulary for prompts: «id — label». */
export function goalsDigest(): string {
  return GOALS.map((g) => `- ${g.id} — ${g.label}`).join("\n");
}

/** Catalog for the interview: every module with its goals and whether it is available now. */
export function interviewCatalogDigest(registry: ModuleRegistry): string {
  const ok = availableModules(registry);
  return manifests(registry)
    .map(
      (m) =>
        `- ${m.id} «${m.name}» (${ok.has(m.id) ? "доступен" : "скоро"}) — цели: ${m.goals.join(", ")}; параметры: ${
          m.params.map((p) => p.name).join(", ") || "нет"
        }`,
    )
    .join("\n");
}

/** Catalog for the planner: available modules with parameter schemas and links; the rest only by name. */
export function plannerCatalogDigest(registry: ModuleRegistry): string {
  const ok = availableModules(registry);
  const all = manifests(registry);
  const lines: string[] = ["Доступные модули (только их можно ставить в modules):"];
  for (const m of all.filter((x) => ok.has(x.id))) {
    lines.push(`- ${m.id} «${m.name}»: ${m.summary}. Цели: ${m.goals.join(", ")}.`);
    for (const p of m.params) lines.push(`    ${paramLine(p)}`);
    for (const r of m.requires ?? [])
      lines.push(
        `    требует ${r.module}${r.when ? ` при ${JSON.stringify(r.when)}` : ""}${
          r.expectParams ? ` с параметрами ${JSON.stringify(r.expectParams)}` : ""
        } — ${r.reason}`,
      );
  }
  const soon = all.filter((x) => !ok.has(x.id));
  if (soon.length)
    lines.push(
      "Модули в разработке (в план не ставить; просьбы клиента о них — в outOfScope с заменой из доступных):",
      ...soon.map((m) => `- ${m.id} «${m.name}»: ${m.summary}`),
    );
  return lines.join("\n");
}

/** Landing sections with ready variants and content keys. */
export function sectionsDigest(registry: ModuleRegistry): string {
  return readySections(registry)
    .map((s) => {
      const parts = [
        `варианты: ${s.ready.join("|")}`,
        `обязательно: ${s.required.join(", ") || "—"}`,
        `можно: ${s.optional.join(", ") || "—"}`,
      ];
      if (s.requiresModule?.length) parts.push(`нужен модуль: ${s.requiresModule.join(" или ")}`);
      if (s.position) parts.push(s.position === "first" ? "первой" : "последней");
      if (s.unique) parts.push("одна на странице");
      return `- ${s.type} «${s.label}»: ${parts.join("; ")}`;
    })
    .join("\n");
}

/**
 * Deterministic design until the design agent (B2-37) fills it: the first theme and font of the registry catalogs,
 * a calm accent and a neutral photo style.
 */
export function defaultDesign(registry: ModuleRegistry): SystemPlan["design"] {
  const themes = registry.themes ?? THEME_PRESETS;
  const fonts = registry.fonts ?? THEME_FONTS;
  const theme = themes.includes("calm") ? "calm" : (themes[0] ?? "calm");
  const font = fonts.includes("Manrope") ? "Manrope" : (fonts[0] ?? "Manrope");
  return {
    direction: { mood: ["спокойствие", "доверие"], rhythm: "balanced" },
    theme,
    accent: "#2A7F9E",
    fontPair: { heading: font, body: font },
    photoStyle: "естественный свет, реальные места и люди без постановки",
  };
}
