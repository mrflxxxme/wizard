// Demo replay of staff orgs (B2-02; product.yaml#decisions.D76_beta_v2, docs/reviews/grill-6.md № 12; agents/models.yaml
// #credits.demo_replay): when a staff org has orgs.demo_replay on, every model call of its runs (interview, build, edits)
// is replayed from a recorded scenario tools/fixtures/demo/<name>.jsonl (eval.yaml#fixtures.lookup, suite demo) for free:
// llm_calls rows are mode=fixture with cost_rub 0. A system is tied to a scenario when it is created (its brief equals
// the scenario's recorded brief); a call with no recorded answer fails the run with DEMO_REPLAY_MISS — never live.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FixtureStore, LlmError, type Router, type RouterOptions } from "@wizard/llm";
import type { Db } from "../db/index.js";
import { ApiError } from "../errors.js";
import { RunFailure } from "./types.js";

/** Banner of the platform UI while the mode is on. */
export const DEMO_REPLAY_BANNER_RU = "Режим показа: ответы моделей записаны, расходов нет";

/** run_failed code of a call with no recorded answer (workflows.yaml#run_lifecycle.failure_codes). */
export const DEMO_REPLAY_MISS = "DEMO_REPLAY_MISS";

export interface DemoScenario {
  /** tools/fixtures/demo/<name>.jsonl */
  name: string;
  title: string;
  /** The recorded brief: the first user message of the scenario's first call. */
  brief: string;
  /** Build modes recorded beside the create transcript (<name>.<mode>.jsonl), e.g. point_edit. */
  modes: string[];
}

/** Titles of the golden scenarios (tools/fixtures/golden/<name>.yaml); another recording shows its name. */
const TITLES: Readonly<Record<string, string>> = {
  forum: "Отраслевой форум «Северный ритейл»",
  bakery: "Кондитерская «Сахар»: торты на заказ",
};

/**
 * Recordings the current agents do not replay end to end: bakery's interview was recorded for a fork list the
 * orchestrator no longer selects (docs/reviews/impl-notes/M0-26.md; the golden API test replays it by hand).
 */
const NOT_REPLAYABLE: ReadonlySet<string> = new Set(["bakery"]);

const NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;

const cache = new Map<string, DemoScenario[]>();

/** Directory of the demo recordings: <repo>/tools/fixtures/demo (FixtureStore's default root). */
export function demoFixtureDir(): string {
  return join(new FixtureStore({ suite: "demo", name: "_" }).path, "..");
}

/** Replayable demo scenarios, read once per directory. */
export function demoScenarios(dir = demoFixtureDir()): DemoScenario[] {
  const hit = cache.get(dir);
  if (hit) return hit;
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
  const out: DemoScenario[] = [];
  for (const f of files.sort()) {
    const name = f.slice(0, -".jsonl".length);
    if (!NAME_RE.test(name) || NOT_REPLAYABLE.has(name)) continue;
    const first = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .find((l) => l.trim() !== "");
    if (!first) continue;
    const line = JSON.parse(first) as { request?: { messages?: { role?: string; content?: unknown }[] } };
    const brief = line.request?.messages?.find((m) => m.role === "user")?.content;
    if (typeof brief !== "string" || brief.trim() === "") continue;
    const modes = files
      .filter((x) => x.startsWith(`${name}.`) && x.endsWith(".jsonl"))
      .map((x) => x.slice(name.length + 1, -".jsonl".length))
      .filter((m) => /^[a-z_]+$/.test(m));
    out.push({ name, title: TITLES[name] ?? name, brief, modes });
  }
  cache.set(dir, out);
  return out;
}

const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

/** The scenario whose recorded brief the prompt repeats (whitespace-insensitive), else null. */
export function matchDemoScenario(prompt: string, list = demoScenarios()): DemoScenario | null {
  const p = norm(prompt);
  return list.find((s) => norm(s.brief) === p) ?? null;
}

/** «В режиме показа есть только записанные сценарии: …» with the titles of the recordings. */
export function demoMissMessage(list = demoScenarios()): string {
  const titles = list.length ? list.map((s) => `«${s.title}»`).join(", ") : "пока ни одного";
  return `В режиме показа есть только записанные сценарии: ${titles}. Начните систему с брифа одного из них или выключите режим показа в /admin.`;
}

/** Demo replay is on for the org: a staff org with the flag (a client or eval org never replays). */
export async function orgDemoReplay(db: Db, orgId: string): Promise<boolean> {
  const o = await db
    .selectFrom("platform.orgs")
    .select(["kind", "demo_replay"])
    .where("id", "=", orgId)
    .executeTakeFirst();
  return o?.kind === "staff" && o.demo_replay === true;
}

/**
 * createSystem in demo replay: the scenario of the prompt, or 422 DEMO_REPLAY_NO_SCENARIO with the list (the system
 * is not created, no model is called).
 */
export function requireDemoScenario(prompt: string): DemoScenario {
  const list = demoScenarios();
  const s = matchDemoScenario(prompt, list);
  if (s) return s;
  throw new ApiError("DEMO_REPLAY_NO_SCENARIO", demoMissMessage(list), {
    scenarios: list.map(({ name, title }) => ({ name, title })),
  });
}

export interface DemoRun {
  kind: string;
  mode: string | null;
}

/**
 * Fixture of a run of a demo system: interview turns and create builds replay <scenario>.jsonl, another build mode
 * its own recording <scenario>.<mode>.jsonl; null — nothing recorded for this run.
 */
export function demoFixture(scenario: string | null, run: DemoRun): RouterOptions["fixture"] | null {
  if (!scenario) return null;
  const s = demoScenarios().find((x) => x.name === scenario);
  if (!s) return null;
  if (run.kind === "interview_turn" || (run.kind === "build" && (run.mode ?? "create") === "create"))
    return { suite: "demo", name: s.name };
  if (run.kind === "build" && run.mode && s.modes.includes(run.mode))
    return { suite: "demo", name: `${s.name}.${run.mode}` };
  return null;
}

/**
 * Demo replay of a run: null — the org is not in demo replay (the run routes as usual); {fixture: null} — it is, but
 * nothing is recorded for this run (DEMO_REPLAY_MISS).
 */
export async function runDemoReplay(
  db: Db,
  run: DemoRun & { org_id: string; system_id: string | null },
): Promise<{ fixture: RouterOptions["fixture"] | null } | null> {
  if (!(await orgDemoReplay(db, run.org_id))) return null;
  const sys = run.system_id
    ? await db
        .selectFrom("platform.systems")
        .select("demo_scenario")
        .where("id", "=", run.system_id)
        .executeTakeFirst()
    : undefined;
  return { fixture: demoFixture(sys?.demo_scenario ?? null, run) };
}

/** A run of a demo system: a model call with no recorded answer fails the run with DEMO_REPLAY_MISS. */
export function demoRouter(inner: Router): Router {
  return {
    mode: inner.mode,
    registry: inner.registry,
    async route(input) {
      try {
        return await inner.route(input);
      } catch (e) {
        if (e instanceof LlmError && e.code === "FIXTURE_MISS")
          throw new RunFailure(DEMO_REPLAY_MISS, demoMissMessage());
        throw e;
      }
    },
    ...(inner.inflightT1 ? { inflightT1: inner.inflightT1.bind(inner) } : {}),
  };
}
