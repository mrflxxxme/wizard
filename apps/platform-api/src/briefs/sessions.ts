// GET /systems/:id/sessions (V3-06, D77 (9)): the session feed of a system — the interview, builds and edits of the brief —
// aggregated from runs and brief versions, no table of its own. Rules:
// - a build run is a session (with the brief versions it wrote, e.g. answers to questions asked during the build);
// - interview_turn runs in a row (no build or panel edit between them, pauses under SESSION_GAP_MS) are one session:
//   «интервью» before the first build, «правка словами» after it or when a run is marked input.intent = "brief_edit";
// - an owner's version without a run (PUT /brief) is a «правка в панели» session;
// - an agent's version without a run joins the latest session that started before it (or becomes an interview).
// Newest first; viewer and up; another org's system is 404.
import type { BriefChange } from "@wizard/appspec";
import { Hono } from "hono";
import { z } from "zod";
import { notFound } from "../errors.js";
import { type AppEnv, checkOrgAccess, isUuid } from "../http/auth.js";
import { type Deps, parseQuery } from "../http/util.js";

export const SESSION_KINDS = ["interview", "build", "edit"] as const;
export const SESSION_STATUSES = ["running", "waiting", "done", "failed", "cancelled"] as const;
/** A pause longer than this between two interview turns starts a new session. */
export const SESSION_GAP_MS = 30 * 60_000;
/** Lines of brief changes a session carries (the rest is counted in changesTotal). */
export const SESSION_CHANGE_LINES = 6;
/** How much history is read to build the feed. */
const HISTORY = 1000;

/** api.yaml#SystemSession. */
export interface SystemSession {
  id: string;
  kind: (typeof SESSION_KINDS)[number];
  /** edit only: chat — said in words (an interview run), panel — the owner's PUT /brief. */
  source: "chat" | "panel" | null;
  status: (typeof SESSION_STATUSES)[number];
  startedAt: string;
  finishedAt: string | null;
  runIds: string[];
  briefVersions: number[];
  changes: string[];
  changesTotal: number;
  build: { mode: string | null; revision: number | null; failure: string | null } | null;
}

interface RunRow {
  id: string;
  kind: string;
  mode: string | null;
  status: string;
  input: unknown;
  failure_message_ru: string | null;
  result_revision: number | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
}

interface VersionRow {
  version: number;
  author: "agent" | "owner";
  run_id: string | null;
  diff: unknown;
  created_at: Date | string;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());
const ms = (d: Date | string | null): number => (d === null ? 0 : new Date(d).getTime());

function statusOf(s: string): SystemSession["status"] {
  if (s === "succeeded") return "done";
  if (s === "failed" || s === "cancelled") return s;
  if (s === "needs_input") return "waiting";
  return "running";
}

/** running > waiting > the status of the last run. */
function groupStatus(runs: RunRow[]): SystemSession["status"] {
  const all = runs.map((r) => statusOf(r.status));
  if (all.includes("running")) return "running";
  if (all.includes("waiting")) return "waiting";
  return all[all.length - 1] ?? "done";
}

const isEditIntent = (input: unknown) =>
  !!input && typeof input === "object" && (input as { intent?: unknown }).intent === "brief_edit";

