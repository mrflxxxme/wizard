// The compact system digest the reviewer reads (V3-15): the brief's goals and scenarios, the module plan and its
// links, what the extensions added to the modules' spec, entities, roles and permissions, automations, function
// signatures (the source of functions/custom/** in full — they are the builder's code), integrations, pages and the
// deterministic checks — failing ones in full, passing ones counted by area. No client data: no records, no
// acceptance sample data, no compliance fields; every string is scrubbed (T0 only, data-boundary.yaml#call_types).
import type { AppSpec, SystemBrief, SystemPlan } from "@wizard/appspec";
import { CUSTOM_FUNCTIONS_DIR } from "@wizard/appspec";
import { scrubJson } from "@wizard/pii";
import type { FixOutcome, TechCheck, TechSystem } from "./types.js";

/** A custom function source longer than this is cut in the digest. */
export const DIGEST_SOURCE_MAX = 6000;
/** Lists of the digest are cut to this many items. */
const LIST_MAX = 60;

export interface TechDigest {
  system: { name: string; niche: string; modules: { id: string; params?: Record<string, unknown> }[] };
  goals: string[];
  scenarios: string[];
  entities: { name: string; label: string; fields: string[]; unique: string[][] }[];
  roles: string[];
  permissions: string[];
  workflows: string[];
  functions: { name: string; kind: string; file: string; access: string; signature: string }[];
  /** Parts of the spec the module catalog does not make (extensions, custom code). */
  extensions: string[];
  integrations: string[];
  pages: string[];
  /** functions/custom/** sources (the builder's code; a fix may patch them). */
  custom: { file: string; source: string }[];
  checks: { open: TechCheck[]; passed: Record<string, number> };
  /** Fixes of earlier rounds. */
  applied: string[];
}

const cut = <T>(xs: readonly T[]): T[] => xs.slice(0, LIST_MAX);

function fieldLine(f: AppSpec["entities"][number]["fields"][number]): string {
  const ref = f.type === "ref" && f.ref?.entity ? `→${f.ref.entity}` : "";
  const pii = f.pii && f.pii !== "none" ? ` pii:${f.pii}` : "";
  return `${f.name}:${f.type}${ref}${f.required ? "!" : ""}${f.unique ? " unique" : ""}${pii}`;
}

function stepLine(s: { type: string; params?: unknown }): string {
  const p = (s.params ?? {}) as Record<string, unknown>;
  if (s.type === "notify") return `notify(${String(p.integration)}→${JSON.stringify(p.to)})`;
  if (s.type === "function") return `function(${String(p.name)})`;
  if (s.type === "update" || s.type === "create")
    return `${s.type}(${Object.keys((p.set ?? p.data ?? {}) as object).join(",")})`;
  return s.type;
}

