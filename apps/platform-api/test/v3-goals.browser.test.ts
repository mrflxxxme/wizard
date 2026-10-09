// V3-18 (the 0 ₽ rung of a v3 build): the four eval briefs of checkpoint 1 (packages/agents/test/v3-eval-briefs.ts —
// a multi-page site with a lead form, booking with a client cabinet, a CRM with a site, a tour catalog with a blog) are
// built by the harness v3 (runBuildV3) with the platform's page composer on the real pattern library and no model: the
// skeleton of createPageComposer, a scenario step that keeps it. Each brief scenario is checked the way the platform
// checks it — builds-v3/host.ts checkScenario: G0, then G1 with the goal scenarios goalScenariosFor picks, run by the
// platform's gate executor (agents/executors.ts gates: consent text, the in-process G1 runtime with outbox connectors)
// in the platform's Chromium provider (390 px light, 1280 px dark). Every scenario must pass: the goal programs of the
// modules (packages/gates/src/goals/programs) find their DOM contract on the composed v3 pages. The final gates of the
// harness are not repeated here (the same goal scenarios, already run per scenario). Every variant of the forms of the
// library under the goal programs — v3-goals-variants.browser.test.ts.
// The v3 features the eval briefs do not reach are built from two feature briefs (packages/agents/test/
// v3-feature-briefs.ts: «Мои заявки» of the client cabinet, booking by a package), and the goal scenarios a brief
// scenario does not pick (GS-booking-4, the reschedule by the e-mail's link) run on the final draft. PROVEN lists the
// goal scenarios each build must run and pass: the owner's photos on the v3 pages (GS-landing-2), the client cabinet
// (GS-visitor_cabinet-1/2), the reschedule (GS-booking-4) and «Абонементы» on a v3 booking pattern (GS-packages-2/3).
import {
  createPageComposer,
  type PageComposer,
  runBuildV3,
  type V3BriefVersion,
  type V3Checkpoint,
  type V3Host,
  type V3Outcome,
} from "@wizard/agents/builder";
import { DEFAULT_REGISTRY } from "@wizard/agents/planner";
import {
  type AppSpec,
  type BriefScenario,
  emptySpec,
  type SystemBriefInput,
  systemBriefSchema,
} from "@wizard/appspec";
import type { GateReport, GoalScenarioInput } from "@wizard/gates";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EVAL_BRIEFS } from "../../../packages/agents/test/v3-eval-briefs.js";
import { FEATURE_BRIEFS } from "../../../packages/agents/test/v3-feature-briefs.js";
import { type Draft, type GoalsEnv, goalsEnv, hasChromium, OWNER_COMPLIANCE } from "./v3-goals-helpers.js";

/** The page writer of the platform without a model: the skeleton; a scenario step keeps it (0 ₽). */
const real = createPageComposer();
const composer: PageComposer = {
  skeleton: (ctx) => real.skeleton(ctx),
  scenario: async () => ({ files: new Map(), pages: [], notes: [], spentRub: 0 }),
};

const passing = (level: string, version: number): GateReport => ({
  level: level as GateReport["level"],
  passed: true,
  specVersion: version,
  startedAt: new Date().toISOString(),
  durationMs: 0,
  checks: [],
  summary: { pass: 0, fail: 0, warn: 0, skip: 0, error: 0 },
});

let env: GoalsEnv;
beforeAll(async () => {
  if (hasChromium) env = await goalsEnv("v3goals");
}, 60_000);
afterAll(async () => {
  await env?.close();
});

/** What a check of one brief scenario said: its goal scenarios and the problems (Russian, as the owner sees them). */
interface Checked {
  scenario: string;
  goals: string[];
  /** Titles of the goal scenarios (a failing one is named by its title in the problems). */
  titles: string[];
  ok: boolean;
  problems: string[];
}

/**
 * Goal scenarios a build must run and pass (V3-18): the v3 features they prove. Those a brief scenario does not pick
 * run on the final draft with that brief scenario (`extra`).
 */
const PROVEN: Readonly<
  Record<string, { goals: readonly string[]; extra?: { scenario: string; goals: string[] } }>
> = {
  // The owner's photo of «Фото сайта» on the v3 home page.
  "v3-01-interior-studio": { goals: ["GS-landing-2"] },
  // «Мои записи» of the client cabinet /me; the reschedule by the e-mail's link on the v3 booking pattern.
  "v3-02-dental-booking": {
    goals: ["GS-visitor_cabinet-1", "GS-booking-4"],
    extra: { scenario: "s_book", goals: ["GS-booking-4"] },
  },
  // «Мои заявки» of the client cabinet.
  "v3-x-cleaning-cabinet": { goals: ["GS-visitor_cabinet-2"] },
  // «Абонементы»: booking on the v3 pattern writes a visit off, an ended package refuses.
  "v3-x-yoga-packages": { goals: ["GS-packages-2", "GS-packages-3"] },
};