/** Sessions of one system from its runs and brief versions (both oldest first); newest first. */
export function buildSessions(runs: RunRow[], versions: VersionRow[]): SystemSession[] {
  const sessions: (SystemSession & { at: number; end: number })[] = [];
  const byRun = new Map<string, SystemSession & { at: number; end: number }>();
  const firstBuild = Math.min(
    ...runs.filter((r) => r.kind === "build").map((r) => ms(r.created_at)),
    Infinity,
  );
  // Timeline of what splits interview turns: builds and panel edits.
  const splits = [
    ...runs.filter((r) => r.kind === "build").map((r) => ms(r.created_at)),
    ...versions.filter((v) => v.author === "owner" && !v.run_id).map((v) => ms(v.created_at)),
  ].sort((a, b) => a - b);
  const splitBetween = (a: number, b: number) => splits.some((t) => t > a && t < b);

  let group: { runs: RunRow[]; edit: boolean } | null = null;
  const closeGroup = () => {
    if (!group) return;
    const first = group.runs[0] as RunRow;
    const last = group.runs[group.runs.length - 1] as RunRow;
    const status = groupStatus(group.runs);
    const kind = group.edit || ms(first.created_at) > firstBuild ? "edit" : "interview";
    const s = {
      id: `${kind}:${first.id}`,
      kind,
      source: kind === "edit" ? "chat" : null,
      status,
      startedAt: iso(first.started_at ?? first.created_at) as string,
      finishedAt: status === "running" || status === "waiting" ? null : iso(last.finished_at),
      runIds: group.runs.map((r) => r.id),
      briefVersions: [],
      changes: [],
      changesTotal: 0,
      build: null,
      at: ms(first.created_at),
      end: ms(last.finished_at ?? last.created_at),
    } satisfies SystemSession & { at: number; end: number };
    sessions.push(s);
    for (const r of group.runs) byRun.set(r.id, s);
    group = null;
  };

  for (const r of runs) {
    if (r.kind === "build") {
      closeGroup();
      const status = statusOf(r.status);
      const s = {
        id: `build:${r.id}`,
        kind: "build" as const,
        source: null,
        status,
        startedAt: iso(r.started_at ?? r.created_at) as string,
        finishedAt: status === "running" || status === "waiting" ? null : iso(r.finished_at),
        runIds: [r.id],
        briefVersions: [],
        changes: [],
        changesTotal: 0,
        build: { mode: r.mode, revision: r.result_revision, failure: r.failure_message_ru },
        at: ms(r.created_at),
        end: ms(r.finished_at ?? r.created_at),
      };
      sessions.push(s);
      byRun.set(r.id, s);
      continue;
    }
    if (r.kind !== "interview_turn") continue;
    const edit = isEditIntent(r.input);
    const prev = group?.runs[group.runs.length - 1];
    const joins =
      group !== null &&
      prev !== undefined &&
      !edit &&
      !group.edit &&
      ms(r.created_at) - ms(prev.finished_at ?? prev.created_at) <= SESSION_GAP_MS &&
      !splitBetween(ms(prev.created_at), ms(r.created_at));
    if (!joins) {
      closeGroup();
      group = { runs: [], edit };
    }
    group?.runs.push(r);
  }
  closeGroup();

  const addVersion = (s: SystemSession, v: VersionRow) => {
    const diff = Array.isArray(v.diff) ? (v.diff as BriefChange[]) : [];
    s.briefVersions.push(v.version);
    s.changesTotal += diff.length;
    for (const c of diff)
      if (s.changes.length < SESSION_CHANGE_LINES && typeof c?.text_ru === "string")
        s.changes.push(c.text_ru);
  };
  for (const v of versions) {
    const at = ms(v.created_at);
    if (v.run_id && byRun.has(v.run_id)) {
      addVersion(byRun.get(v.run_id) as SystemSession, v);
      continue;
    }
    if (v.author === "owner" && !v.run_id) {
      const s = {
        id: `brief:${v.version}`,
        kind: "edit" as const,
        source: "panel" as const,
        status: "done" as const,
        startedAt: iso(v.created_at) as string,
        finishedAt: iso(v.created_at),
        runIds: [],
        briefVersions: [],
        changes: [],
        changesTotal: 0,
        build: null,
        at,
        end: at,
      };
      addVersion(s, v);
      sessions.push(s);
      continue;
    }
    // An agent's version of a run outside the feed (or without a run): the latest session started before it.
    const host = sessions
      .filter((s) => s.at <= at && s.source !== "panel")
      .reduce<(typeof sessions)[number] | null>((best, s) => (!best || s.at > best.at ? s : best), null);
    if (host) addVersion(host, v);
    else {
      const s = {
        id: `interview:v${v.version}`,
        kind: "interview" as const,
        source: null,
        status: "done" as const,
        startedAt: iso(v.created_at) as string,
        finishedAt: iso(v.created_at),
        runIds: [],
        briefVersions: [],
        changes: [],
        changesTotal: 0,
        build: null,
        at,
        end: at,
      };
      addVersion(s, v);
      sessions.push(s);
    }
  }
  return sessions
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
    .map(({ at: _at, end: _end, ...s }) => s);
}

const listQ = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

export function sessionRoutes(d: Pick<Deps, "db">): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/systems/:id/sessions", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .select(["id", "org_id"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(c.get("user"), s.org_id, "viewer", "Система");
    const q = parseQuery(c, listQ);
    const runs = await d.db
      .selectFrom("platform.runs")
      .select([
        "id",
        "kind",
        "mode",
        "status",
        "input",
        "failure_message_ru",
        "result_revision",
        "started_at",
        "finished_at",
        "created_at",
      ])
      .where("system_id", "=", s.id)
      .where("kind", "in", ["interview_turn", "build"])
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(HISTORY)
      .execute();
    const versions = await d.db
      .selectFrom("platform.system_briefs")
      .select(["version", "author", "run_id", "diff", "created_at"])
      .where("system_id", "=", s.id)
      .orderBy("version", "desc")
      .limit(HISTORY)
      .execute();
    const sessions = buildSessions(runs.reverse(), versions.reverse());
    return c.json({ sessions: sessions.slice(0, q.limit) });
  });
  return r;
}
