// backlog M0-11: G1 against a real apps/runtime (createRuntimeApp) on an ephemeral schema with seed.
// Forum: AC1–AC4, AC7 pass; AC5, AC6 skip (milestone); G1-AC-COVER pass. A broken permission fails exactly the
// expected checks. No app_%_g1_% schema survives the suite.
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
// @ts-expect-error — plain ESM module without types
import { validateSchema } from "../../../tools/specs/validate.mjs";
import { type GateReport, g1Checks, type QaCheck, runG1, runGates } from "../src/index.js";
import { type G1Harness, g1Harness, loadBakery } from "./g1-helpers.js";
import { loadForum, loadYaml, REPO_ROOT } from "./helpers.js";

const apiSpec = (await loadYaml(join(REPO_ROOT, "specs/platform/api.yaml"))) as {
  components: { schemas: Record<string, unknown> };
};

let h: G1Harness;
beforeAll(async () => {
  h = await g1Harness();
});
afterAll(async () => {
  // gates.yaml#G1.cleanup: no ephemeral schema survives the suite.
  expect(await h.leftoverSchemas()).toBe(0);
  await h.close();
});

const status = (r: GateReport) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
const detail = (r: GateReport) =>
  JSON.stringify(
    r.checks.filter((c) => c.status === "fail" || c.status === "error"),
    null,
    1,
  ).slice(0, 3000);
const failing = (r: GateReport) =>
  r.checks
    .filter((c) => c.status === "fail" || c.status === "error")
    .map((c) => c.id)
    .sort();

/** QA scenario for AC1 (a ticket AC): a participant sees only their own tickets. */
const participantIsolation: QaCheck = {
  id: "SC-AC1-2",
  acId: "AC1",
  kind: "scenario",
  level: "G1",
  scenario: {
    id: "SC-AC1-2",
    acId: "AC1",
    title: "Участник не видит чужие билеты",
    actors: { org: { role: "organizer" }, anna: { role: "participant" }, boris: { role: "participant" } },
    steps: [
      { as: "org" },
      { create: { entity: "stream", data: { name: "Поток", capacity: 10 }, save: "s" } },
      {
        create: {
          entity: "ticket_type",
          data: { name: "Стандарт", kind: "standard", price: 1000, capacity: 10 },
          save: "tt",
        },
      },
      { as: "anna" },
      {
        callFn: {
          name: "registerTicket",
          args: {
            ticketTypeId: "$tt.id",
            streamId: "$s.id",
            holderName: "Анна Тестова",
            holderEmail: "user1@example.test",
          },
          save: "t",
        },
        consent: true,
      },
      { as: "boris" },
      { read: { entity: "ticket" } },
      { expect: { count: 0 } },
      { read: { entity: "ticket", id: "$t.ticketId" } },
      { expect: { status: "not_found" } },
    ],
  },
};

