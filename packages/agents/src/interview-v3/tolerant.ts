// Tolerant reading of the v3 interview tools (like planner/tolerant.ts, B2-41): small slips of open models — a string
// instead of a list, Russian topic or actor names, an option without the recommended mark, ids that are not
// identifiers, a wrapper object, overlong texts — are fixed in code before zod, so they cost no repair call. What
// cannot be guessed stays an issue for the model (it sees it as the tool result and calls again).
import { looseJson, looseObject } from "../core/loose-json.js";
import { clip } from "../planner/tolerant.js";
import { DEFAULT_RETENTION, DELEGATE_OPTION_ID, V3_TOPICS } from "./schemas.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** A list from a list, a JSON string of a list, a separated string (when splitText) or a single object. */
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
      .split(/[;\n]/)
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

const truthy = (v: unknown) => v === true || v === "true" || v === 1 || v === "yes" || v === "да";
const IDENT = /^[a-z][a-z0-9_]{0,39}$/;
const lower = (s: string) => s.toLowerCase().replace(/ё/g, "е");

const TOPIC_RU: readonly (readonly [RegExp, string])[] = [
  [/цел/, "goals"],
  [/аудитор|клиент|посетител/, "audience"],
  [/сценари/, "scenarios"],
  [/данн/, "data"],
  [/рол|доступ/, "roles"],
  [/интеграц/, "integrations"],
  [/контент|текст/, "content"],
  [/огранич|запуск|срок/, "constraints"],
];

/** A tree topic from an English id or a Russian word; undefined when it cannot be guessed. */
export function topicOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = lower(v.trim());
  if ((V3_TOPICS as readonly string[]).includes(t)) return t;
  return TOPIC_RU.find(([re]) => re.test(t))?.[1];
}

const ACTOR_RU: readonly (readonly [RegExp, string])[] = [
  [/^(visitor|client|staff|owner|system)$/, ""],
  [/посетител|гост|покупател|пользовател/, "visitor"],
  [/клиент|пациент|ученик|зрител/, "client"],
  [/сотрудник|мастер|администратор|менеджер|врач|тренер|персонал/, "staff"],
  [/владел|собственник|руководител/, "owner"],
  [/систем|автомат|робот/, "system"],
];

function actorOf(v: unknown): string {
  const t = typeof v === "string" ? lower(v.trim()) : "";
  for (const [re, id] of ACTOR_RU) if (re.test(t)) return id || t;
  return "visitor";
}

function texts(v: unknown, max: number): string[] {
  return list(v, true)
    .map((x) =>
      isObj(x) ? pick(x, "text", "name", "label", "value") : typeof x === "string" ? x : undefined,
    )
    .filter((x): x is string => !!x?.trim())
    .map((x) => clip(x, max));
}

const optId = (v: string | undefined) => (v && IDENT.test(v) ? v : undefined);

