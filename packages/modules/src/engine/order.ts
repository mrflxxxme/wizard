// Application order of plan modules (specs/modules/modules.yaml#compile.order step 2): topological sort by `requires`
// (a dependency first), ties broken by the manifest `order`, then by id. The catalog guarantees `requires` is acyclic.
import type { ModuleManifest } from "@wizard/appspec";

/** Module ids of the plan in application order. */
export function applicationOrder(modules: readonly ModuleManifest[]): string[] {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const deps = new Map<string, Set<string>>();
  for (const m of modules)
    deps.set(m.id, new Set((m.requires ?? []).map((r) => r.module).filter((id) => byId.has(id))));
  const rank = (a: ModuleManifest, b: ModuleManifest) =>
    a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const done = new Set<string>();
  const out: string[] = [];
  while (out.length < modules.length) {
    const ready = modules
      .filter((m) => !done.has(m.id) && [...(deps.get(m.id) ?? [])].every((d) => done.has(d)))
      .sort(rank);
    const next = ready[0];
    if (!next) {
      // A cycle (the catalog check reports it); keep the rest in rank order so the result stays deterministic.
      for (const m of [...modules].filter((x) => !done.has(x.id)).sort(rank)) out.push(m.id);
      break;
    }
    done.add(next.id);
    out.push(next.id);
  }
  return out;
}
