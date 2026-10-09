// V3-18: the platform path of a scenario check for the browser tests of composed v3 sites — the gate executor of the
// platform (agents/executors.ts gates: the consent text, the in-process G1 runtime with outbox connectors) over a
// draft held in memory, the platform's Chromium provider, and builds-v3/host.ts checkScenario (G0, then G1 with the
// goal scenarios in the browser).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import type { ScenarioCheckInput, ScenarioCheckResult } from "@wizard/agents/builder";
import type { AppSpec } from "@wizard/appspec";
import type { GateContext } from "@wizard/gates";
import { closeExecutors } from "@wizard/runtime";
import postgres from "postgres";
import { createAgentExecutors } from "../src/agents/executors.js";
import { chromiumProvider, type GoalBrowserProvider } from "../src/agents/goal-browser.js";
import { checkScenario } from "../src/builds-v3/host.js";
import { loadConfig } from "../src/config.js";
import type { BuildHost } from "../src/runs/types.js";
import { createTestDb } from "./helpers.js";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync("/opt/pw-browsers"))
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";

/** Chromium of Playwright is installed (CI: the goals and e2e jobs). */
export const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

/** The owner filled the operator of personal data (the consent text of the forms is rendered from it). */
export const OWNER_COMPLIANCE = {
  operatorName: "ООО «Проверка»",
  operatorContact: "privacy@company.example",
  operatorAddress: "г. Казань, ул. Тестовая, д. 1",
} as const;

/** A draft revision of a system: what the gates of the platform read. */
export interface Draft {
  version: number;
  spec: AppSpec;
  files: Record<string, string>;
}

export interface GoalsEnv {
  /** checkScenario of the platform on the current state of `draft` (a fresh schema key per system). */
  check(draft: Draft, input: ScenarioCheckInput): Promise<ScenarioCheckResult>;
  close(): Promise<void>;
}

/** A throwaway database, the platform's gate executor and Chromium provider. */
export async function goalsEnv(tag: string): Promise<GoalsEnv> {
  const tdb = await createTestDb(tag, { migrator: true });
  const artifacts = mkdtempSync(join(tmpdir(), `wz-${tag}-`));
  const config = loadConfig(process.env, {
    dbUrl: tdb.url,
    artifactsDir: artifacts,
    unsafeLocalExec: true,
    milestone: "M1",
  });
  const pg = postgres(tdb.url, { max: 4, onnotice: () => {} });
  const provider: GoalBrowserProvider = chromiumProvider({
    slots: 1,
    launch: () => chromium.launch({ args: ["--disable-dev-shm-usage"] }),
  });
  const executors = createAgentExecutors({
    pg,
    config,
    goalBrowser: provider,
    g1Sandbox: null,
    photos: null,
  });
  const keys = new WeakMap<Draft, string>();
  let n = 0;
  return {
    check(draft, input) {
      const key = keys.get(draft) ?? `${tag}${(n++).toString(36)}${Date.now().toString(36)}`;
      keys.set(draft, key);
      // The platform's BuildHost.runGates (runs/queue.ts #gate): the gate context of the current draft revision.
      const runGates = (level: "G0" | "G1" | "G2", overrides?: Partial<GateContext>) =>
        (executors.gates as NonNullable<typeof executors.gates>)(level, {
          spec: draft.spec,
          prevSpec: null,
          specVersion: draft.version,
          files: new Map(Object.entries(draft.files)),
          env: "draft",
          systemKey: key,
          db: pg,
          milestone: "M1",
          ...overrides,
        });
      return checkScenario({ runGates } as unknown as BuildHost, provider, true, input);
    },
    async close() {
      await executors.close();
      await provider.close();
      await closeExecutors();
      await pg.end();
      await tdb.drop();
      rmSync(artifacts, { recursive: true, force: true });
    },
  };
}
