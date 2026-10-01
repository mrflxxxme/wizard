// backlog M1-09: scenario DSL steps runWorkflows/advanceTime against the runtime job runner (runtime.yaml#workflows):
// on_status notify lands in the outbox, runner failures become step evidence, a runtime without a runner is an error.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type GateReport,
  type QaCheck,
  type RuntimeHandle,
  runGates,
  validateScenario,
} from "../src/index.js";
import { type G1Harness, g1Harness } from "./g1-helpers.js";
import { loadForum } from "./helpers.js";

let h: G1Harness;
beforeAll(async () => {
  h = await g1Harness();
});
afterAll(async () => {
  expect(await h.leftoverSchemas()).toBe(0);
  await h.close();
});

const byId = (r: GateReport, id: string) => r.checks.find((c) => c.id === id);
const detail = (r: GateReport) =>
  JSON.stringify(
    r.checks.filter((c) => c.status === "fail" || c.status === "error"),
    null,
    1,
  ).slice(0, 3000);

/** Speaker applies, the organizer approves: speaker_approved sends email + telegram to the speaker. */
const approval: QaCheck = {
  id: "SC-AC3-2",
  acId: "AC3",
  kind: "scenario",
  level: "G1",
  scenario: {
    id: "SC-AC3-2",
    acId: "AC3",
    title: "Одобренный спикер получает уведомления",
    actors: { sp: { role: "speaker" }, org: { role: "organizer" } },
    steps: [
      { as: "sp" },
      {
        create: {
          entity: "speaker_application",
          data: { full_name: "Спикер Один", email: "user1@example.test", topic: "Тема", abstract: "Кейс" },
          save: "a",
        },
        consent: true,
      },
      { runWorkflows: {} },
      { expect: { outbox: { connector: "email", count: 0 } } },
      { as: "org" },
      { update: { entity: "speaker_application", id: "$a.id", data: { status: "approved" } } },
      { runWorkflows: {} },
      { expect: { status: "ok", outbox: { connector: "email", to: "sp", count: 1 } } },
      { advanceTime: { minutes: 60 } },
      { expect: { outbox: { connector: "telegram", to: "sp", count: 1 } } },
    ],
  },
};

describe("runWorkflows / advanceTime", () => {
  test("on_status notify reaches the outbox once, for the right user", async () => {
    const r = await runGates("G1", h.ctx({ checks: [approval] }));
    expect(byId(r, "SC-AC3-2")?.status, detail(r)).toBe("pass");
  }, 120_000);

  test("a failing workflow job fails the step with the workflow and step in the evidence", async () => {
    const runtime: RuntimeHandle = {
      ...h.rt,
      runJobs: async () => ({
        ran: 0,
        failed: [
          { kind: "workflow_step", name: "speaker_approved", step: 1, stepType: "notify", code: "INTERNAL" },
        ],
      }),
    };
    const r = await runGates("G1", h.ctx({ checks: [approval], runtime }));
    const c = byId(r, "SC-AC3-2");
    expect(c?.status).toBe("fail");
    expect(c?.evidence).toBe(
      "шаг 8: ожидалось status=ok, получено HTTP 500 INTERNAL (воркфлоу speaker_approved, шаг 2 notify)",
    );
  }, 120_000);

  test("a runtime without a job runner reports the scenario as an error", async () => {
    const { runJobs: _drop, ...rest } = h.rt;
    const r = await runGates("G1", h.ctx({ checks: [approval], runtime: rest }));
    expect(byId(r, "SC-AC3-2")?.status).toBe("error");
  }, 120_000);

  test("static validation of the time steps", () => {
    const spec = loadForum();
    const sc = (steps: unknown[]) =>
      validateScenario(spec, { id: "SC-AC1", acId: "AC1", title: "t", actors: {}, steps } as never).join(
        "; ",
      );
    expect(sc([{ advanceTime: { minutes: 0 } }])).toContain("advanceTime.minutes");
    expect(sc([{ advanceTime: { minutes: 1.5 } }])).toContain("advanceTime.minutes");
    expect(sc([{ runWorkflows: { all: true } }])).toContain("runWorkflows");
    expect(sc([{ advanceTime: { minutes: 1440 } }, { runWorkflows: {} }])).toBe("");
  });
});
