// Brief updates of the v3 interview: a patch (the model's submit_brief_update or a fallback option) is merged into the
// brief — list items by id or by their main text, never wiped — then the brief is validated (validateBrief, C1) as a
// whole. Ids the model left out are made here; references to unknown goals and modules are dropped; personal data
// fields are marked by their names. The question → answer journal and the assumptions are written by code only.
import { BRIEF_LIMITS, type BriefQa, type SystemBrief, validateBrief } from "@wizard/appspec";
import type { ModuleRegistry } from "@wizard/modules";
import { scrubJson } from "@wizard/pii";
import type { ToolIssue } from "../core/tool.js";
import { DEFAULT_REGISTRY } from "../planner/catalog.js";
import { clip } from "../planner/tolerant.js";
import { capabilityMap, normText } from "./capability.js";
import type { BriefPatch, ExtraRequirement } from "./schemas.js";

const IDENT = /^[a-z][a-z0-9_]{0,39}$/;

/** Known role names → stable ids (the rest get r1, r2, …). */
const ROLE_IDS: readonly (readonly [RegExp, string])[] = [
  [/владел/, "owner"],
  [/администратор/, "admin"],
  [/менеджер/, "manager"],
  [/мастер/, "master"],
  [/врач|доктор/, "doctor"],
  [/тренер/, "coach"],
  [/преподавател|педагог|учител/, "teacher"],
  [/бухгалтер/, "accountant"],
  [/курьер/, "courier"],
  [/сотрудник|персонал/, "staff"],
];

/** Field names that hold personal data (152-ФЗ): marked pii when the patch does not say. */
const PII_FIELD =
  /имя|фио|фамили|отчеств|телефон|почт|email|e-mail|адрес|рождени|паспорт|снилс|инн(?![\p{L}])/u;

function freeId(prefix: string, taken: Set<string>): string {
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  const id = `${prefix}${n}`;
  taken.add(id);
  return id;
}

/** Upsert of keyed items: same id, else same main text → replace; else append with a new id. */
function upsert<T extends { id: string }>(
  items: T[],
  incoming: readonly (Omit<T, "id"> & { id?: string | undefined })[],
  textOf: (x: Omit<T, "id">) => string,
  newId: (x: Omit<T, "id">, taken: Set<string>) => string,
): T[] {
  const out = [...items];
  const taken = new Set(out.map((x) => x.id));
  for (const raw of incoming) {
    const { id: rawId, ...rest } = raw as Omit<T, "id"> & { id?: string };
    const at =
      rawId && IDENT.test(rawId)
        ? out.findIndex((x) => x.id === rawId)
        : out.findIndex((x) => normText(textOf(x)) === normText(textOf(rest as Omit<T, "id">)));
    if (at >= 0) {
      out[at] = { ...(rest as Omit<T, "id">), id: out[at]?.id } as T;
      continue;
    }
    const id = rawId && IDENT.test(rawId) && !taken.has(rawId) ? rawId : newId(rest as Omit<T, "id">, taken);
    taken.add(id);
    out.push({ ...(rest as Omit<T, "id">), id } as T);
  }
  return out;
}

function roleId(name: string, taken: Set<string>): string {
  const t = normText(name);
  const known = ROLE_IDS.find(([re]) => re.test(t))?.[1];
  if (known && !taken.has(known)) return known;
  return freeId("r", taken);
}

export interface PatchOptions {
  /** Source of the patch's assumptions: default — the agent's decision; owner_skip — «Дальше решай сам». */
  assumptionSource: "default" | "owner_skip";
  registry?: ModuleRegistry;
}

export type PatchResult = { ok: true; brief: SystemBrief } | { ok: false; issues: ToolIssue[] };

