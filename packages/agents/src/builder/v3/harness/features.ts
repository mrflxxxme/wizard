// Features of a v3 build (builder-v3.md C1: scenarios of the brief are the acceptance criteria): the ordered list —
// «must» first, then «should», in brief order — and how a brief scenario maps to the goal scenarios of the compiled
// modules a browser runs (by moduleHint, then by the goal words, narrowed by the actor). Plain code, no model.
import type { BriefScenario, SystemBrief } from "@wizard/appspec";
import type { CompiledScenario } from "@wizard/modules";
import { fallbackGoals } from "../../../planner/fallback.js";

/** A feature of the build: one brief scenario with its title for people. */
export interface V3Feature {
  id: string;
  priority: "must" | "should";
  /** «Когда <when> — система <then…>» (≤ 200 characters). */
  title: string;
  scenario: BriefScenario;
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** «Когда посетитель выбирает услугу — система создаёт запись, присылает подтверждение». */
export function featureTitle(s: BriefScenario): string {
  const when = s.when.replace(/^когда\s+/i, "");
  return clip(`Когда ${when} — система ${s.then.join(", ")}`, 200);
}

/** The feature list of a brief: «must» scenarios first, then «should», each group in brief order. */
export function featureList(brief: SystemBrief): V3Feature[] {
  const all = brief.scenarios.map((s) => ({
    id: s.id,
    priority: s.priority,
    title: featureTitle(s),
    scenario: s,
  }));
  return [...all.filter((f) => f.priority === "must"), ...all.filter((f) => f.priority === "should")];
}

const PUBLIC_ACTORS: ReadonlySet<string> = new Set(["visitor", "client"]);
/** Goal scenarios a browser check runs for one brief scenario at most. */
export const MAX_GOAL_SCENARIOS = 3;

/**
 * Goal scenarios of the compiled modules a brief scenario maps to: its moduleHint's (or those that need that module),
 * else those of the goals its words and its goal name; a visitor's or client's scenario prefers the public surface,
 * a staff or owner one the cabinets. At most MAX_GOAL_SCENARIOS.
 */
export function goalScenariosFor(
  s: BriefScenario,
  brief: SystemBrief,
  compiled: readonly CompiledScenario[],
): CompiledScenario[] {
  let hits = s.moduleHint
    ? compiled.filter((c) => c.module === s.moduleHint || (c.withModules ?? []).includes(s.moduleHint ?? ""))
    : [];
  if (hits.length === 0) {
    const goal = brief.goals.find((g) => g.id === s.goalId);
    const words = [s.when, ...s.then, goal?.text ?? ""].join(". ");
    // fallbackGoals answers «attract, leads» for words without any goal stem — not a match here.
    const goals = new Set(fallbackGoals(words));
    const generic =
      goals.size === 2 && goals.has("attract") && goals.has("leads") && !/заявк|сайт/i.test(words);
    hits = generic ? [] : compiled.filter((c) => goals.has(c.goal));
  }
  if (s.actor !== "system") {
    const surface = PUBLIC_ACTORS.has(s.actor) ? "public" : "cabinet";
    const narrowed = hits.filter((c) => (c.surface ?? surface) === surface);
    if (narrowed.length) hits = narrowed;
    else if (surface === "cabinet") {
      // V3-23: no cabinet-only scenario (the owner checks in the cabinet what a visitor did on the site) — the ones
      // where staff act come first.
      const staff = (c: CompiledScenario) =>
        c.steps.some((x) => !PUBLIC_ACTORS.has(x.actor) && x.actor !== "system");
      hits = [...hits.filter(staff), ...hits.filter((c) => !staff(c))];
    }
  }
  return hits.slice(0, MAX_GOAL_SCENARIOS);
}
