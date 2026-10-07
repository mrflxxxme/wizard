// Module factory (B2-26; docs/reviews/grill-6.md decision 4, product.yaml D73/D76, db.yaml#module_candidates,
// workflows.yaml#module_factory_cron): once a week «Запросы на развитие» and successful custom parts (the custom stage
// checkpoint of a plan build, B2-23) are grouped by category and a normalized wording and ranked by frequency — the
// candidates for new modules. The founder approves a candidate for work, disables it, or marks it ready with the id of
// a catalog module; then the requests it covers become «done» and every client who asked and agreed to letters gets
// «Теперь умеем: …» once per module (platform.module_announcements). No model is called.
import { availableModules, DEFAULT_REGISTRY, type ModuleRegistry } from "@wizard/agents/planner";
import { scrub } from "@wizard/pii";
import { sql } from "kysely";
import type { Mailer } from "../auth/mailer.js";
import type { Db } from "../db/index.js";
import type { ModuleCandidateStatus } from "../db/types.js";
import { invalid } from "../errors.js";
import { type DevelopmentCategory, isDevelopmentCategory } from "./service.js";

const DAY_MS = 86_400_000;
/** The rating window: requests and custom parts of the last 7 days rank first, all time breaks ties. */
export const FACTORY_WEEK_MS = 7 * DAY_MS;
/** Rows of «Запросы на развитие» a pass reads (newest first); the beta has far fewer. */
const MAX_REQUESTS = 20_000;
const MAX_PLANS = 5_000;
const EXAMPLES = 3;
const TITLE_MAX = 120;
const QUOTE_MAX = 200;

export const CANDIDATE_STATUSES = ["new", "approved", "disabled", "ready"] as const;
export type CandidateStatus = ModuleCandidateStatus;
export const CANDIDATE_ACTIONS = ["approve", "disable", "ready"] as const;
export type CandidateAction = (typeof CANDIDATE_ACTIONS)[number];

// Words that carry no subject in a client's request (Russian and a few English ones).
const STOP = new Set(
  (
    "и или а но в во на с со по для чтобы чтоб хочу хотим хотелось хотел хотела нужно нужна нужен нужны надо можно " +
    "бы мне нам мой моя мое мои наш наша наше наши ваш ваша вас вам о об к ко у из за от до не ни что это как так " +
    "же ли чем еще ещё уже было быть есть будет будут были тоже очень пожалуйста просто сделать сделайте добавить " +
    "добавьте чтобы клиент клиенты клиентов клиентам сайт сайте сайта система системе системы через при где когда " +
    "все всё всех свой свою свои своих его ее её их они он она мы вы кто который которая которые the a an to of and for"
  ).split(/\s+/),
);

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The subject of a request: the part before «:» of «title: description» (custom parts), without scrub placeholders,
 * collapsed whitespace.
 */