/** `export default mutation({ args: {…} })` → `mutation({ id: v.id("lead") })`. */
export function signatureOf(source: string | undefined): string {
  if (!source) return "файл не найден";
  const m = /export\s+default\s+(query|mutation|action)\s*\(\s*\{\s*args\s*:\s*(\{[^}]*\})/.exec(source);
  if (m) return `${m[1]}(${m[2]?.replace(/\s+/g, " ")})`;
  const k = /export\s+default\s+(query|mutation|action)\b/.exec(source);
  return k ? `${k[1]}(…)` : "без экспорта функции";
}

const names = <T extends { name: string }>(xs: readonly T[] | undefined) =>
  new Set((xs ?? []).map((x) => x.name));

/** What the system has beyond the module catalog's spec (reference: the plan compiled by the catalog). */
export function extensionsOf(spec: AppSpec, reference: AppSpec | null): string[] {
  if (!reference) return [];
  const out: string[] = [];
  const refEntities = new Map(reference.entities.map((e) => [e.name, e]));
  for (const e of spec.entities) {
    const r = refEntities.get(e.name);
    if (!r) out.push(`сущность ${e.name}`);
    else
      for (const f of e.fields)
        if (!r.fields.some((x) => x.name === f.name)) out.push(`поле ${e.name}.${f.name}`);
  }
  const roles = names(reference.roles);
  for (const r of spec.roles) if (!roles.has(r.name)) out.push(`роль ${r.name}`);
  const fns = names(reference.functions);
  for (const f of spec.functions ?? []) if (!fns.has(f.name)) out.push(`функция ${f.name} (${f.file})`);
  const ws = names(reference.workflows);
  for (const w of spec.workflows ?? []) if (!ws.has(w.name)) out.push(`автоматизация ${w.name}`);
  return out;
}

/** The digest of a system for the reviewer (scrubbed). */
export function techDigest(o: {
  brief: SystemBrief;
  plan: SystemPlan;
  system: TechSystem;
  reference: AppSpec | null;
  checks: readonly TechCheck[];
  fixes: readonly FixOutcome[];
}): TechDigest {
  const { spec, files } = o.system;
  const open = o.checks.filter((c) => c.status === "fail" || c.status === "warn");
  const passed: Record<string, number> = {};
  for (const c of o.checks) if (c.status === "pass") passed[c.area] = (passed[c.area] ?? 0) + 1;
  const digest: TechDigest = {
    system: {
      name: spec.app.name,
      niche: o.plan.niche,
      modules: o.plan.modules.map((m) => ({ id: m.id, ...(m.params ? { params: m.params } : {}) })),
    },
    goals: o.brief.goals.map((g) => g.text),
    scenarios: o.brief.scenarios.map(
      (s) => `${s.id} (${s.priority}, ${s.actor}): когда ${s.when} → ${s.then.join("; ")}`,
    ),
    entities: cut(spec.entities).map((e) => ({
      name: e.name,
      label: e.label,
      fields: e.fields.map(fieldLine),
      unique: (e.indexes ?? []).filter((i) => i.unique).map((i) => [...i.fields]),
    })),
    roles: spec.roles.map((r) => `${r.name} (${r.access}${r.selfSignup ? ", self-signup" : ""})`),
    permissions: cut(spec.permissions).map((p) =>
      [
        `${p.role} ${p.entity}: ${p.ops.join(",") || "—"}`,
        p.rowFilter && Object.keys(p.rowFilter).length ? `rowFilter ${JSON.stringify(p.rowFilter)}` : "",
        p.hiddenFields?.length ? `hidden ${p.hiddenFields.join(",")}` : "",
        p.readonlyFields?.length ? `readonly ${p.readonlyFields.join(",")}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    ),
    workflows: cut(spec.workflows ?? []).map((w, i) => {
      const t = w.trigger;
      const on = [
        t.type,
        t.entity,
        t.field ? `${t.field}${t.equals !== undefined ? `=${String(t.equals)}` : ""}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `/workflows/${i} ${w.name}: ${on} → ${w.steps.map(stepLine).join(", ")}`;
    }),
    functions: cut(spec.functions ?? []).map((f) => ({
      name: f.name,
      kind: f.kind,
      file: f.file,
      access: f.public ? `public${f.roles?.length ? ` ${f.roles.join(",")}` : ""}` : "internal",
      signature: signatureOf(files.get(f.file)),
    })),
    extensions: cut(extensionsOf(spec, o.reference)),
    integrations: (spec.integrations ?? []).map((x) => `${x.name} (${x.connector})`),
    pages: cut(spec.pages ?? []).map((p) => `${p.route} [${(p.roles ?? []).join(",")}]`),
    custom: [...files]
      .filter(([p]) => p.startsWith(CUSTOM_FUNCTIONS_DIR))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 6)
      .map(([file, source]) => ({
        file,
        source:
          source.length > DIGEST_SOURCE_MAX ? `${source.slice(0, DIGEST_SOURCE_MAX)}\n// …обрезано` : source,
      })),
    checks: { open: cut(open), passed },
    applied: o.fixes.map(
      (f) =>
        `${f.finding} (${f.kind}, раунд ${f.round}): ${f.applied ? "применено" : `не применено — ${f.reason_ru ?? ""}`}`,
    ),
  };
  return scrubJson(digest).value;
}
