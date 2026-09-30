// Acceptance M0-15 (L1-11): gate_G0 stores the full GateReport in platform.gate_reports (with gate_result in the
// same transaction); getLatestGates reads it back per level with max(revision).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { BuildHost, GateReport, RunExecutors } from "../src/runs/types.js";
import { startBuild } from "./flow.js";
import {
  createTestDb,
  fakeInterview,
  fakeRouterFactory,
  passingReport,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
const reports: GateReport[] = [];

function richReport(level: "G0" | "G1", specVersion: number, passed: boolean): GateReport {
  const base = passingReport(level, specVersion, passed);
  const checks = [
    ...base.checks,
    ...Array.from({ length: 25 }, (_, i) => ({
      id: `G0-LINT-${i}`,
      status: "fail" as const,
      severity: "warning" as const,
      message_ru: `Замечание ${i}`,
      evidence: "без ПДн",
    })),
  ];
  return { ...base, checks, explanations: level === "G1" ? [{ checkId: "x", text_ru: "…" }] : undefined };
}

const executors: RunExecutors = {
  interviewTurn: fakeInterview,
  gates: async (level, ctx) => {
    expect(ctx.systemKey).toMatch(/^[a-z0-9]{12}$/);
    expect(ctx.env).toBe("draft");
    expect([...ctx.files.keys()]).toEqual(["ui/Home.tsx"]);
    const r = JSON.parse(JSON.stringify(richReport(level as "G0", ctx.specVersion, reports.length > 0)));
    reports.push(r);
    return r;
  },
  build: async (host: BuildHost) => {
    const { version } = await host.store.getSpec();
    const r = await host.store.applyOps(
      [{ op: "add_role", name: "guest", label: "Гость", access: "public" }],
      version,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    await host.store.writeFile("ui/Home.tsx", "export default () => null;\n");
    const g0a = await host.runGates("G0"); // fails (first report)
    expect(g0a.passed).toBe(false);
    await host.store.writeFile("ui/Home.tsx", "export default () => null; // fixed\n");
    const g0b = await host.runGates("G0"); // passes on a new revision
    expect(g0b.passed).toBe(true);
    await host.runGates("G1");
    return { summary_ru: "ok" };
  },
};

beforeAll(async () => {
  tdb = await createTestDb("gates");
  api = await startApi(tdb.url, { executors, createRouter: fakeRouterFactory() });
});
afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

describe("gate reports", () => {
  test("full report stored, compressed gate_result emitted, latest per level returned", async () => {
    const b = await startBuild(api, "Кондитерская");
    const run = await waitRun(api, b.buildRunId, ["succeeded"]);
    const rows = await api.deps.db
      .selectFrom("platform.gate_reports")
      .selectAll()
      .where("system_id", "=", b.systemId)
      .orderBy("created_at")
      .execute();
    expect(rows.map((r) => [r.level, r.passed])).toEqual([
      ["G0", false],
      ["G0", true],
      ["G1", true],
    ]);
    expect(rows.map((r) => r.report)).toEqual(reports.map((r) => JSON.parse(JSON.stringify(r))));
    expect(rows[0]?.revision).toBeLessThan(rows[1]?.revision as number);

    const events = await api.deps.db
      .selectFrom("platform.run_events")
      .selectAll()
      .where("run_id", "=", run.id)
      .where("type", "=", "gate_result")
      .orderBy("seq")
      .execute();
    const first = events[0]?.payload as { failedChecks: unknown[]; totalChecks: number; passed: boolean };
    expect(first.passed).toBe(false);
    expect(first.failedChecks).toHaveLength(20);
    expect(first.totalChecks).toBe(reports[0]?.checks.length);
    expect(JSON.stringify(first)).not.toContain("evidence");

    const g0rev = rows[1]?.revision as number;
    const rev = await api.req("GET", `/systems/${b.systemId}/revisions/${g0rev}`);
    expect(rev.body.g0Passed).toBe(true);
    const failedRev = await api.req("GET", `/systems/${b.systemId}/revisions/${rows[0]?.revision}`);
    expect(failedRev.body.g0Passed).toBe(false);

    const latest = await api.req("GET", `/systems/${b.systemId}/gates/latest`);
    expect(latest.status).toBe(200);
    expect(latest.body.runId).toBe(run.id);
    expect(latest.body.revision).toBe(g0rev);
    expect(latest.body.reports).toEqual([rows[1]?.report, rows[2]?.report]);
  });

  test("no reports yet → empty list at draft revision", async () => {
    const created = await api.req("POST", "/systems", { body: { prompt: "Пустая система" } });
    const latest = await api.req("GET", `/systems/${created.body.system.id}/gates/latest`);
    expect(latest.body).toEqual({ revision: 0, reports: [] });
  });
});
