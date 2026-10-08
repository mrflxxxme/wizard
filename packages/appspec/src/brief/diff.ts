// Versions of the system brief and the field-level difference between two of them (builder-v3.md §3 C1): every edit
// by the interview agent or by the owner is a new version that keeps its diff to the previous one — the «Бриф» panel
// highlights it, the session feed shows its Russian lines. Items of keyed lists are matched by id (or by their main
// text), so reordering is one «order» change, not a cascade of edits.
import {
  BRIEF_FIELD_LABELS,
  BRIEF_FIELDS,
  BRIEF_PROP_LABELS,
  type BriefField,
  emptyBrief,
  type SystemBrief,
} from "./schema.js";

/** Who wrote a version: the agent (interview, ТЗ extraction, build questions) or the owner (panel or chat edit). */
export const BRIEF_AUTHORS = ["agent", "owner"] as const;
export type BriefAuthor = (typeof BRIEF_AUTHORS)[number];
export const BRIEF_CHANGE_OPS = ["added", "changed", "removed"] as const;
export type BriefChangeOp = (typeof BRIEF_CHANGE_OPS)[number];

/** One change between two versions of a brief. */
export interface BriefChange {
  field: BriefField;
  /** Item of a list field: its id (goals, scenarios, roles, integrations) or main text; absent for audience, design and list order. */
  key?: string;
  /** Property of the item (or of design); «order» with no key — the order of the list; absent — the whole item or field. */
  prop?: string;
  op: BriefChangeOp;
  before?: unknown;
  after?: unknown;
  /** Russian line for the panel and the session feed. */
  text_ru: string;
}

/** A stored version of a brief: 1, 2, … per system; diff — to the previous version (to an empty brief for version 1). */
export interface BriefVersion {
  version: number;
  brief: SystemBrief;
  diff: BriefChange[];
  author: BriefAuthor;
  /** RFC 3339 UTC. */
  createdAt: string;
}

type Item = Record<string, unknown>;
type ListField = Exclude<BriefField, "audience" | "design">;

/** How items of a list field are matched between versions, named in texts, and which properties come first. */
const LISTS: Record<ListField, { key: (i: Item) => unknown; name: (i: Item) => unknown; props: string[] }> = {
  goals: { key: (i) => i.id, name: (i) => i.text, props: ["text", "success"] },
  scenarios: {
    key: (i) => i.id,
    name: (i) => (typeof i.when === "string" ? `Когда ${i.when}` : i.id),
    props: ["actor", "when", "then", "goalId", "moduleHint", "priority"],
  },
  roles: { key: (i) => i.id, name: (i) => i.name, props: ["name", "can"] },
  data: {
    key: (i) => (typeof i.entity === "string" ? i.entity.toLowerCase() : i.entity),
    name: (i) => i.entity,
    props: ["entity", "fields", "retention"],
  },
  integrations: {
    key: (i) => i.id,
    name: (i) => i.name,
    props: ["name", "direction", "contractRef", "secretRef"],
  },
  outOfScope: { key: (i) => i.text, name: (i) => i.text, props: ["substitute"] },
  assumptions: { key: (i) => i.text, name: (i) => i.text, props: ["source"] },
  qa: { key: (i) => i.q, name: (i) => i.q, props: ["a", "recommended", "chosen"] },
  capability: { key: (i) => i.requirement, name: (i) => i.requirement, props: ["level"] },
};
const DESIGN_PROPS = ["archetype", "pinned", "references"];

/** JSON with sorted keys; undefined properties are absent (as after a jsonb round trip). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stable(x))).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Item;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const isItem = (v: unknown): v is Item => !!v && typeof v === "object" && !Array.isArray(v);
const items = (v: unknown): Item[] => (Array.isArray(v) ? v.filter(isItem) : []);

function clip(v: unknown, max = 80): string {
  const s = typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function opOf(before: unknown, after: unknown): BriefChangeOp {
  if (isEmpty(before)) return "added";
  if (isEmpty(after)) return "removed";
  return "changed";
}

const OP_RU: Record<BriefChangeOp, string> = { added: "добавлено", changed: "изменено", removed: "удалено" };

/** Items with unique string keys: a repeated key gets «#2», «#3» (only an invalid brief repeats ids). */
function keyed(field: ListField, list: Item[]): Map<string, Item> {
  const out = new Map<string, Item>();
  list.forEach((item, i) => {
    const raw = LISTS[field].key(item);
    const base = typeof raw === "string" && raw !== "" ? raw : `#${i + 1}`;
    let k = base;
    for (let n = 2; out.has(k); n++) k = `${base}#${n}`;
    out.set(k, item);
  });
  return out;
}

