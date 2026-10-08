// The three diagrams of a brief (D77 (9), builder-v3.md §3 C1): customer journey, data and roles, integrations. They are
// built by code, not by a model — the same brief always gives the same graphs, the UI only lays them out. The function
// is total: whatever it gets (an old version, a half-filled draft, garbage) it returns graphs and never throws; the
// parts it cannot read are skipped.
import { BRIEF_ACTORS, type BriefActor } from "./schema.js";

export const BRIEF_NODE_KINDS = [
  "actor",
  "scenario",
  "goal",
  "role",
  "entity",
  "entity_pii",
  "system",
  "integration",
  "empty",
] as const;
export type BriefNodeKind = (typeof BRIEF_NODE_KINDS)[number];

export interface BriefNode {
  id: string;
  /** Russian label, one line, at most BRIEF_LABEL_MAX characters. */
  label: string;
  kind: BriefNodeKind;
}

export interface BriefEdge {
  from: string;
  to: string;
  /** Russian label of the link. */
  label: string;
}

export interface BriefGraph {
  nodes: BriefNode[];
  edges: BriefEdge[];
}

export interface BriefDiagrams {
  /** Customer journey: scenarios in the order of the brief, who acts in them and which goal they serve. */
  journey: BriefGraph;
  /** Data and roles: roles, what is stored (with ПДн and retention) and who can do what with it. */
  dataRoles: BriefGraph;
  /** Integrations: the system and the external services it calls or that call it. */
  integrations: BriefGraph;
}

/** Russian titles of the three diagrams. */
export const BRIEF_DIAGRAM_TITLES: Readonly<Record<keyof BriefDiagrams, string>> = {
  journey: "Путь клиента",
  dataRoles: "Данные и роли",
  integrations: "Интеграции",
};

/** Labels are cut to this many characters (with «…»). */
export const BRIEF_LABEL_MAX = 160;
/** A graph keeps at most this many nodes (a brief within BRIEF_LIMITS stays below it). */
export const BRIEF_GRAPH_MAX_NODES = 300;

