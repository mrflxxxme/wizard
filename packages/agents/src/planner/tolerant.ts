// Tolerant reading of submit_goals and submit_plan (B2-41, like the D75 template step 1): small slips of open models are
// fixed in code before zod — a string instead of a list, an option without the recommended mark, extra questions or
// options, an unknown topic, overlong texts, a wrapper object — so they cost no repair call. What cannot be guessed
// (no niche, no valid goal, a broken plan) stays an issue for the model (≤ 2 repairs), then the fallback (fallback.ts).
import { GOAL_IDS, goalLabel, OUT_OF_SCOPE_CATEGORIES } from "@wizard/appspec";
import { type ModuleRegistry, planCatalog } from "@wizard/modules";
import { looseJson, looseObject } from "../core/loose-json.js";
import { GOAL_TOPICS, MAX_GOAL_QUESTIONS, plannerPlanSchema } from "./schemas.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** A list from a list, a JSON string of a list, a comma/line separated string, or a single object. */
function list(v: unknown, splitText = false): unknown[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("[")) {
      const j = looseJson(t);
      if (Array.isArray(j)) return j;
    }
    if (!splitText) return t ? [t] : [];
    return t
      .split(/[,;\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (isObj(v)) return [v];
  return [];
}

/** First non-empty string among the keys. */
function pick(o: Obj, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/** Cuts a text to `max` characters at a word boundary. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.—-]+$/, "")}…`;
}

const truthy = (v: unknown) => v === true || v === "true" || v === 1 || v === "yes";

function options(q: Obj): Obj[] {
  const raw = list(q.options ?? q.choices ?? q.variants ?? q.answers);
  const recHint = pick(q, "recommended", "recommendation", "recommendedOption", "default");
  const seen = new Set<string>();
  const out: Obj[] = [];
  raw.forEach((o, i) => {
    const x: Obj = isObj(o) ? o : typeof o === "string" ? { label: o } : {};
    const label = pick(x, "label", "text", "title", "name", "value");
    if (!label) return;
    let id = (pick(x, "id", "value", "key") ?? `o${i + 1}`).slice(0, 40);
    if (seen.has(id)) id = `o${i + 1}`;
    if (seen.has(id)) return;
    seen.add(id);
    const description = pick(x, "description", "hint");
    out.push({
      id,
      label: clip(label, 60),
      ...(description ? { description: clip(description, 140) } : {}),
      recommended: truthy(x.recommended ?? x.isRecommended ?? x.default),
    });
  });
  const kept = out.slice(0, 4);
  // A recommendation named on the question, or else the first option (D75 step 1: «not marked → the first»).
  if (!kept.some((o) => o.recommended)) {
    const hinted = recHint ? kept.find((o) => o.id === recHint || o.label === recHint) : undefined;
    const target = hinted ?? kept[0];
    if (target) target.recommended = true;
  }
  let one = false;
  for (const o of kept) {
    if (o.recommended && !one) one = true;
    else o.recommended = false;
  }
  return kept;
}

/**
 * submit_goals arguments as the model sent them → the shape goalsAnalysisSchema expects where it can be guessed safely.
 * Unknown modules and goals are dropped (the planner works from the catalog anyway); a question without two options is
 * dropped; questions are renumbered q1…qN.
 */
export function normalizeGoalsArgs(raw: unknown, registry: ModuleRegistry): unknown {
  const top = looseObject(raw);
  if (!top) return raw;
  const wrapped = ["analysis", "arguments", "input", "result", "goals_analysis"]
    .map((k) => top[k])
    .find((v) => isObj(v) && ("goals" in v || "niche" in v));
  const a = (wrapped as Obj | undefined) ?? top;
  const catalog = planCatalog(registry).modules;
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const goalIds = new Set<string>(GOAL_IDS);
  const out: Obj = { ...a };

  const niche = Array.isArray(a.niche) ? a.niche.find((x) => typeof x === "string") : a.niche;
  if (typeof niche === "string" && niche.trim()) out.niche = clip(niche, 80);

  const goals: Obj[] = [];
  for (const g of list(a.goals, true)) {
    const x: Obj = isObj(g) ? g : { id: g };
    const id = pick(x, "id", "goal", "goalId");
    if (!id || !goalIds.has(id) || goals.some((y) => y.id === id)) continue;
    const st = pick(x, "statement", "text", "label", "description");
    goals.push({ id, statement: st && st.length >= 3 ? clip(st, 200) : goalLabel(id) });
  }
  if (goals.length) out.goals = goals.slice(0, 3);

  const strings = (v: unknown, max: number) =>
    [
      ...new Set(
        list(v, true)
          .map((x) => (isObj(x) ? pick(x, "name", "label", "title") : typeof x === "string" ? x : undefined))
          .filter((x): x is string => !!x?.trim())
          .map((x) => clip(x, 60)),
      ),
    ].slice(0, max);
  out.roles = strings(a.roles, 6);
  out.resources = strings(a.resources, 10);

  const modules: Obj[] = [];
  for (const m of list(a.modules, true)) {
    const x: Obj = isObj(m) ? m : { id: m };
    const id = pick(x, "id", "module", "name");
    if (!id || !byId.has(id) || modules.some((y) => y.id === id)) continue;
    const why = pick(x, "why", "reason", "description");
    modules.push({ id, why: clip(why ?? `Нужен для целей: ${byId.get(id)?.name ?? id}`, 160) });
  }
  out.modules = modules.slice(0, 12);

  const categories = new Set<string>(OUT_OF_SCOPE_CATEGORIES);
  out.outOfScope = list(a.outOfScope ?? a.out_of_scope)
    .map((o) => {
      const x: Obj = isObj(o) ? o : { request: o };
      const request = pick(x, "request", "what", "text", "item");
      if (!request) return null;
      const category = pick(x, "category");
      return {
        request: clip(request, 300),
        category: category && categories.has(category) ? category : "other",
      };
    })
    .filter((x) => x !== null)
    .slice(0, 10);

  const topics = new Set<string>(GOAL_TOPICS);
  const questions: Obj[] = [];
  for (const q of list(a.questions)) {
    if (!isObj(q)) continue;
    const text = pick(q, "text", "question", "title");
    const opts = options(q);
    if (!text || opts.length < 2) continue;
    const mod = pick(q, "module");
    const param = pick(q, "param", "parameter");
    const known = !!mod && !!param && !!byId.get(mod)?.params.some((p) => p.name === param);
    let topic = pick(q, "topic");
    if (!topic || !topics.has(topic)) topic = known ? "params" : "goals";
    // A params question needs a catalog module and parameter; without them it is a plain question.
    if (topic === "params" && !known) topic = "goals";
    const why = pick(q, "whyItMatters", "why", "reason", "description");
    questions.push({
      id: `q${questions.length + 1}`,
      topic,
      ...(topic === "params" ? { module: mod, param } : {}),
      text: clip(text, 140),
      whyItMatters: clip(why ?? "Ответ поможет точнее составить план системы", 160),
      options: opts,
      allowCustom: typeof q.allowCustom === "boolean" ? q.allowCustom : true,
    });
    if (questions.length === MAX_GOAL_QUESTIONS) break;
  }
  out.questions = questions;
  return out;
}

const PLAN_KEYS = new Set(Object.keys(plannerPlanSchema.shape));

/**
 * submit_plan arguments → a plan object: decoded from text, unwrapped from {plan: …}, unknown top-level keys and a
 * wrong version dropped (the strict schema would reject the whole plan for them). Everything deeper is validated as is.
 */
export function normalizePlanArgs(raw: unknown): unknown {
  const top = looseObject(raw);
  if (!top) return raw;
  const inner = isObj(top.plan) && !("goals" in top) ? top.plan : top;
  const out: Obj = {};
  for (const [k, v] of Object.entries(inner)) if (PLAN_KEYS.has(k) && v !== null) out[k] = v;
  if (out.version !== 1) delete out.version;
  return out;
}