function propsOf(order: readonly string[], a: Item, b: Item): string[] {
  const extra = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !order.includes(k)).sort();
  return [...order, ...extra];
}

function diffList(field: ListField, before: unknown, after: unknown, out: BriefChange[]): void {
  const spec = LISTS[field];
  const label = BRIEF_FIELD_LABELS[field];
  const a = keyed(field, items(before));
  const b = keyed(field, items(after));
  for (const [k, next] of b) {
    const prev = a.get(k);
    const name = clip(spec.name(next)) || k;
    if (!prev) {
      out.push({ field, key: k, op: "added", after: next, text_ru: `${label}: добавлено «${name}»` });
      continue;
    }
    for (const prop of propsOf(spec.props, prev, next)) {
      if (same(prev[prop], next[prop])) continue;
      const op = opOf(prev[prop], next[prop]);
      const change: BriefChange = {
        field,
        key: k,
        prop,
        op,
        text_ru: `${label}, «${name}»: ${OP_RU[op]} «${BRIEF_PROP_LABELS[prop] ?? prop}»`,
      };
      if (prev[prop] !== undefined) change.before = prev[prop];
      if (next[prop] !== undefined) change.after = next[prop];
      out.push(change);
    }
  }
  for (const [k, prev] of a)
    if (!b.has(k))
      out.push({
        field,
        key: k,
        op: "removed",
        before: prev,
        text_ru: `${label}: удалено «${clip(spec.name(prev)) || k}»`,
      });
  const kept = (m: Map<string, Item>, other: Map<string, Item>) => [...m.keys()].filter((k) => other.has(k));
  const orderBefore = kept(a, b);
  const orderAfter = kept(b, a);
  if (!same(orderBefore, orderAfter))
    out.push({
      field,
      prop: "order",
      op: "changed",
      before: orderBefore,
      after: orderAfter,
      text_ru: `${label}: изменён порядок`,
    });
}

/**
 * Field-level difference from version `a` to version `b` (null — an empty brief, for the first version). Changes come
 * in the order of BRIEF_FIELDS, then of the items of `b`, removed items last; equal briefs give [].
 */
export function briefDiff(a: SystemBrief | null, b: SystemBrief): BriefChange[] {
  const prev = (a ?? emptyBrief()) as unknown as Item;
  const next = b as unknown as Item;
  const out: BriefChange[] = [];
  for (const field of BRIEF_FIELDS) {
    const label = BRIEF_FIELD_LABELS[field];
    if (field === "audience") {
      if (same(prev.audience ?? "", next.audience ?? "")) continue;
      const op = opOf(prev.audience, next.audience);
      const change: BriefChange = { field, op, text_ru: `${label}: ${OP_RU[op]}` };
      if (!isEmpty(prev.audience)) change.before = prev.audience;
      if (!isEmpty(next.audience)) change.after = next.audience;
      out.push(change);
    } else if (field === "design") {
      const da = isItem(prev.design) ? prev.design : {};
      const db = isItem(next.design) ? next.design : {};
      for (const prop of propsOf(DESIGN_PROPS, da, db)) {
        const before = prop === "references" ? (da[prop] ?? []) : da[prop];
        const after = prop === "references" ? (db[prop] ?? []) : db[prop];
        if (same(before, after)) continue;
        const op = opOf(before, after);
        const change: BriefChange = {
          field,
          prop,
          op,
          text_ru: `${label}: ${OP_RU[op]} «${BRIEF_PROP_LABELS[prop] ?? prop}»`,
        };
        if (before !== undefined) change.before = before;
        if (after !== undefined) change.after = after;
        out.push(change);
      }
    } else diffList(field, prev[field], next[field], out);
  }
  return out;
}