export function subjectOf(quote: string): string {
  const clean = quote
    .replace(/\[[A-ZА-ЯЁ_]+_\d+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const colon = clean.indexOf(":");
  const head = colon > 1 && colon <= 80 ? clean.slice(0, colon).trim() : clean;
  return head || clean;
}

/** Stems of a text: lower case, ё → е, words of 3+ letters without stop words, first 5 letters; unique, sorted. */
export function stemsOf(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
  return [...new Set(words.map((w) => w.slice(0, 5)))].sort();
}

/**
 * Normalized wording of a subject: its stems (stemsOf), at most 6, joined by spaces. Equal wordings group together
 * regardless of word order and endings.
 */
export function normalizeWording(subject: string): string {
  return stemsOf(subject).slice(0, 6).join(" ");
}

/** Group key: category and normalized wording («payments:карто оплат»); the bare category when no word is left. */
export function candidateKey(category: DevelopmentCategory, quote: string): string {
  const w = normalizeWording(subjectOf(quote));
  return cut(w ? `${category}:${w}` : category, 200);
}

/** One source of the rating: a request of «Запросы на развитие» or a successful custom part of a plan build. */
export interface FactorySource {
  kind: "request" | "custom";
  /** development_requests.id (requests only). */
  requestId?: string;
  category: DevelopmentCategory;
  quote: string;
  systemId: string | null;
  orgId: string;
  at: Date;
}

export interface CandidateGroup {
  key: string;
  category: DevelopmentCategory;
  title: string;
  weekRequests: number;
  weekCustom: number;
  totalRequests: number;
  totalCustom: number;
  systems: number;
  clients: number;
  examples: { quote: string; source: "request" | "custom" }[];
  lastSeenAt: Date;
  requestIds: string[];
  rank: number;
}

/**
 * Merge targets of group keys: a wording whose stems contain all stems of a shorter wording of the same category (and
 * that shorter one has at least half of them) joins it — «продавать абонементы на занятия» goes to «абонементы на
 * занятия». A key in `keep` (a candidate the founder already decided on) is never merged away and is the preferred
 * target, so a decided candidate keeps its row.
 */
export function mergeTargets(
  counts: ReadonlyMap<string, number>,
  keep: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const parsed = [...counts.keys()].map((k) => {
    const i = k.indexOf(":");
    return { key: k, category: i < 0 ? k : k.slice(0, i), stems: i < 0 ? [] : k.slice(i + 1).split(" ") };
  });
  type P = (typeof parsed)[number];
  const better = (b: P, best: P) =>
    Number(keep.has(b.key)) - Number(keep.has(best.key)) ||
    b.stems.length - best.stems.length ||
    (counts.get(b.key) ?? 0) - (counts.get(best.key) ?? 0) ||
    (b.key < best.key ? 1 : -1);
  const direct = new Map<string, string>();
  for (const a of parsed) {
    if (keep.has(a.key) || a.stems.length < 2) continue;
    const own = new Set(a.stems);
    let best: P | null = null;
    for (const b of parsed) {
      if (b.key === a.key || b.category !== a.category || b.stems.length === 0) continue;
      if (b.stems.length >= a.stems.length || b.stems.length * 2 < a.stems.length) continue;
      if (!b.stems.every((x) => own.has(x))) continue;
      if (!best || better(b, best) > 0) best = b;
    }
    if (best) direct.set(a.key, best.key);
  }
  const out = new Map<string, string>();
  for (const k of counts.keys()) {
    let t = k;
    // Stems strictly shrink along the chain, so it ends.
    while (direct.has(t)) t = direct.get(t) as string;
    out.set(k, t);
  }
  return out;
}

const capital = (s: string) => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s);

/**
 * The weekly rating (pure; fixture-tested): groups by category and normalized wording (a longer wording joins a shorter
 * one it contains — mergeTargets); a custom part counts once per system; rank by the week's frequency, then all time,
 * then systems, then the key. Clients are organizations. The title is the most frequent wording (case ignored).
 */
export function rankCandidates(
  sources: readonly FactorySource[],
  now: Date,
  keep: ReadonlySet<string> = new Set(),
): CandidateGroup[] {
  const since = now.getTime() - FACTORY_WEEK_MS;
  const counts = new Map<string, number>();
  for (const s of sources) {
    const k = candidateKey(s.category, s.quote);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const target = mergeTargets(counts, keep);
  interface Acc {
    g: Omit<CandidateGroup, "systems" | "clients" | "title" | "rank">;
    systems: Set<string>;
    orgs: Set<string>;
    subjects: Map<string, { n: number; at: number; text: string }>;
    customSeen: Set<string>;
  }
  const groups = new Map<string, Acc>();
  const sorted = [...sources].sort((a, b) => b.at.getTime() - a.at.getTime());
  for (const s of sorted) {
    const own = candidateKey(s.category, s.quote);
    const key = target.get(own) ?? own;
    let acc = groups.get(key);
    if (!acc) {
      acc = {
        g: {
          key,
          category: s.category,
          weekRequests: 0,
          weekCustom: 0,
          totalRequests: 0,
          totalCustom: 0,
          examples: [],
          lastSeenAt: s.at,
          requestIds: [],
        },
        systems: new Set(),
        orgs: new Set(),
        subjects: new Map(),
        customSeen: new Set(),
      };
      groups.set(key, acc);
    }
    const g = acc.g;
    if (s.kind === "custom") {
      const seen = s.systemId ?? `org:${s.orgId}`;
      if (acc.customSeen.has(seen)) continue;
      acc.customSeen.add(seen);
    }
    const week = s.at.getTime() > since;
    if (s.kind === "request") {
      g.totalRequests++;
      if (week) g.weekRequests++;
      if (s.requestId) g.requestIds.push(s.requestId);
    } else {
      g.totalCustom++;
      if (week) g.weekCustom++;
    }
    if (s.systemId) acc.systems.add(s.systemId);
    acc.orgs.add(s.orgId);
    if (s.at > g.lastSeenAt) g.lastSeenAt = s.at;
    const subject = cut(subjectOf(s.quote), TITLE_MAX);
    const low = subject.toLowerCase().replace(/ё/g, "е");
    const sub = acc.subjects.get(low);
    if (sub) sub.n++;
    else acc.subjects.set(low, { n: 1, at: s.at.getTime(), text: subject });
    const quote = cut(s.quote.replace(/\s+/g, " ").trim(), QUOTE_MAX);
    if (g.examples.length < EXAMPLES && !g.examples.some((e) => e.quote === quote))
      g.examples.push({ quote, source: s.kind });
  }
  const out = [...groups.values()].map((acc): CandidateGroup => {
    // The most frequent wording names the candidate (ties: the latest).
    const top = [...acc.subjects.values()].sort((a, b) => b.n - a.n || b.at - a.at)[0];
    return {
      ...acc.g,
      title: capital(top?.text ?? "") || acc.g.category,
      systems: acc.systems.size,
      clients: acc.orgs.size,
      rank: 0,
    };
  });
  const week = (g: CandidateGroup) => g.weekRequests + g.weekCustom;
  const total = (g: CandidateGroup) => g.totalRequests + g.totalCustom;
  out.sort(
    (a, b) =>
      week(b) - week(a) ||
      total(b) - total(a) ||
      b.systems - a.systems ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  out.forEach((g, i) => {
    g.rank = i + 1;
  });
  return out;
}

interface CustomCheckpointItem {
  id?: unknown;
  title?: unknown;
  status?: unknown;
}

/** Successful custom parts of plan builds (checkpoints.custom.data.items with status done) as rating sources. */
async function customSources(db: Db): Promise<FactorySource[]> {
  const rows = await db
    .selectFrom("platform.system_plans as p")
    .innerJoin("platform.systems as s", "s.id", "p.system_id")
    .select(["p.system_id", "s.org_id", "p.plan", "p.checkpoints", "p.approved_at", "p.created_at"])
    .where(sql<boolean>`p.checkpoints ? 'custom'`)
    .orderBy("p.created_at", "desc")
    .limit(MAX_PLANS)
    .execute();
  const out: FactorySource[] = [];
  for (const r of rows) {
    const cp = (r.checkpoints as Record<string, { data?: { items?: CustomCheckpointItem[] } }>).custom;
    const items = Array.isArray(cp?.data?.items) ? cp.data.items : [];
    const custom = Array.isArray((r.plan as { custom?: unknown }).custom)
      ? ((r.plan as { custom: { id?: unknown; description?: unknown }[] }).custom ?? [])
      : [];
    for (const it of items) {
      if (it.status !== "done" || typeof it.title !== "string" || !it.title.trim()) continue;
      const desc = custom.find((c) => c.id === it.id)?.description;
      const quote = scrub(typeof desc === "string" && desc.trim() ? `${it.title}: ${desc}` : it.title).text;
      out.push({
        kind: "custom",
        category: "other",
        quote,
        systemId: r.system_id,
        orgId: r.org_id,
        at: new Date(r.approved_at ?? r.created_at),
      });
    }
  }
  return out;
}

export interface RecomputeReport {
  computedAt: Date;
  candidates: number;
  linked: number;
  announced: AnnounceReport[];
}

/**
 * One pass of the rating: reads the requests and the successful custom parts, upserts the candidates (the founder's
 * status and module link are kept), zeroes the candidates with no source left, links each request to its candidate,
 * then finishes the ready candidates (new requests → done, letters to the clients not told yet).
 */
export async function recomputeModuleCandidates(
  d: AnnounceDeps,
  now: Date = new Date(),
): Promise<RecomputeReport> {
  const reqs = await d.db
    .selectFrom("platform.development_requests")
    .select(["id", "category", "quote", "system_id", "org_id", "created_at"])
    .orderBy("created_at", "desc")
    .limit(MAX_REQUESTS)
    .execute();
  const sources: FactorySource[] = reqs.map((r) => ({
    kind: "request",
    requestId: r.id,
    category: isDevelopmentCategory(r.category) ? r.category : "other",
    quote: r.quote,
    systemId: r.system_id,
    orgId: r.org_id,
    at: new Date(r.created_at),
  }));
  sources.push(...(await customSources(d.db)));
  const decided = await d.db
    .selectFrom("platform.module_candidates")
    .select("key")
    .where("status", "!=", "new")
    .execute();
  const groups = rankCandidates(sources, now, new Set(decided.map((x) => x.key)));
  const weekStart = new Date(now.getTime() - FACTORY_WEEK_MS);
  let linked = 0;
  await d.db.transaction().execute(async (trx) => {
    await trx
      .updateTable("platform.module_candidates")
      .set({
        rank: null,
        week_requests: 0,
        week_custom: 0,
        total_requests: 0,
        total_custom: 0,
        systems: 0,
        clients: 0,
        examples: sql`'[]'::jsonb`,
        week_start: weekStart,
        computed_at: now,
      })
      .execute();
    for (const g of groups) {
      const values = {
        category: g.category,
        title: g.title,
        rank: g.rank,
        week_start: weekStart,
        week_requests: g.weekRequests,
        week_custom: g.weekCustom,
        total_requests: g.totalRequests,
        total_custom: g.totalCustom,
        systems: g.systems,
        clients: g.clients,
        examples: sql`cast(${JSON.stringify(g.examples)} as jsonb)`,
        last_seen_at: g.lastSeenAt,
        computed_at: now,
      };
      const row = await trx
        .insertInto("platform.module_candidates")
        .values({ key: g.key, ...values })
        .onConflict((oc) => oc.column("key").doUpdateSet(values))
        .returning("id")
        .executeTakeFirstOrThrow();
      for (let i = 0; i < g.requestIds.length; i += 1000) {
        const ids = g.requestIds.slice(i, i + 1000);
        const res = await trx
          .updateTable("platform.development_requests")
          .set({ candidate_id: row.id })
          .where("id", "in", ids)
          .where((eb) => eb.or([eb("candidate_id", "is", null), eb("candidate_id", "!=", row.id)]))
          .executeTakeFirst();
        linked += Number(res.numUpdatedRows);
      }
    }
  });
  const ready = await d.db
    .selectFrom("platform.module_candidates")
    .select("id")
    .where("status", "=", "ready")
    .execute();
  const announced: AnnounceReport[] = [];
  for (const c of ready) announced.push(await announceReadyModule(d, c.id, now));
  return { computedAt: now, candidates: groups.length, linked, announced };
}

/**
 * workflows.yaml#module_factory_cron: the weekly pass. With `ifStale` (the in-process timer without the worker) it
 * runs only when the last rating is a week old or missing.
 */
export async function runModuleFactoryCron(
  d: AnnounceDeps,
  now: Date = new Date(),
  o: { ifStale?: boolean } = {},
): Promise<RecomputeReport | null> {
  if (o.ifStale) {
    const last = await d.db
      .selectFrom("platform.module_candidates")
      .select(sql<Date | null>`max(computed_at)`.as("at"))
      .executeTakeFirst();
    const at = last?.at ? new Date(last.at).getTime() : 0;
    const any = await d.db
      .selectFrom("platform.development_requests")
      .select("id")
      .limit(1)
      .executeTakeFirst();
    if (!any && at === 0) return null;
    if (at > now.getTime() - FACTORY_WEEK_MS) return null;
  }
  return recomputeModuleCandidates(d, now);
}

/** A catalog module the founder can link (id, name, ready, available now — compiles in a plan). */
export interface CatalogModuleRef {
  id: string;
  name: string;
  summary: string;
  status: "ready" | "draft";
  available: boolean;
}

export function catalogModules(registry: ModuleRegistry = DEFAULT_REGISTRY): CatalogModuleRef[] {
  const ok = availableModules(registry);
  return registry.modules.map((m) => ({
    id: m.manifest.id,
    name: m.manifest.name,
    summary: m.manifest.summary,
    status: m.manifest.status,
    available: ok.has(m.manifest.id),
  }));
}

/**
 * The catalog module closest to the candidate's wording: shared stems, a stem in the module name counts twice; at
 * least one shared stem, otherwise null.
 */
export function suggestModule(title: string, modules: readonly CatalogModuleRef[]): CatalogModuleRef | null {
  const want = stemsOf(title);
  if (want.length === 0) return null;
  let best: { m: CatalogModuleRef; n: number } | null = null;
  for (const m of modules) {
    const name = new Set(stemsOf(m.name));
    const summary = new Set(stemsOf(m.summary));
    const n = want.reduce((acc, w) => acc + (name.has(w) ? 2 : 0) + (summary.has(w) ? 1 : 0), 0);
    if (n > 0 && (!best || n > best.n)) best = { m, n };
  }
  return best?.m ?? null;
}

export interface CandidateView {
  id: string;
  key: string;
  category: DevelopmentCategory;
  title: string;
  status: CandidateStatus;
  moduleId: string | null;
  moduleName: string | null;
  rank: number | null;
  weekRequests: number;
  weekCustom: number;
  totalRequests: number;
  totalCustom: number;
  systems: number;
  clients: number;
  examples: { quote: string; source: "request" | "custom" }[];
  lastSeenAt: Date | null;
  computedAt: Date | null;
  note: string | null;
  decidedAt: Date | null;
  readyAt: Date | null;
  suggested: { id: string; name: string; status: "ready" | "draft" } | null;
}

type CandidateRow = {
  id: string;
  key: string;
  category: string;
  title: string;
  status: CandidateStatus;
  module_id: string | null;
  rank: number | null;
  week_requests: number;
  week_custom: number;
  total_requests: number;
  total_custom: number;
  systems: number;
  clients: number;
  examples: unknown;
  last_seen_at: Date | null;
  computed_at: Date | null;
  note: string | null;
  decided_at: Date | null;
  ready_at: Date | null;
};

const CANDIDATE_COLS = [
  "id",
  "key",
  "category",
  "title",
  "status",
  "module_id",
  "rank",
  "week_requests",
  "week_custom",
  "total_requests",
  "total_custom",
  "systems",
  "clients",
  "examples",
  "last_seen_at",
  "computed_at",
  "note",
  "decided_at",
  "ready_at",
] as const;

const date = (v: Date | string | null) => (v ? new Date(v) : null);

function toView(r: CandidateRow, modules: readonly CatalogModuleRef[]): CandidateView {
  const linked = r.module_id ? modules.find((m) => m.id === r.module_id) : undefined;
  const sug = r.module_id ? null : suggestModule(r.title, modules);
  return {
    id: r.id,
    key: r.key,
    category: isDevelopmentCategory(r.category) ? r.category : "other",
    title: r.title,
    status: r.status,
    moduleId: r.module_id,
    moduleName: linked?.name ?? null,
    rank: r.rank,
    weekRequests: r.week_requests,
    weekCustom: r.week_custom,
    totalRequests: r.total_requests,
    totalCustom: r.total_custom,
    systems: r.systems,
    clients: r.clients,
    examples: Array.isArray(r.examples) ? (r.examples as CandidateView["examples"]) : [],
    lastSeenAt: date(r.last_seen_at),
    computedAt: date(r.computed_at),
    note: r.note,
    decidedAt: date(r.decided_at),
    readyAt: date(r.ready_at),
    suggested: sug ? { id: sug.id, name: sug.name, status: sug.status } : null,
  };
}

/** Filter of the list: open — new and approved (the working rating), or one status, or all. */
export const CANDIDATE_FILTERS = ["open", "new", "approved", "disabled", "ready", "all"] as const;
export type CandidateFilter = (typeof CANDIDATE_FILTERS)[number];

/** /admin «Кандидаты в модули»: the rating (rank order; unranked — the latest first) and the catalog modules. */
export async function listModuleCandidates(
  db: Db,
  o: { status?: CandidateFilter; registry?: ModuleRegistry; limit?: number } = {},
): Promise<{ computedAt: Date | null; items: CandidateView[]; modules: CatalogModuleRef[] }> {
  const modules = catalogModules(o.registry);
  let q = db.selectFrom("platform.module_candidates").select([...CANDIDATE_COLS]);
  const f = o.status ?? "open";
  if (f === "open") q = q.where("status", "in", ["new", "approved"]);
  else if (f !== "all") q = q.where("status", "=", f);
  const rows = await q
    .orderBy(sql`rank is null`)
    .orderBy("rank")
    .orderBy("last_seen_at", "desc")
    .limit(o.limit ?? 200)
    .execute();
  const last = await db
    .selectFrom("platform.module_candidates")
    .select(sql<Date | null>`max(computed_at)`.as("at"))
    .executeTakeFirst();
  return {
    computedAt: date(last?.at ?? null),
    items: rows.map((r) => toView(r as CandidateRow, modules)),
    modules,
  };
}

export interface CandidateRequest {
  id: string;
  quote: string;
  status: "open" | "done";
  createdAt: Date;
  doneAt: Date | null;
  systemId: string | null;
  systemName: string | null;
}

/** The candidate card: the candidate, its latest linked requests (no addresses) and how many clients were told. */
export async function moduleCandidateCard(
  db: Db,
  id: string,
  registry?: ModuleRegistry,
): Promise<{ candidate: CandidateView; requests: CandidateRequest[]; notified: number } | null> {
  const row = await db
    .selectFrom("platform.module_candidates")
    .select([...CANDIDATE_COLS])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  const requests = await db
    .selectFrom("platform.development_requests as r")
    .leftJoin("platform.systems as s", "s.id", "r.system_id")
    .select([
      "r.id",
      "r.quote",
      "r.status",
      "r.created_at",
      "r.done_at",
      "r.system_id",
      "s.name as system_name",
    ])
    .where("r.candidate_id", "=", id)
    .orderBy("r.created_at", "desc")
    .limit(20)
    .execute();
  const notified = await db
    .selectFrom("platform.module_announcements")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("candidate_id", "=", id)
    .executeTakeFirst();
  return {
    candidate: toView(row as CandidateRow, catalogModules(registry)),
    requests: requests.map((r) => ({
      id: r.id,
      quote: r.quote,
      status: r.status,
      createdAt: new Date(r.created_at),
      doneAt: date(r.done_at),
      systemId: r.system_id,
      systemName: r.system_name ?? null,
    })),
    notified: Number(notified?.n ?? 0),
  };
}

export interface AnnounceDeps {
  db: Db;
  mailer: Mailer;
  /** Links of the letter: <platformOrigin>/s/<systemId>, consent settings at <platformOrigin>/billing. */
  platformOrigin: string;
  registry?: ModuleRegistry;
  log?: (m: string, e?: unknown) => void;
}

/**
 * The founder's decision (staff only; the route writes staff_audit_log): approve — in work (an optional catalog
 * module id it will become); disable — out of the rating; ready — the module is in the catalog and compiles (its id is
 * required), the covered requests become «done» and the letters go out. A ready candidate is final.
 */
export async function decideModuleCandidate(
  d: AnnounceDeps,
  o: {
    id: string;
    action: CandidateAction;
    moduleId?: string | undefined;
    note?: string | undefined;
    by: string;
  },
  now: Date = new Date(),
): Promise<{ candidate: CandidateView; announced: AnnounceReport | null } | null> {
  const cur = await d.db
    .selectFrom("platform.module_candidates")
    .select(["id", "status", "module_id"])
    .where("id", "=", o.id)
    .executeTakeFirst();
  if (!cur) return null;
  if (cur.status === "ready") throw invalid("Кандидат уже отмечен как готовый модуль — решение не меняется.");
  const modules = catalogModules(d.registry);
  const moduleId = o.moduleId ?? cur.module_id ?? undefined;
  const mod = moduleId ? modules.find((m) => m.id === moduleId) : undefined;
  if (moduleId && !mod) throw invalid(`В каталоге нет модуля «${moduleId}».`, { moduleId });
  if (o.action === "ready") {
    if (!mod) throw invalid("Укажите модуль каталога, который закрывает этот запрос.");
    if (!mod.available)
      throw invalid(
        `Модуль «${mod.name}» ещё не готов: в каталоге он пока «скоро». Сначала выпустите модуль.`,
        {
          moduleId: mod.id,
        },
      );
  }
  const status: CandidateStatus =
    o.action === "approve" ? "approved" : o.action === "disable" ? "disabled" : "ready";
  await d.db
    .updateTable("platform.module_candidates")
    .set({
      status,
      module_id: o.action === "disable" ? cur.module_id : (moduleId ?? null),
      decided_by: o.by,
      decided_at: now,
      ...(o.note !== undefined ? { note: o.note.trim() || null } : {}),
      ...(status === "ready" ? { ready_at: now } : {}),
    })
    .where("id", "=", o.id)
    .where("status", "!=", "ready")
    .execute();
  const announced = status === "ready" ? await announceReadyModule(d, o.id, now) : null;
  const card = await moduleCandidateCard(d.db, o.id, d.registry);
  return card ? { candidate: card.candidate, announced } : null;
}

export interface AnnounceReport {
  candidateId: string;
  moduleId: string;
  /** Requests marked «done» by this pass. */
  done: number;
  /** Letters sent now. */
  sent: number;
  /** Clients who asked but did not agree to letters (not told). */
  noConsent: number;
  /** Letters that failed (the mark is removed — the next pass tries again). */
  failed: number;
}

/**
 * «Теперь умеем»: the open requests of a ready candidate become «done»; each client who asked, agreed to letters and
 * was not told about this module yet gets one letter with a link to the system of the request (idempotent: the
 * module_announcements row is taken before sending; a failed send gives it back).
 */
export async function announceReadyModule(
  d: AnnounceDeps,
  candidateId: string,
  now: Date = new Date(),
): Promise<AnnounceReport> {
  const c = await d.db
    .selectFrom("platform.module_candidates")
    .select(["id", "status", "module_id"])
    .where("id", "=", candidateId)
    .executeTakeFirstOrThrow();
  const moduleId = c.module_id ?? "";
  const report: AnnounceReport = { candidateId, moduleId, done: 0, sent: 0, noConsent: 0, failed: 0 };
  if (c.status !== "ready" || !c.module_id) return report;
  const done = await d.db
    .updateTable("platform.development_requests")
    .set({ status: "done", done_at: now })
    .where("candidate_id", "=", candidateId)
    .where("status", "=", "open")
    .executeTakeFirst();
  report.done = Number(done.numUpdatedRows);
  const mod = catalogModules(d.registry).find((m) => m.id === c.module_id);
  const name = mod?.name ?? c.module_id;
  // The latest request of each client of this candidate whom nobody told about the module yet.
  const people = await d.db
    .selectFrom("platform.development_requests as r")
    .innerJoin("platform.users as u", "u.id", "r.user_id")
    .select(["r.user_id", "u.email", "u.updates_consent_at", "r.system_id", "r.quote"])
    .distinctOn("r.user_id")
    .where("r.candidate_id", "=", candidateId)
    .where("u.deleted_at", "is", null)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("platform.module_announcements as a")
            .select("a.user_id")
            .where("a.module_id", "=", c.module_id as string)
            .whereRef("a.user_id", "=", "r.user_id"),
        ),
      ),
    )
    .orderBy("r.user_id")
    .orderBy("r.created_at", "desc")
    .execute();
  const origin = d.platformOrigin.replace(/\/+$/, "");
  for (const p of people) {
    if (!p.user_id) continue;
    if (!p.updates_consent_at) {
      report.noConsent++;
      continue;
    }
    const taken = await d.db
      .insertInto("platform.module_announcements")
      .values({
        module_id: c.module_id,
        user_id: p.user_id,
        candidate_id: candidateId,
        system_id: p.system_id,
      })
      .onConflict((oc) => oc.columns(["module_id", "user_id"]).doNothing())
      .returning("user_id")
      .executeTakeFirst();
    if (!taken) continue;
    try {
      await d.mailer.send({
        kind: "updates",
        to: p.email,
        ...nowWeCanLetter({
          moduleName: name,
          summary: mod?.summary ?? null,
          quote: subjectOf(p.quote),
          link: p.system_id ? `${origin}/s/${p.system_id}` : `${origin}/`,
          settings: `${origin}/billing`,
        }),
      });
      report.sent++;
    } catch (e) {
      report.failed++;
      d.log?.("module announcement letter failed", e);
      await d.db
        .deleteFrom("platform.module_announcements")
        .where("module_id", "=", c.module_id)
        .where("user_id", "=", p.user_id)
        .execute();
    }
  }
  return report;
}

