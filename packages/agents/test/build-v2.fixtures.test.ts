// B2-21: the recorded answers of the modules pipeline are generated from build-v2-scenarios.ts and stay in sync with
// the prompts (regenerate: WIZARD_GEN_FIXTURES=1 pnpm exec vitest run packages/agents/test/build-v2.fixtures.test.ts).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SECTION_CATALOG } from "@wizard/appspec";
import { compilePlan } from "@wizard/modules";
import { describe, expect, test } from "vitest";
import { customIssues, designIssues, textsIssues } from "../src/builder/index.js";
import { DEFAULT_REGISTRY, planErrors } from "../src/planner/index.js";
import {
  approvedPlan,
  B2_FIXTURE_DIR,
  builtPlan,
  fixtureLines,
  serializeLines,
} from "./build-v2-fixtures.js";
import { B2_CUSTOM_SCENARIOS, B2_SCENARIOS } from "./build-v2-scenarios.js";

const GEN = process.env.WIZARD_GEN_FIXTURES === "1";

describe("B2-21 recorded scenarios (tools/fixtures/demo/b2)", () => {
  test.each(B2_SCENARIOS.map((s) => [s.name, s] as const))(
    "%s: answers are valid for the agents",
    (_n, sc) => {
      const plan = approvedPlan(sc);
      expect(planErrors(plan, DEFAULT_REGISTRY)).toEqual([]);
      expect(textsIssues(plan, sc.texts, DEFAULT_REGISTRY)).toEqual([]);
      expect(designIssues(plan, sc.design, DEFAULT_REGISTRY)).toEqual([]);
      const built = compilePlan(builtPlan(sc), DEFAULT_REGISTRY);
      expect(built.ok, JSON.stringify(built.ok ? [] : built.errors)).toBe(true);
      // Every section type of the scenarios is a ready one (the landing renders it).
      for (const s of plan.landing?.sections ?? [])
        expect(SECTION_CATALOG.find((t) => t.type === s.type)?.ready).toContain(s.variant);
    },
  );

  test.each(B2_CUSTOM_SCENARIOS.map((s) => [s.name, s] as const))(
    "%s: every submit_custom answer passes the tool check (B2-23)",
    (_n, sc) => {
      const built = compilePlan(builtPlan(sc), DEFAULT_REGISTRY);
      if (!built.ok) throw new Error(JSON.stringify(built.errors));
      for (const round of sc.rounds) {
        const asked = built.customSlots.filter((s) => round.items.some((i) => i.id === s.id));
        expect(customIssues(built, asked, round)).toEqual([]);
      }
    },
  );

  test.each([...B2_SCENARIOS, ...B2_CUSTOM_SCENARIOS].map((s) => [s.name, s] as const))(
    "%s: fixture file is up to date",
    (_n, sc) => {
      const text = serializeLines(fixtureLines(sc));
      const path = join(B2_FIXTURE_DIR, `${sc.name}.jsonl`);
      if (GEN) {
        mkdirSync(B2_FIXTURE_DIR, { recursive: true });
        writeFileSync(path, text);
      }
      expect(readFileSync(path, "utf8")).toBe(text);
    },
  );
});