/** A goal scenario of the module library by its id, as the backend compile gives it to the browser check. */
function goalScenario(id: string): GoalScenarioInput {
  for (const m of DEFAULT_REGISTRY.modules) {
    const g = m.manifest.goalScenarios.find((x) => x.id === id);
    if (g)
      return {
        id: g.id,
        module: m.manifest.id,
        goal: g.goal,
        title: g.title,
        steps: g.steps,
        expect: g.expect,
      };
  }
  throw new Error(`no goal scenario ${id}`);
}

/** Builds a brief by the harness v3 over an in-memory draft; each scenario through the platform's checkScenario. */
async function build(
  id: string,
  input: SystemBriefInput,
): Promise<{ out: V3Outcome; checked: Checked[]; draft: Draft; scenarios: BriefScenario[] }> {
  const brief: V3BriefVersion = { version: 1, brief: systemBriefSchema.parse(input) };
  // The owner filled the operator of personal data: the draft the build starts from carries it.
  const owner = { ...emptySpec("Система"), compliance: { ...OWNER_COMPLIANCE } } as AppSpec;
  const draft: Draft = { version: 1, spec: owner, files: {} };
  const checkpoints = new Map<string, V3Checkpoint>();
  const checked: Checked[] = [];
  const host: V3Host = {
    run: { id: `run-${id}` },
    systemId: `sys-${id}`,
    runStep: (_n, fn) => fn(),
    emit: () => {},
    route: async () => {
      throw new Error("0 ₽: модель не подключена");
    },
    brief: async () => brief,
    checkpoints: {
      load: async () => [...checkpoints.values()],
      save: async (cp) => {
        checkpoints.set(cp.key, cp);
      },
    },
    currentSpec: async () => ({ spec: draft.spec, version: draft.version }),
    commit: async ({ spec, files }) => {
      draft.version += 1;
      draft.spec = spec;
      draft.files = { ...files };
      return { revision: draft.version };
    },
    // The final gates repeat the goal scenarios of the scenarios already checked: not run again here.
    runGates: async (level) => passing(level, draft.version),
    composer,
    checkScenario: async (input) => {
      const r = await env.check(draft, input);
      checked.push({
        scenario: input.scenario.id,
        goals: input.goalScenarios.map((g) => g.id),
        titles: input.goalScenarios.map((g) => g.title),
        ok: r.ok,
        problems: r.problems,
      });
      return r;
    },
    goalBrowser: false,
  };
  const out = await runBuildV3(host, { appName: "Проверка", limits: { timeMs: 6 * 60 * 60_000 } });
  // Goal scenarios no brief scenario picks: on the final draft, with the brief scenario they belong to.
  const extra = PROVEN[id]?.extra;
  const scenario = brief.brief.scenarios.find((x) => x.id === extra?.scenario);
  if (extra && scenario) {
    const goalScenarios = extra.goals.map(goalScenario);
    const r = await env.check(draft, { scenario, goalScenarios, routes: [], revision: draft.version });
    checked.push({
      scenario: `${scenario.id}+`,
      goals: goalScenarios.map((g) => g.id),
      titles: goalScenarios.map((g) => g.title),
      ok: r.ok,
      problems: r.problems,
    });
  }
  return { out, checked, draft, scenarios: brief.brief.scenarios };
}

describe.skipIf(!hasChromium)(
  "v3 build without a model: goal scenarios of every brief scenario in Chromium",
  () => {
    for (const [id, input] of Object.entries({ ...EVAL_BRIEFS, ...FEATURE_BRIEFS }))
      test(id, async () => {
        const { out, checked, scenarios } = await build(id, input);
        expect(out.status, JSON.stringify(out)).toBe("succeeded");
        // Every brief scenario was checked in the browser with at least one goal scenario of its modules…
        expect(
          checked
            .filter((c) => !c.scenario.endsWith("+"))
            .map((c) => c.scenario)
            .sort(),
        ).toEqual(scenarios.map((s) => s.id).sort());
        expect(checked.every((c) => c.goals.length > 0)).toBe(true);
        // …and passed: no goal program misses its hooks on the composed pages, no v3 feature is missing.
        expect(checked.filter((c) => !c.ok)).toEqual([]);
        if (out.status === "succeeded")
          expect(out.scenarios.filter((s) => s.status !== "passed")).toEqual([]);
        // The features this build proves ran (and passed above).
        const ran = new Set(checked.flatMap((c) => c.goals));
        for (const goal of PROVEN[id]?.goals ?? []) expect(ran.has(goal), `${id}: ${goal}`).toBe(true);
      }, 1_800_000);
  },
);
