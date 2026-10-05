// M2-39: the QA few-shot is one reference scenario per release class (agents/qa.yaml#checks.reference_scenarios), not the
// forum; every reference is valid by scenario_dsl and passes G1 on a synthetic spec of its class.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { validateSpec } from "@wizard/appspec";
import { type GateReport, runGates } from "@wizard/gates";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  GENERATE_SYSTEM,
  QA_ASSETS,
  qaValidateScenario,
  scenarioChecks,
  scenarioSchema,
} from "../../src/qa/index.js";
import { loadYaml, ROOT } from "../helpers.js";
import { type G1Harness, g1Harness } from "../qa-helpers.js";
import { CLASS_SPECS } from "./class-specs.js";

type Ref = { class: "site" | "booking" | "crm"; title_ru: string; scenario: Record<string, unknown> };
const refs = (loadYaml("specs/agents/qa.yaml") as { checks: { reference_scenarios: Ref[] } }).checks
  .reference_scenarios;

const acOf = (sc: { acId?: unknown; title?: unknown }) => ({
  id: String(sc.acId),
  text: String(sc.title),
  check: { type: "scenario" as const },
});

describe("qa.json few-shot", () => {
  test("gen-qa-assets --check passes; no forum words; one reference per class site, booking, crm", () => {
    const r = spawnSync(process.execPath, ["packages/agents/scripts/gen-qa-assets.mjs", "--check"], {
      cwd: new URL(".", ROOT).pathname,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(new URL("packages/agents/assets/qa.json", ROOT), "utf8").toLowerCase();
    for (const w of ["форум", "билет", "ticket"]) expect(text).not.toContain(w);
    expect(refs.map((x) => x.class)).toEqual(["site", "booking", "crm"]);
    expect(QA_ASSETS.examples).toHaveLength(3);
    for (const x of refs) expect(GENERATE_SYSTEM).toContain(`${x.class} (${x.title_ru}):`);
    expect(GENERATE_SYSTEM.toLowerCase()).not.toMatch(/форум|билет|ticket/);
  });

  test.each(refs.map((x) => [x.class, x] as const))(
    "%s: valid by scenario_dsl on the class spec",
    (cls, ref) => {
      const spec = CLASS_SPECS[cls];
      const v = validateSpec(spec);
      expect(v.ok, JSON.stringify(v)).toBe(true);
      const sc = scenarioSchema.parse(ref.scenario);
      expect(qaValidateScenario(spec, sc, acOf(sc))).toEqual([]);
    },
  );
});

describe("references pass G1 on synthetic class specs", () => {
  let h: G1Harness;
  beforeAll(async () => {
    h = await g1Harness();
  });
  afterAll(async () => {
    expect(await h.leftoverSchemas()).toBe(0);
    await h.close();
  });

  const failing = (r: GateReport) =>
    JSON.stringify(
      r.checks.filter((c) => c.status === "fail" || c.status === "error"),
      null,
      1,
    ).slice(0, 3000);

  test.each(refs.map((x) => [x.class, x] as const))(
    "%s",
    async (cls, ref) => {
      const sc = scenarioSchema.parse(ref.scenario);
      const ac = acOf(sc);
      const spec = { ...structuredClone(CLASS_SPECS[cls]), acceptance: [ac] } as typeof CLASS_SPECS.site;
      const checks = scenarioChecks(ac, [sc]);
      const r = await runGates("G1", h.ctx(spec, new Map(), { checks, milestone: "M2" }));
      const st = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
      expect(st[sc.id], failing(r)).toBe("pass");
    },
    120_000,
  );
});
