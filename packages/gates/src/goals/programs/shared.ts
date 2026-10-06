// Helpers shared by goal scenario programs: ui-kit selectors and spec lookups by the modules' canonical names.
import type { AppSpec } from "@wizard/appspec";
import type { GoalRun } from "../types.js";

/** Root of a ui-kit component in the DOM (useWzRoot → data-wz-component). */
export const component = (name: string) => `[data-wz-component="${name}"]`;

/** Label of an enum value of an entity field (e.g. lead.status new → «Новая»). */
export function enumLabel(spec: AppSpec, entity: string, field: string, value: string): string {
  const f = spec.entities.find((e) => e.name === entity)?.fields.find((x) => x.name === field);
  return f?.enum?.find((o) => o.value === value)?.label ?? value;
}

/** Route of the section root an actor role may open: the shortest route starting with `prefix` (default the cabinet). */
export function pageRoute(spec: AppSpec, role: string, prefix = "/cabinet"): string | null {
  // The shortest matching route is the section root (/cabinet before /cabinet/notifications), whatever the page order.
  const routes = (spec.pages ?? [])
    .filter((p) => p.roles.includes(role) && p.route.startsWith(prefix))
    .map((p) => p.route);
  return routes.sort((a, b) => a.length - b.length)[0] ?? null;
}

/** Name of the admin (owner) role. */
export const ownerRole = (spec: AppSpec) =>
  spec.roles.find((r) => r.isAdmin === true && r.access !== "public")?.name ?? "owner";

/** String values (≥ 4 characters) of seed rows: none of them may be shown to someone without access. */
export function seedTexts(t: GoalRun, entity: string, limit = 5): string[] {
  const out: string[] = [];
  for (const r of t.seedRows(entity).slice(0, limit))
    for (const [k, v] of Object.entries(r))
      if (k !== "id" && typeof v === "string" && v.length >= 4 && !/^\d{4}-\d\d-\d\d/.test(v)) out.push(v);
  return out;
}

/** The text a visitor sees, normalised (spaces collapsed). */
export async function pageText(t: GoalRun): Promise<string> {
  return (
    (await t.page
      .locator("body")
      .innerText()
      .catch(() => "")) || ""
  ).replace(/\s+/g, " ");
}