/** submit_brief_update arguments → the shape briefPatchSchema expects where it can be guessed safely. */
export function normalizeBriefPatchArgs(raw: unknown): unknown {
  const top = looseObject(raw);
  if (!top) return raw;
  const wrapped = ["patch", "update", "brief", "arguments", "input"].map((k) => top[k]).find(isObj);
  const a = (wrapped as Obj | undefined) ?? top;
  const out: Obj = {};

  if (a.goals !== undefined)
    out.goals = list(a.goals)
      .map((g) => {
        const x: Obj = isObj(g) ? g : { text: g };
        const text = pick(x, "text", "statement", "goal", "title", "name");
        if (!text) return null;
        const success = pick(x, "success", "successSign", "success_sign", "metric", "kpi", "result");
        return {
          ...(optId(pick(x, "id")) ? { id: pick(x, "id") } : {}),
          text: clip(text, 400),
          success: clip(success ?? "Признак успеха уточним с владельцем", 400),
        };
      })
      .filter(Boolean);

  if (a.audience !== undefined) {
    const aud = Array.isArray(a.audience) ? texts(a.audience, 400).join("; ") : pick(a, "audience");
    if (aud !== undefined) out.audience = clip(aud, 2000);
  }

  if (a.scenarios !== undefined)
    out.scenarios = list(a.scenarios)
      .map((s) => {
        if (!isObj(s)) return null;
        const when = pick(s, "when", "trigger", "if", "situation", "event");
        const then = texts(s.then ?? s.actions ?? s.system ?? s.result ?? s.does, 400);
        if (!when || then.length === 0) return null;
        const pr = lower(pick(s, "priority") ?? "must");
        return {
          ...(optId(pick(s, "id")) ? { id: pick(s, "id") } : {}),
          actor: actorOf(s.actor ?? s.who),
          when: clip(when, 400),
          // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
          then: then.slice(0, 12),
          ...(optId(pick(s, "goalId", "goal")) ? { goalId: pick(s, "goalId", "goal") } : {}),
          ...(optId(pick(s, "moduleHint", "module")) ? { moduleHint: pick(s, "moduleHint", "module") } : {}),
          priority: pr === "should" || pr.startsWith("желат") ? "should" : "must",
        };
      })
      .filter(Boolean);

  if (a.roles !== undefined)
    out.roles = list(a.roles)
      .map((r) => {
        const x: Obj = isObj(r) ? r : { name: r };
        const name = pick(x, "name", "title", "role", "label");
        if (!name) return null;
        return {
          ...(optId(pick(x, "id")) ? { id: pick(x, "id") } : {}),
          name: clip(name, 120),
          can: texts(x.can ?? x.access ?? x.permissions ?? x.rights, 400).slice(0, 30),
        };
      })
      .filter(Boolean);

  if (a.data !== undefined)
    out.data = list(a.data)
      .map((d) => {
        const x: Obj = isObj(d) ? d : { entity: d };
        const entity = pick(x, "entity", "name", "title", "what");
        if (!entity) return null;
        const fields = list(x.fields ?? x.columns, true)
          .map((f) => {
            const y: Obj = isObj(f) ? f : { name: f };
            const name = pick(y, "name", "title", "label", "field");
            if (!name) return null;
            return { name: clip(name, 120), ...(y.pii !== undefined ? { pii: truthy(y.pii) } : {}) };
          })
          .filter(Boolean)
          .slice(0, 60);
        return {
          entity: clip(entity, 120),
          fields,
          retention: clip(pick(x, "retention", "keep", "storage", "ttl") ?? DEFAULT_RETENTION, 400),
        };
      })
      .filter(Boolean);

  if (a.integrations !== undefined)
    out.integrations = list(a.integrations)
      .map((i) => {
        const x: Obj = isObj(i) ? i : { name: i };
        const name = pick(x, "name", "service", "title");
        if (!name) return null;
        const dir = lower(pick(x, "direction") ?? "out");
        const ref = pick(x, "contractRef", "contract", "docs");
        return {
          ...(optId(pick(x, "id")) ? { id: pick(x, "id") } : {}),
          name: clip(name, 120),
          direction: dir === "in" || dir.startsWith("вход") ? "in" : "out",
          ...(ref && /^\S+$/.test(ref) ? { contractRef: ref.slice(0, 500) } : {}),
        };
      })
      .filter(Boolean);

  if (a.outOfScope !== undefined || a.out_of_scope !== undefined)
    out.outOfScope = list(a.outOfScope ?? a.out_of_scope)
      .map((o) => {
        const x: Obj = isObj(o) ? o : { text: o };
        const text = pick(x, "text", "request", "what", "item");
        if (!text) return null;
        const sub = pick(x, "substitute", "replacement", "offer", "instead");
        return { text: clip(text, 400), ...(sub ? { substitute: clip(sub, 400) } : {}) };
      })
      .filter(Boolean);

  for (const k of ["assumptions", "requirements"] as const) {
    if (a[k] === undefined) continue;
    out[k] = list(a[k])
      .map((o) => {
        const x: Obj = isObj(o) ? o : { text: o };
        const text = pick(x, "text", "assumption", "requirement", "what");
        if (!text) return null;
        const hint = k === "requirements" ? optId(pick(x, "moduleHint", "module")) : undefined;
        return { text: clip(text, 400), ...(hint ? { moduleHint: hint } : {}) };
      })
      .filter(Boolean);
  }

  if (a.facts !== undefined)
    out.facts = list(a.facts)
      .map((o) => {
        if (!isObj(o)) return null;
        const text = pick(o, "text", "fact", "summary");
        const url = pick(o, "url", "source", "link");
        if (!text || !url || !/^https?:\/\/\S+$/.test(url)) return null;
        return { text: clip(text, 300), url };
      })
      .filter(Boolean)
      .slice(0, 10);
  return out;
}