describe("G1 on the forum", () => {
  let report: GateReport;

  test("AC1–AC4, AC7 pass; AC5, AC6 skip (milestone); G1-AC-COVER pass; the gate passes", async () => {
    report = await runGates("G1", h.ctx({ specVersion: 3 }));
    const s = status(report);
    for (const id of ["SC-AC1", "SC-AC2", "SC-AC3", "SC-AC4", "SC-AC7"])
      expect(s[id], `${id} ${detail(report)}`).toBe("pass");
    expect(s["SC-AC5"]).toBe("skip");
    expect(s["SC-AC6"]).toBe("skip");
    expect(s["G1-AC-COVER"]).toBe("pass");
    expect(s["G1-FN-01"]).toBe("pass");
    expect(s["G1-RENDER-01"]).toBe("skip");
    expect(failing(report), detail(report)).toEqual([]);
    expect(report).toMatchObject({ level: "G1", passed: true, specVersion: 3 });
    expect(report.checks.find((c) => c.id === "SC-AC7")?.acId).toBe("AC7");
    expect(validateSchema(apiSpec.components.schemas.GateReport, report, apiSpec)).toEqual([]);
    expect(report.durationMs).toBeLessThan(120_000);
  }, 120_000);

  test("permission probes: public role matrix, row isolation, hidden/ro via QA, consent (create without consent → 422)", () => {
    const s = status(report);
    const visitor = Object.keys(s).filter((id) => id.startsWith("PC-visitor-"));
    expect(visitor).toHaveLength(8 * 4);
    for (const id of visitor) expect(s[id], id).toBe("pass");
    for (const id of [
      "PC-participant-ticket-row",
      "PC-speaker-speaker_application-row",
      "PC-partner-partner_quota-row",
    ])
      expect(s[id], id).toBe("pass");
    expect(s["PC-speaker-speaker_application-consent"]).toBe("pass");
  });

  test("full PC matrix from QA runs green on the golden forum", async () => {
    const { generatePermissionChecks } = await import("../src/index.js");
    const r = await runGates("G1", h.ctx({ checks: generatePermissionChecks(loadForum()) }));
    expect(failing(r), detail(r)).toEqual([]);
    expect(r.checks.filter((c) => c.id.startsWith("PC-")).length).toBeGreaterThan(7 * 8 * 4);
  }, 120_000);

  test("broken spec (participant reads tickets without rowFilter) fails exactly the expected checks", async () => {
    const golden = loadForum();
    const broken = loadForum();
    const p = broken.permissions.find((x) => x.role === "participant" && x.entity === "ticket");
    delete p?.rowFilter;
    const qa = [...g1Checks(golden), participantIsolation];
    const ok = await runGates("G1", h.ctx({ checks: qa }));
    expect(failing(ok), detail(ok)).toEqual([]);
    const r = await runGates("G1", h.ctx({ spec: broken, checks: qa }));
    expect(failing(r), detail(r)).toEqual(["PC-participant-ticket-row", "SC-AC1-2"]);
    expect(r.passed).toBe(false);
    const row = r.checks.find((c) => c.id === "PC-participant-ticket-row");
    expect(row?.path).toMatch(/^\/permissions\/\d+$/);
    expect(row?.evidence).toContain("HTTP 200");
  }, 120_000);

  test("a wrong expectation fails with step evidence; an invalid scenario is an error and breaks coverage", async () => {
    const spec = loadForum() as AppSpec & { acceptance: { check: { steps?: Record<string, unknown>[] } }[] };
    const ac1 = spec.acceptance[0]?.check.steps as Record<string, unknown>[];
    ac1[ac1.length - 1] = { expect: { error: "SOLD_OUT" } };
    const ac3 = spec.acceptance[2]?.check.steps as Record<string, unknown>[];
    ac3[4] = { read: { entity: "speaker_application", id: "$nope.id" } };
    const r = await runGates("G1", h.ctx({ spec }));
    const s = status(r);
    expect(s["SC-AC1"], detail(r)).toBe("fail");
    const ac1Check = r.checks.find((c) => c.id === "SC-AC1");
    expect(ac1Check?.evidence).toContain("шаг 10: ожидалось error=SOLD_OUT, получено HTTP 400 STREAM_FULL");
    expect(s["SC-AC3"]).toBe("error");
    expect(r.checks.find((c) => c.id === "SC-AC3")?.evidence).toContain("check_invalid");
    const cover = r.checks.filter((c) => c.id === "G1-AC-COVER");
    // D75: an uncovered scenario AC is a warning, not a blocker.
    expect(cover.map((c) => [c.status, c.severity])).toEqual([["warn", "warning"]]);
    expect(cover[0]?.path).toBe("/acceptance/2");
    expect(r.passed).toBe(false);
  }, 120_000);

  test("consent probe fails when the runtime accepts a create without consent", async () => {
    // QA believed session.room holds personal data; the golden spec does not mark it, so the runtime takes it.
    const variant = loadForum();
    const room = variant.entities.find((e) => e.name === "session")?.fields.find((f) => f.name === "room");
    if (room) room.pii = "basic";
    const { generateConsentChecks } = await import("../src/index.js");
    const probe = generateConsentChecks(variant).find((c) => c.id === "PC-moderator-session-consent");
    expect(probe).toBeDefined();
    const r = await runGates("G1", h.ctx({ checks: [probe as QaCheck] }));
    const c = r.checks.find((x) => x.id === "PC-moderator-session-consent");
    expect(c?.status).toBe("fail");
    expect(c?.evidence).toContain("HTTP 201");
  }, 120_000);

  test("milestone M1: the M1 AC runs (retention via advanceTime) at the wall clock, M2 stays skipped", async () => {
    // No pinned `now`: the platform (draft build and gate_G1_prod at publish) runs G1 at the wall clock.
    const r = await runGates("G1", h.ctx({ milestone: "M1" }));
    const s = status(r);
    expect(s["SC-AC5"]).toBe("skip");
    expect(s["SC-AC6"], detail(r)).toBe("pass");
    expect(s["G1-AC-COVER"]).toBe("pass");
    expect(s["G1-RENDER-01"], detail(r)).toBe("pass");
  }, 120_000);

  test("AC6 does not depend on the date G1 runs at; a retention miss shows the field as null, not «скрыто»", async () => {
    // docs/reviews/impl-notes/M2-AC6-prod-g1.md: the example function fixes the event date, so AC6 pins the ticket's
    // event_starts_at to the scenario's $now before advanceTime. The same steps expecting a non-null holder_name fail
    // with evidence that names the anonymised value.
    const ac6 = loadForum().acceptance?.find((a) => a.id === "AC6")?.check as {
      actors: Record<string, { role: string }>;
      steps: Record<string, unknown>[];
    };
    const steps = ac6.steps.map((s) =>
      s.expect && (s.expect as { fields?: Record<string, unknown> }).fields?.holder_name === null
        ? { expect: { fields: { holder_name: "Участник 1" } } }
        : s,
    );
    const inverted = {
      id: "SC-AC6-2",
      acId: "AC6",
      kind: "constraint",
      level: "G1",
      scenario: { id: "SC-AC6-2", acId: "AC6", title: "Ретенция", actors: ac6.actors, steps },
    } as unknown as QaCheck;
    const r = await runGates(
      "G1",
      h.ctx({ milestone: "M2", now: new Date("2027-06-01T00:00:00.000Z"), checks: [inverted] }),
    );
    expect(status(r)["SC-AC6"], detail(r)).toBe("pass");
    const c = r.checks.find((x) => x.id === "SC-AC6-2");
    expect(c?.status).toBe("fail");
    expect(c?.evidence).toContain("ожидалось holder_name=«скрыто», получено holder_name=null");
  }, 120_000);

  test("M2-03: simulate qr/sync (forum AC5 steps) — device A accepted, device B duplicate, one check-in of the ticket", async () => {
    // AC5 of forum.json reads every checkin (count 1), but G1 seed already has check-ins in the shared schema: the
    // same steps with the read narrowed to the scanned ticket (docs/reviews/impl-notes/M2-03.md).
    const ac5 = loadForum().acceptance?.find((a) => a.id === "AC5")?.check as {
      actors: Record<string, { role: string }>;
      steps: Record<string, unknown>[];
    };
    const steps = ac5.steps.map((s) =>
      s.read ? { read: { entity: "checkin", where: { ticket: "$t1.ticketId" } } } : s,
    );
    const check = {
      id: "SC-AC5-2",
      acId: "AC5",
      kind: "scenario",
      level: "G1",
      scenario: { id: "SC-AC5-2", acId: "AC5", title: "Офлайн-синхронизация", actors: ac5.actors, steps },
    } as unknown as QaCheck;
    const r = await runGates("G1", h.ctx({ milestone: "M2", checks: [check] }));
    expect(status(r)["SC-AC5-2"], detail(r)).toBe("pass");
  }, 120_000);

  test("time budget: checks over the budget end with error, the gate fails", async () => {
    const r = await runG1(h.ctx(), { timeBudgetMs: 1 });
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.id === "SC-AC1")?.status).toBe("error");
  }, 120_000);

  test("no runtime → every check is an error, not passed", async () => {
    const r = await runGates("G1", h.ctx({ runtime: undefined }));
    expect(r.passed).toBe(false);
    expect(status(r)["SC-AC1"]).toBe("error");
    expect(status(r)["SC-AC5"]).toBe("skip");
  });
});

