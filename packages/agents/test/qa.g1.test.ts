// backlog M0-14 on a real runtime: QA checks from the golden qa_generate lines pass G1 on the golden forum (M0–M2) and bakery;
// a spec with delete opened for the participant is explained as permission_too_broad with an ops fix.
import { type GateReport, runGates } from "@wizard/gates";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createQaAgent, type Explanation } from "../src/qa/index.js";
import { demoRouter, type G1Harness, g1Harness, goldenBuild } from "./qa-helpers.js";

let h: G1Harness;
beforeAll(async () => {
  h = await g1Harness();
});
afterAll(async () => {
  expect(await h.leftoverSchemas()).toBe(0);
  await h.close();
});

const status = (r: GateReport) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
const failing = (r: GateReport) =>
  JSON.stringify(
    r.checks.filter((c) => c.status === "fail" || c.status === "error"),
    null,
    1,
  ).slice(0, 3000);

describe("forum", () => {
  test("golden qa_generate replays; SC-AC1–AC4 and SC-AC7 (+ its PC) pass G1; the gate passes", async () => {
    const { spec, files, card } = await goldenBuild("forum");
    const { route, calls } = demoRouter("forum");
    const qa = createQaAgent({ route });
    const checks = await qa.generate({ card, spec, specVersion: 7 });
    expect(calls).toEqual(["qa_generate"]);
    const sc = checks.filter((c) => c.scenario);
    for (const ac of ["AC1", "AC2", "AC3", "AC4"])
      expect(sc.filter((c) => c.acId === ac).length, ac).toBeGreaterThanOrEqual(1);
    const r = await runGates("G1", h.ctx(spec, files, { checks, specVersion: 7 }));
    const s = status(r);
    for (const id of ["SC-AC1", "SC-AC2", "SC-AC3", "SC-AC4", "SC-AC7", "SC-AC8", "PC-visitor-ticket-read"])
      expect(s[id], `${id} ${failing(r)}`).toBe("pass");
    expect(s["G1-AC-COVER"]).toBe("pass");
    expect(r.passed, failing(r)).toBe(true);
  }, 120_000);
});

// The pilot and its staging run WIZARD_MILESTONE=M2 in fixture mode: the one recorded qa_generate answer must cover
// AC6 (M1) and AC5 (M2) too, otherwise QA asks again and the second call is a FIXTURE_MISS.
describe.each(["M1", "M2"] as const)("forum at %s", (milestone) => {
  test("one golden qa_generate covers every due AC; AC6 (and AC5 at M2) pass G1; the gate passes", async () => {
    const { spec, files, card } = await goldenBuild("forum");
    const { route, calls } = demoRouter("forum");
    const qa = createQaAgent({ route, milestone });
    const checks = await qa.generate({ card, spec, specVersion: 7 });
    expect(calls).toEqual(["qa_generate"]);
    const sc = checks.filter((c) => c.scenario).map((c) => c.id);
    const due = ["SC-AC1", "SC-AC2", "SC-AC3", "SC-AC4", "SC-AC6", ...(milestone === "M2" ? ["SC-AC5"] : [])];
    expect(sc.sort()).toEqual(due.sort());
    const r = await runGates("G1", h.ctx(spec, files, { checks, specVersion: 7, milestone }));
    const s = status(r);
    for (const id of [...due, "SC-AC7", "SC-AC8"]) expect(s[id], `${id} ${failing(r)}`).toBe("pass");
    expect(s["G1-AC-COVER"]).toBe("pass");
    expect(r.passed, failing(r)).toBe(true);
  }, 180_000);
});

describe("bakery", () => {
  test("golden qa_generate replays; every M0 AC passes G1", async () => {
    const { spec, files, card } = await goldenBuild("bakery");
    const { route, calls } = demoRouter("bakery");
    const qa = createQaAgent({ route });
    const checks = await qa.generate({ card, spec, specVersion: 3 });
    expect(calls).toEqual(["qa_generate"]);
    const r = await runGates("G1", h.ctx(spec, files, { checks, specVersion: 3 }));
    const s = status(r);
    for (const id of ["SC-AC1", "SC-AC2", "SC-AC3", "SC-AC4", "SC-AC5", "SC-AC6"])
      expect(s[id], `${id} ${failing(r)}`).toBe("pass");
    expect(s["SC-AC7"]).toBeUndefined(); // M1: not generated; G1-AC-COVER counts it as covered.
    expect(r.passed, failing(r)).toBe(true);
  }, 120_000);
});

describe("explain on a real failure", () => {
  test("delete opened for the participant → permission_too_broad, fix.kind ops, target the permission", async () => {
    const { spec, files, card } = await goldenBuild("forum");
    const ac9 = {
      id: "AC9",
      text: "Участник не может удалить билет",
      check: { type: "permission", role: "participant", entity: "ticket", op: "delete", expect: "deny" },
    } as const;
    const broken = structuredClone(spec);
    broken.acceptance = [...(broken.acceptance ?? []), ac9];
    const idx = broken.permissions.findIndex((p) => p.role === "participant" && p.entity === "ticket");
    const perm = broken.permissions[idx];
    if (!perm) throw new Error("no participant/ticket permission");
    perm.ops = [...perm.ops, "delete"];
    const card9 = { ...card, acceptance: [...card.acceptance, ac9] };
    const { route } = demoRouter("forum");
    const qa = createQaAgent({ route });
    const checks = await qa.generate({ card: card9, spec: broken, specVersion: 8 });
    const report = await runGates("G1", h.ctx(broken, files, { checks, specVersion: 8 }));
    expect(status(report)["SC-AC9"], failing(report)).toBe("fail");
    const ex = (await qa.explain({ card: card9, spec: broken, report })) as Explanation[];
    const e = ex.find((x) => x.checkId === "SC-AC9");
    expect(e).toMatchObject({
      acId: "AC9",
      category: "permission_too_broad",
      fix: { kind: "ops", target: `/permissions/${idx}` },
      owner: "builder",
    });
    // Every failed check is explained, deterministically (no qa_explain line in the fixture).
    const failed = report.checks.filter((c) => c.status === "fail" || c.status === "error").map((c) => c.id);
    expect(ex.map((x) => x.checkId)).toEqual(failed);
  }, 120_000);
});