/** Merges a patch into a brief and validates the result (Russian issues with the place on failure). */
export function applyBriefPatch(brief: SystemBrief, patch: BriefPatch, o: PatchOptions): PatchResult {
  const registry = o.registry ?? DEFAULT_REGISTRY;
  const catalog = new Set(registry.modules.map((d) => d.manifest.id));
  // Personal data never reaches the brief (it goes to T1 at later stages, D50): placeholders instead.
  const p = scrubJson(patch).value;
  const b: SystemBrief = structuredClone(brief);

  if (p.goals?.length)
    b.goals = upsert(
      b.goals,
      p.goals.map((g) => ({ id: g.id, text: g.text, success: g.success })),
      (g) => g.text,
      (_, taken) => freeId("g", taken),
    );
  if (p.audience?.trim()) b.audience = clip(p.audience, BRIEF_LIMITS.longText);
  if (p.roles?.length)
    b.roles = upsert(
      b.roles,
      p.roles.map((r) => ({ id: r.id, name: r.name, can: r.can })),
      (r) => r.name,
      (r, taken) => roleId(r.name, taken),
    );
  if (p.scenarios?.length) {
    const goals = new Set(b.goals.map((g) => g.id));
    b.scenarios = upsert(
      b.scenarios,
      p.scenarios.map((s) => ({
        id: s.id,
        actor: s.actor,
        when: s.when,
        // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
        then: s.then,
        ...(s.goalId && goals.has(s.goalId) ? { goalId: s.goalId } : {}),
        ...(s.moduleHint && catalog.has(s.moduleHint) ? { moduleHint: s.moduleHint } : {}),
        priority: s.priority,
      })),
      (s) => s.when,
      (_, taken) => freeId("s", taken),
    );
  }
  for (const d of p.data ?? []) {
    const item = {
      entity: d.entity,
      fields: d.fields.map((f) => ({
        name: f.name,
        ...((f.pii ?? PII_FIELD.test(normText(f.name))) ? { pii: true } : {}),
      })),
      retention: d.retention,
    };
    const at = b.data.findIndex((x) => normText(x.entity) === normText(d.entity));
    if (at >= 0) b.data[at] = item;
    else b.data.push(item);
  }
  if (p.integrations?.length)
    b.integrations = upsert(
      b.integrations,
      p.integrations.map((i) => ({
        id: i.id,
        name: i.name,
        direction: i.direction,
        ...(i.contractRef && /^\S+$/.test(i.contractRef) ? { contractRef: i.contractRef } : {}),
      })),
      (i) => i.name,
      (_, taken) => freeId("i", taken),
    );
  for (const x of p.outOfScope ?? []) {
    const at = b.outOfScope.findIndex((y) => normText(y.text) === normText(x.text));
    if (at >= 0) b.outOfScope[at] = { ...b.outOfScope[at], ...x };
    else b.outOfScope.push(x);
  }
  for (const a of p.assumptions ?? []) addAssumption(b, a.text, o.assumptionSource);
  return validated(b);
}

/** Validates a brief after code edits; issues name the place in Russian. */
export function validated(b: SystemBrief): PatchResult {
  const v = validateBrief(trimToLimits(b));
  if (v.ok) return { ok: true, brief: v.brief };
  return {
    ok: false,
    issues: v.errors.slice(0, 10).map((e) => ({ path: e.path, code: e.code, message: e.message_ru })),
  };
}

/** Lists cut to the brief limits (the newest assumptions and answers win the room). */
function trimToLimits(b: SystemBrief): SystemBrief {
  const L = BRIEF_LIMITS;
  return {
    ...b,
    goals: b.goals.slice(0, L.goals),
    scenarios: b.scenarios.slice(0, L.scenarios),
    roles: b.roles.slice(0, L.roles),
    data: b.data.slice(0, L.data),
    integrations: b.integrations.slice(0, L.integrations),
    outOfScope: b.outOfScope.slice(0, L.outOfScope),
    assumptions: b.assumptions.slice(-L.assumptions),
    qa: b.qa.slice(-L.qa),
    capability: b.capability.slice(0, L.capability),
  };
}

/** An assumption (deduplicated by text). */
export function addAssumption(b: SystemBrief, text: string, source: "default" | "owner_skip"): void {
  const t = clip(scrubJson(text).value, BRIEF_LIMITS.text);
  if (!t || b.assumptions.some((a) => normText(a.text) === normText(t))) return;
  b.assumptions.push({ text: t, source });
}

/** A line of the question → answer journal. */
export function addQa(b: SystemBrief, qa: BriefQa): void {
  b.qa.push({
    q: clip(qa.q, BRIEF_LIMITS.question),
    a: clip(scrubJson(qa.a).value, BRIEF_LIMITS.longText),
    recommended: clip(qa.recommended, BRIEF_LIMITS.question),
    chosen: qa.chosen,
  });
}

/**
 * The capability map by code (capability.ts) and, for every «пока не умею», a line in «Не входит» with the
 * replacement. Returns the verdicts so the caller can record the development requests.
 */
export function refreshCapability(
  b: SystemBrief,
  extras: readonly ExtraRequirement[],
  registry: ModuleRegistry = DEFAULT_REGISTRY,
): ReturnType<typeof capabilityMap> {
  const map = capabilityMap(b, extras, registry, BRIEF_LIMITS.capability);
  b.capability = map.capability;
  for (const v of map.verdicts) {
    if (v.level !== "not_yet") continue;
    const text = clip(`Пока не умею: ${v.text}`, BRIEF_LIMITS.text);
    if (b.outOfScope.some((x) => normText(x.text) === normText(text))) continue;
    b.outOfScope.push({
      text,
      ...(v.substitute ? { substitute: clip(v.substitute, BRIEF_LIMITS.text) } : {}),
    });
  }
  return map;
}
