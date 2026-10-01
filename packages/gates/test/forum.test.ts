// backlog M0-10: runGates('G0') on the forum (forum.json + specs/runtime/examples) passes; the report is a
// GateReport (gates.yaml#report, api.yaml#/components/schemas/GateReport); G0 time is recorded and ≤ 60 s.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
// @ts-expect-error — plain ESM module without types
import { validateSchema } from "../../../tools/specs/validate.mjs";
import { G0_CHECKS, G0_TIME_BUDGET_MS, type GateReport, runGates } from "../src/index.js";
import { forumCtx as baseCtx, connect, loadYaml, REPO_ROOT, uniqueKey } from "./helpers.js";

const db = connect();
// Own systemKey prefix: other files run G0 on the same database at the same time, so the shadow-schema
// leak check below counts only this file's schemas (FU-3).
const KEY_PREFIX = `gf${randomBytes(3).toString("hex")}`;
const forumCtx: typeof baseCtx = (d, over = {}) => baseCtx(d, { systemKey: uniqueKey(KEY_PREFIX), ...over });
afterAll(() => db.end());

const apiSpec = (await loadYaml(join(REPO_ROOT, "specs/platform/api.yaml"))) as {
  components: { schemas: Record<string, unknown> };
};
const gatesYaml = (await loadYaml(join(REPO_ROOT, "specs/quality/gates.yaml"))) as {
  report: { GateReport: object };
};

function stable(r: GateReport) {
  return { ...r, startedAt: "", durationMs: 0, checks: r.checks.filter((c) => c.id !== "G0") };
}

describe("G0 on the forum", () => {
  let first: GateReport;

  test("passes; every M0 check passes, M1 warnings are skipped", async () => {
    first = await runGates("G0", forumCtx(db, { specVersion: 7 }));
    const bad = first.checks.filter((c) => c.status === "fail" || c.status === "error");
    expect(bad).toEqual([]);
    expect(first.passed).toBe(true);
    expect(first.level).toBe("G0");
    expect(first.specVersion).toBe(7);
    for (const def of G0_CHECKS) {
      const mine = first.checks.filter((c) => c.id === def.id);
      expect(mine.length, def.id).toBe(1);
      expect(mine[0]?.status, def.id).toBe(def.since ? "skip" : "pass");
      expect(mine[0]?.severity, def.id).toBe(def.severity);
    }
  }, 120_000);

  test("time is recorded and stays within the 60 s budget", () => {
    expect(Number.isInteger(first.durationMs)).toBe(true);
    expect(first.durationMs).toBeGreaterThan(0);
    expect(first.durationMs).toBeLessThanOrEqual(G0_TIME_BUDGET_MS);
    expect(new Date(first.startedAt).toISOString()).toBe(first.startedAt);
  });

  test("report matches api.yaml GateReport and gates.yaml#report", () => {
    const errors = validateSchema(apiSpec.components.schemas.GateReport, first, apiSpec) as unknown[];
    expect(errors).toEqual([]);
    const s = first.summary;
    expect(s.pass + s.fail + s.warn + s.skip + s.error).toBe(first.checks.length);
    const fields = Object.keys(gatesYaml.report.GateReport);
    for (const k of Object.keys(first)) expect(fields).toContain(k);
  });

  test("deterministic on the same revision", async () => {
    const again = await runGates("G0", forumCtx(db, { specVersion: 7 }));
    expect(stable(again)).toEqual(stable(first));
  }, 120_000);

  test("prod with an additive previous revision passes", async () => {
    const ctx = forumCtx(db, { env: "prod" });
    const r = await runGates("G0", { ...ctx, prevSpec: ctx.spec });
    expect(r.passed).toBe(true);
  }, 120_000);

  test("G2 and G1 without a runtime cannot check the permission matrix: error report, not passed", async () => {
    const g2 = await runGates("G2", forumCtx(db));
    expect(g2).toMatchObject({ level: "G2", passed: false, summary: { error: 4 } });
    expect(validateSchema(apiSpec.components.schemas.GateReport, g2, apiSpec)).toEqual([]);
    const g1 = await runGates("G1", forumCtx(db));
    expect(g1).toMatchObject({ level: "G1", passed: false });
    expect(g1.summary.error).toBeGreaterThan(1);
    expect(validateSchema(apiSpec.components.schemas.GateReport, g1, apiSpec)).toEqual([]);
  });

  test("shadow schemas never survive a run", async () => {
    const rows =
      await db`select nspname from pg_namespace where nspname like ${`app\\_${KEY_PREFIX}\\_%\\_shadow`}`;
    expect(rows.length).toBe(0);
  });
});