const ACTOR_LABELS: Record<BriefActor, string> = {
  visitor: "Посетитель",
  client: "Клиент",
  staff: "Сотрудник",
  owner: "Владелец",
  system: "Система",
};
const ACTOR_ORDER: readonly BriefActor[] = ["visitor", "client", "staff", "owner", "system"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const objs = (v: unknown, max: number): Obj[] => (Array.isArray(v) ? v.slice(0, max).filter(isObj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const strs = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.slice(0, max).map(str).filter(Boolean) : [];

function label(s: string, fallback: string): string {
  const t = s || fallback;
  return t.length > BRIEF_LABEL_MAX ? `${t.slice(0, BRIEF_LABEL_MAX - 1)}…` : t;
}

/** Collects nodes with unique ids (an id that is not a safe token, or repeats, gets a positional one). */
class GraphBuilder {
  readonly nodes: BriefNode[] = [];
  readonly edges: BriefEdge[] = [];
  private readonly ids = new Set<string>();

  add(prefix: string, raw: unknown, index: number, text: string, kind: BriefNodeKind): string | null {
    if (this.nodes.length >= BRIEF_GRAPH_MAX_NODES) return null;
    const safe = typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : `n${index + 1}`;
    let id = `${prefix}:${safe}`;
    for (let n = 2; this.ids.has(id); n++) id = `${prefix}:${safe}~${n}`;
    this.ids.add(id);
    this.nodes.push({ id, label: text, kind });
    return id;
  }

  link(from: string | null | undefined, to: string | null | undefined, text: string): void {
    if (from && to && from !== to) this.edges.push({ from, to, label: label(text, "") });
  }

  graph(emptyText: string): BriefGraph {
    if (this.nodes.length === 0) this.nodes.push({ id: "empty", label: emptyText, kind: "empty" });
    return { nodes: this.nodes, edges: this.edges };
  }
}

function journey(b: Obj): BriefGraph {
  const g = new GraphBuilder();
  const goals = new Map<string, string>();
  objs(b.goals, 50).forEach((goal, i) => {
    const id = g.add("goal", goal.id, i, label(str(goal.text), "Цель без описания"), "goal");
    if (id && typeof goal.id === "string" && !goals.has(goal.id)) goals.set(goal.id, id);
  });
  const scenarios = objs(b.scenarios, 200);
  const actors = new Map<BriefActor, string>();
  const used = new Set(scenarios.map((s) => s.actor));
  for (const actor of ACTOR_ORDER)
    if (used.has(actor)) {
      const id = g.add("actor", actor, 0, ACTOR_LABELS[actor], "actor");
      if (id) actors.set(actor, id);
    }
  let prev: string | null = null;
  scenarios.forEach((s, i) => {
    const when = str(s.when);
    const then = strs(s.then, 20);
    const text =
      (when ? `Когда ${when}` : "Когда …") +
      (then.length ? `, система: ${then.join("; ")}` : "") +
      (s.priority === "should" ? " (желательно)" : "");
    const id = g.add("scenario", s.id, i, label(text, "Сценарий"), "scenario");
    if (!id) return;
    const actor = (BRIEF_ACTORS as readonly unknown[]).includes(s.actor) ? (s.actor as BriefActor) : null;
    if (actor) g.link(actors.get(actor), id, actor === "system" ? "срабатывает" : "действует");
    g.link(prev, id, "затем");
    if (typeof s.goalId === "string") g.link(id, goals.get(s.goalId), "цель");
    prev = id;
  });
  return g.graph("Сценарии пока не описаны");
}

/** Lower case, «ё» → «е»: Russian matching of entity names inside access texts. */
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
/** Stem of the first word of an entity name (≥ 3 letters), so «Заявка» matches «заявки», «заявок». */
function stem(entity: string): string | null {
  const word = norm(entity)
    .split(/[^a-zа-я0-9]+/)
    .find((w) => w.length >= 3);
  if (!word) return null;
  const cut = word.replace(/[аеиоуыэюяйь]{1,2}$/, "");
  return cut.length >= 3 ? cut : word;
}
/** Access to everything («полный доступ», «видит всё», «все данные», «все разделы»), in lower case with «ё». */
const ALL_ACCESS =
  /полн[а-яё]* доступ|ко всему|вс[её] данн|всем данным|вс[её] раздел|всем раздел|(^|[^а-яё])всё([^а-яё]|$)/;

function dataRoles(b: Obj): BriefGraph {
  const g = new GraphBuilder();
  const entities: { id: string; stem: string | null }[] = [];
  objs(b.data, 100).forEach((d, i) => {
    const name = str(d.entity) || "Данные без названия";
    const fields = objs(d.fields, 100);
    const pii = fields
      .filter((f) => f.pii === true)
      .map((f) => str(f.name))
      .filter(Boolean);
    const retention = str(d.retention);
    const text =
      name + (pii.length ? ` · ПДн: ${pii.join(", ")}` : "") + (retention ? ` · хранить: ${retention}` : "");
    const id = g.add("entity", null, i, label(text, name), pii.length ? "entity_pii" : "entity");
    if (id) entities.push({ id, stem: stem(name) });
  });
  objs(b.roles, 50).forEach((r, i) => {
    const id = g.add("role", r.id, i, label(str(r.name), "Роль без названия"), "role");
    if (!id) return;
    const can = strs(r.can, 50);
    for (const e of entities) {
      const hits = can.filter(
        (c) => ALL_ACCESS.test(c.toLowerCase()) || (e.stem !== null && norm(c).includes(e.stem)),
      );
      if (hits.length) g.link(id, e.id, hits.join("; "));
    }
  });
  return g.graph("Данные и роли пока не описаны");
}

function integrations(b: Obj): BriefGraph {
  const g = new GraphBuilder();
  const list = objs(b.integrations, 50);
  const system = g.add("system", "self", 0, "Ваша система", "system");
  list.forEach((x, i) => {
    const id = g.add("integration", x.id, i, label(str(x.name), "Сервис без названия"), "integration");
    const contract = str(x.contractRef) ? "контракт описан" : "контракт не описан";
    if (x.direction === "in") g.link(id, system, `входящая · ${contract}`);
    else {
      const key = str(x.secretRef) ? "ключ подключён" : "без ключа — работает на моке";
      g.link(system, id, `исходящая · ${contract} · ${key}`);
    }
  });
  if (list.length === 0) g.add("empty", "none", 0, "Интеграций нет", "empty");
  return g.graph("Интеграций нет");
}

const fallback = (text: string): BriefGraph => ({
  nodes: [{ id: "empty", label: text, kind: "empty" }],
  edges: [],
});

/**
 * The three diagrams of a brief, deterministically and without a model. Accepts any value: an invalid brief gives
 * graphs of what can be read, never an exception.
 */
export function briefDiagrams(brief: unknown): BriefDiagrams {
  const b = isObj(brief) ? brief : {};
  const safe = (build: (b: Obj) => BriefGraph, empty: string) => {
    try {
      return build(b);
    } catch {
      return fallback(empty);
    }
  };
  return {
    journey: safe(journey, "Сценарии пока не описаны"),
    dataRoles: safe(dataRoles, "Данные и роли пока не описаны"),
    integrations: safe(integrations, "Интеграций нет"),
  };
}