describe("G1 on the bakery", () => {
  test("full PC matrix from QA runs green on the golden bakery", async () => {
    const b = loadBakery();
    const { generatePermissionChecks } = await import("../src/index.js");
    const r = await runGates(
      "G1",
      h.ctx({ spec: b.spec, files: b.files, checks: generatePermissionChecks(b.spec) }),
    );
    expect(failing(r), detail(r)).toEqual([]);
  }, 120_000);

  test("M1: AC7 (anonymization after 90 days) passes through advanceTime + runWorkflows", async () => {
    const b = loadBakery();
    const r = await runGates("G1", h.ctx({ spec: b.spec, files: b.files, milestone: "M1" }));
    const s = status(r);
    expect(s["SC-AC7"], detail(r)).toBe("pass");
    expect(failing(r), detail(r)).toEqual([]);
  }, 120_000);

  test("all M0 acceptance scenarios pass; AC7 (M1) skips", async () => {
    const b = loadBakery();
    const r = await runGates("G1", h.ctx({ spec: b.spec, files: b.files }));
    const s = status(r);
    for (const id of ["SC-AC1", "SC-AC2", "SC-AC3", "SC-AC4", "SC-AC5", "SC-AC6"])
      expect(s[id], `${id} ${detail(r)}`).toBe("pass");
    expect(s["SC-AC7"]).toBe("skip");
    expect(s["G1-AC-COVER"]).toBe("pass");
    expect(failing(r), detail(r)).toEqual([]);
    expect(r.passed).toBe(true);
  }, 120_000);
});
