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
import {
  createPageComposer,
  type PageComposer,
  runBuildV3,
  type V3BriefVersion,
  type V3Checkpoint,
  type V3Host,
  type V3Outcome,
} from "@wizard/agents/builder";
import { type AppSpec, emptySpec, type SystemBriefInput, systemBriefSchema } from "@wizard/appspec";
import type { GateReport } from "@wizard/gates";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EVAL_BRIEFS } from "../../../packages/agents/test/v3-eval-briefs.js";
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
 * Gaps of the v3 public front this rung still finds — features v3 does not have yet, not hooks of the DOM contract
 * (reported in V3-18, specs/CHANGELOG.md 09.10.2026): brief → scenario → the goal scenario that fails and why. Such a
 * scenario passes everything else; when a gap is closed its row goes (the test says so).
 */
const KNOWN_GAPS: Readonly<Record<string, Readonly<Record<string, { goal: string; why: string }>>>> = {
  "v3-01-interior-studio": {
    s_home: { goal: "GS-landing-2", why: "страницы v3 не показывают фото владельца из «Фото сайта»" },
  },
  "v3-02-dental-booking": {
    s_cabinet: { goal: "GS-visitor_cabinet-1", why: "кабинет клиента /me на v3 — пустая страница" },
  },
};

/** Builds a brief by the harness v3 over an in-memory draft; each scenario through the platform's checkScenario. */
async function build(id: string, input: SystemBriefInput): Promise<{ out: V3Outcome; checked: Checked[] }> {
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
  return { out, checked };
}

describe.skipIf(!hasChromium)(
  "v3 build without a model: goal scenarios of every brief scenario in Chromium",
  () => {
    for (const [id, input] of Object.entries(EVAL_BRIEFS))
      test(id, async () => {
        const { out, checked } = await build(id, input);
        expect(out.status, JSON.stringify(out)).toBe("succeeded");
        // Every brief scenario was checked in the browser with at least one goal scenario of its modules…
        const scenarios = (input.scenarios ?? []).map((s) => s.id);
        expect(checked.map((c) => c.scenario).sort()).toEqual([...scenarios].sort());
        expect(checked.every((c) => c.goals.length > 0)).toBe(true);
        // …and passed: no goal program misses its hooks on the composed pages. A known gap fails only by its own goal
        // scenario (everything else of the scenario passes) — and still fails, else its row must go.
        const gaps = KNOWN_GAPS[id] ?? {};
        const failed = checked.filter((c) => !c.ok && !gaps[c.scenario]);
        expect(failed).toEqual([]);
        for (const [scenario, gap] of Object.entries(gaps)) {
          const c = checked.find((x) => x.scenario === scenario);
          const title = c?.titles[c.goals.indexOf(gap.goal)];
          expect(title, `${scenario}: ${gap.goal} среди сценариев цели`).toBeDefined();
          expect(c?.ok, `${scenario}: пробел «${gap.why}» закрыт — уберите его из KNOWN_GAPS`).toBe(false);
          expect(c?.problems.filter((p) => !p.includes(`«${title}»`))).toEqual([]);
        }
        if (out.status === "succeeded")
          expect(
            out.scenarios
              .filter((s) => s.status !== "passed")
              .map((s) => s.id)
              .sort(),
          ).toEqual(Object.keys(gaps).sort());
      }, 1_800_000);
  },
);
