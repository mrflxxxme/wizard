// M1-09 (agents/qa.yaml): time constraints validate by the state after advanceTime, the digest shows retention and
// workflow triggers, and failures of workflows / time / connector mocks get deterministic explanations.
import { readFileSync } from "node:fs";
import type { AppSpec } from "@wizard/appspec";
import type { Check, QaCheck, Scenario, Step } from "@wizard/gates";
import { describe, expect, test } from "vitest";
import { type CardAc, classify, type ExplainCtx, qaDigest, qaValidateScenario } from "../src/qa/index.js";
import { REPO } from "./builder-helpers.js";

const spec = JSON.parse(readFileSync(`${REPO}specs/appspec/examples/forum.json`, "utf8")) as AppSpec;
const ac6 = spec.acceptance?.find((a) => a.id === "AC6") as unknown as CardAc & {
  check: { actors: Scenario["actors"]; steps: Step[] };
};
const sc6: Scenario = {
  id: "SC-AC6",
  acId: "AC6",
  title: ac6.text,
  actors: ac6.check.actors,
  steps: ac6.check.steps,
};
const wfIndex = (name: string) => (spec.workflows ?? []).findIndex((w) => w.name === name);
const entityIndex = (name: string) => spec.entities.findIndex((e) => e.name === name);

function explain(sc: Scenario, evidence: string) {
  const q: QaCheck = { id: sc.id, acId: sc.acId, kind: "scenario", level: "G1", scenario: sc };
  const x: ExplainCtx = { spec, acs: [], checks: new Map([[q.id, q]]), invalid: new Map() };
  const c: Check = {
    id: sc.id,
    acId: sc.acId,
    status: "fail",
    severity: "blocker",
    message_ru: "не прошёл",
    evidence,
  };
  const e = classify(c, x);
  return e && [e.category, e.fix.kind, e.fix.target, e.owner];
}

describe("generation", () => {
  test("a time constraint is valid with the check after advanceTime; without the time step it needs an error", () => {
    expect(qaValidateScenario(spec, sc6, ac6)).toEqual([]);
    const untimed = { ...sc6, steps: sc6.steps.filter((s) => s.advanceTime === undefined) };
    expect(qaValidateScenario(spec, untimed, ac6).join()).toContain("негативная ветка");
  });

  test("the digest carries retention and workflow triggers with their steps", () => {
    const d = qaDigest(spec);
    expect(d).toContain("- ticket: 30 дн. от event_starts_at, anonymize");
    expect(d).toContain(
      '- ticket_paid_email: on_status ticket.status="paid" → notify(email → $record.holder_user)',
    );
    expect(d).toContain(
      '- ticket_reminder: schedule ticket.event_starts_at-1440м → function(sendReminder) if {"status":["paid","issued"]}',
    );
  });
});

describe("explanations of workflow, time and connector failures", () => {
  const approval: Scenario = {
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
      { as: "org" },
      { update: { entity: "speaker_application", id: "$a.id", data: { status: "approved" } } },
      { runWorkflows: {} },
      { expect: { outbox: { connector: "email", to: "sp", count: 1 } } },
    ],
  };

  test("no outbox message → workflow_not_triggered on the workflow of the written entity", () => {
    expect(explain(approval, "шаг 6: ожидалось сообщений email: 1, получено 0")).toEqual([
      "workflow_not_triggered",
      "ops",
      `/workflows/${wfIndex("speaker_approved")}`,
      "builder",
    ]);
  });

  test("runner failures: a function step → function_error on its file, another step → the workflow step", () => {
    const fnEvidence =
      "шаг 5: ожидалось ok/created, получено HTTP 500 INTERNAL (воркфлоу ticket_reminder, шаг 1 function)";
    expect(explain(approval, fnEvidence)).toEqual([
      "function_error",
      "code",
      "functions/sendReminder.ts",
      "builder",
    ]);
    const notify =
      "шаг 5: ожидалось ok/created, получено HTTP 500 INTERNAL (воркфлоу speaker_approved, шаг 2 notify)";
    expect(explain(approval, notify)).toEqual([
      "workflow_not_triggered",
      "ops",
      `/workflows/${wfIndex("speaker_approved")}/steps/1`,
      "builder",
    ]);
  });

  test("pii still present after advanceTime → retention of the entity", () => {
    const n = sc6.steps.length;
    expect(explain(sc6, `шаг ${n}: ожидалось holder_name=«скрыто», получено holder_name=«скрыто»`)).toEqual([
      "workflow_not_triggered",
      "ops",
      `/entities/${entityIndex("ticket")}/retention`,
      "builder",
    ]);
  });

  test("a simulated connector event answered with an error → connector_mock_mismatch", () => {
    const sc: Scenario = {
      id: "SC-AC4-2",
      acId: "AC4",
      title: "Проход по QR",
      actors: { v: { role: "volunteer" } },
      steps: [{ as: "v" }, { simulate: { connector: "qr", event: "checkin", data: { ticket: "x" } } }],
    };
    const qr = (spec.integrations ?? []).findIndex((i) => i.connector === "qr");
    expect(explain(sc, "шаг 2: ожидалось ok/created, получено HTTP 404 NOT_FOUND")).toEqual([
      "connector_mock_mismatch",
      "ops",
      `/integrations/${qr}`,
      "builder",
    ]);
  });
});