/** The letter «Теперь умеем: …» (plain words, a link to the client's system, how to stop such letters). */
export function nowWeCanLetter(a: {
  moduleName: string;
  summary: string | null;
  quote: string;
  link: string;
  settings: string;
}): { subject: string; text: string } {
  const what = a.summary
    ? `раздел «${a.moduleName}»: ${a.summary.replace(/\.?\s*$/, ".")}`
    : `раздел «${a.moduleName}».`;
  return {
    subject: `Теперь умеем: ${a.moduleName}`,
    text: [
      "Здравствуйте!",
      "",
      `Вы просили: «${cut(a.quote, QUOTE_MAX)}». Тогда этого не было, а теперь Born to Build это умеет — ${what}`,
      "",
      "Откройте свою систему и напишите в чате, что хотите это добавить:",
      a.link,
      "",
      `Письмо пришло, потому что вы согласились получать письма о новых возможностях. Отключить их можно на странице «Оплата и кредиты»: ${a.settings}`,
      "",
      "Команда Born to Build",
    ].join("\n"),
  };
}

/** Client consent to letters about new abilities (users.updates_consent_at). */
export async function setUpdatesConsent(
  db: Db,
  userId: string,
  on: boolean,
  now: Date = new Date(),
): Promise<boolean> {
  await db
    .updateTable("platform.users")
    .set({ updates_consent_at: on ? now : null })
    .where("id", "=", userId)
    .execute();
  return on;
}