/** Options of a question: labels, identifier ids, exactly one recommended (named on the question, else the first). */
function options(q: Obj): Obj[] {
  const raw = list(q.options ?? q.choices ?? q.variants ?? q.answers);
  const recHint = pick(q, "recommended", "recommendedOption", "default");
  const seen = new Set<string>();
  const out: Obj[] = [];
  raw.forEach((o, i) => {
    const x: Obj = isObj(o) ? o : typeof o === "string" ? { label: o } : {};
    const label = pick(x, "label", "text", "title", "name", "value");
    if (!label) return;
    let id = optId(pick(x, "id", "key", "value")) ?? `o${i + 1}`;
    // «Решите за меня» is the platform's own button, never a model option.
    if (id === DELEGATE_OPTION_ID || seen.has(id)) id = `o${i + 1}`;
    if (seen.has(id)) return;
    seen.add(id);
    const description = pick(x, "description", "hint");
    out.push({
      id,
      label: clip(label, 80),
      ...(description ? { description: clip(description, 160) } : {}),
      recommended: truthy(x.recommended ?? x.isRecommended ?? x.default),
      _rawId: pick(x, "id"),
    });
  });
  const kept = out.slice(0, 5);
  if (!kept.some((o) => o.recommended)) {
    const hinted = recHint
      ? kept.find((o) => o._rawId === recHint || o.id === recHint || o.label === recHint)
      : undefined;
    const target = hinted ?? kept[0];
    if (target) target.recommended = true;
  }
  let one = false;
  for (const o of kept) {
    delete o._rawId;
    if (o.recommended && !one) one = true;
    else o.recommended = false;
  }
  return kept;
}

/** submit_question arguments → the shape v3QuestionInputSchema expects where it can be guessed safely. */
export function normalizeQuestionArgs(raw: unknown): unknown {
  const top = looseObject(raw);
  if (!top) return raw;
  const a = isObj(top.question) ? top.question : top;
  const out: Obj = { ...a };
  const topic = topicOf(a.topic);
  if (topic) out.topic = topic;
  const text = pick(a, "text", "question", "title");
  if (text) out.text = clip(text, 200);
  const why = pick(a, "whyItMatters", "why", "reason");
  if (why) out.whyItMatters = clip(why, 240);
  const opts = options(a);
  out.options = opts;
  const rec = opts.find((o) => o.recommended) as Obj | undefined;
  const recWhy =
    pick(a, "recommendation", "recommendationWhy", "whyRecommended", "recommended_reason") ??
    (typeof rec?.description === "string" ? rec.description : undefined) ??
    "Подходит для начала, потом можно поменять в брифе.";
  out.recommendation = clip(recWhy, 240);
  out.allowDelegate = typeof a.allowDelegate === "boolean" ? a.allowDelegate : true;
  return out;
}

/** defer_question arguments → topic, text and the assumption meanwhile. */
export function normalizeDeferArgs(raw: unknown): unknown {
  const a = looseObject(raw);
  if (!a) return raw;
  const out: Obj = { ...a };
  const topic = topicOf(a.topic);
  if (topic) out.topic = topic;
  const text = pick(a, "text", "question");
  if (text) out.text = clip(text, 200);
  const assumption = pick(a, "assumption", "default", "meanwhile", "recommended");
  if (assumption) out.assumption = clip(assumption, 300);
  return out;
}
