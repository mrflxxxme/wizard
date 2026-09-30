// Table test of orchestrator.yaml#state_machine: every (state × event) against the spec's transition list.
import { describe, expect, test } from "vitest";
import { AgentError } from "../src/core/index.js";
import {
  ORCH_EVENT_TYPES,
  ORCH_STATES,
  type OrchEvent,
  type OrchEventType,
  OrchestratorMachine,
  type OrchState,
  transition,
} from "../src/orchestrator/index.js";
import { loadYaml } from "./helpers.js";

interface SpecTransition {
  from: string;
  event: string;
  to: string;
  guard?: string;
}
const spec = (loadYaml("specs/agents/orchestrator.yaml") as { state_machine: Record<string, unknown> })
  .state_machine as {
  states: string[];
  initial: string;
  transitions: SpecTransition[];
};

/** Payload variants per event type; each variant says which spec guard it satisfies. */
const VARIANTS: Record<
  OrchEventType,
  { event: OrchEvent; satisfies: (guard: string | undefined) => boolean }[]
> = {
  BRIEF_SUBMITTED: [{ event: { type: "BRIEF_SUBMITTED" }, satisfies: () => true }],
  ANALYSIS_DONE: [
    { event: { type: "ANALYSIS_DONE", forks: 3 }, satisfies: (g) => g === "forks > 0" },
    { event: { type: "ANALYSIS_DONE", forks: 0 }, satisfies: (g) => g === "forks = 0" },
  ],
  ANSWER: [
    { event: { type: "ANSWER", remaining: 2 }, satisfies: (g) => g === "остались неотвеченные" },
    { event: { type: "ANSWER", remaining: 0 }, satisfies: (g) => g === "все отвечены" },
  ],
  REST_BY_RECOMMENDATION: [{ event: { type: "REST_BY_RECOMMENDATION" }, satisfies: () => true }],
  CARD_READY: [{ event: { type: "CARD_READY" }, satisfies: () => true }],
  CARD_EDIT: [
    { event: { type: "CARD_EDIT", cardVersion: 4 }, satisfies: (g) => g === "cardVersion < 5" },
    { event: { type: "CARD_EDIT", cardVersion: 5 }, satisfies: () => false },
  ],
  APPROVE: [
    { event: { type: "APPROVE" }, satisfies: () => true },
    { event: { type: "APPROVE", balanceOk: true }, satisfies: () => true },
    { event: { type: "APPROVE", balanceOk: false }, satisfies: () => false },
  ],
  BUILD_STARTED: [{ event: { type: "BUILD_STARTED" }, satisfies: () => true }],
  BUILDER_NEEDS_USER: [{ event: { type: "BUILDER_NEEDS_USER" }, satisfies: () => true }],
  USER_CHOICE: [{ event: { type: "USER_CHOICE" }, satisfies: () => true }],
  BUILD_DONE: [{ event: { type: "BUILD_DONE" }, satisfies: () => true }],
  CHANGE_REQUESTED: [{ event: { type: "CHANGE_REQUESTED" }, satisfies: () => true }],
  CANCEL: [{ event: { type: "CANCEL" }, satisfies: () => true }],
  LLM_FAILED: [{ event: { type: "LLM_FAILED" }, satisfies: () => true }],
};

function expected(state: string, v: (typeof VARIANTS)[OrchEventType][number]): string | null {
  for (const t of spec.transitions) {
    const froms = t.from === "*" ? spec.states : t.from.split("|");
    if (froms.includes(state) && t.event === v.event.type && v.satisfies(t.guard)) return t.to;
  }
  return null;
}

describe("state_machine", () => {
  test("states and events mirror the spec", () => {
    expect([...ORCH_STATES]).toEqual(spec.states);
    expect(spec.initial).toBe("idle");
    expect(new Set(ORCH_EVENT_TYPES)).toEqual(new Set(spec.transitions.map((t) => t.event)));
  });

  const rows = ORCH_STATES.flatMap((state) =>
    ORCH_EVENT_TYPES.flatMap((type) => VARIANTS[type].map((v) => ({ state, v, to: expected(state, v) }))),
  );

  test.each(rows.map((r) => [r.state, JSON.stringify(r.v.event), r.to, r] as const))(
    "%s + %s → %s",
    (_s, _e, _to, row) => {
      if (row.to === null) {
        let err: unknown;
        try {
          transition(row.state, row.v.event);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(AgentError);
        expect((err as AgentError).code).toBe("INVALID_TRANSITION");
      } else {
        expect(transition(row.state, row.v.event)).toBe(row.to);
      }
    },
  );

  test("invalid event has no side effects on the machine", () => {
    const m = new OrchestratorMachine("asking");
    expect(() => m.send({ type: "APPROVE" })).toThrow(AgentError);
    expect(m.state).toBe<OrchState>("asking");
  });

  test("repeating an event with the same idempotencyKey does not change the state", () => {
    const m = new OrchestratorMachine();
    m.send({ type: "BRIEF_SUBMITTED" }, "k1");
    m.send({ type: "ANALYSIS_DONE", forks: 2 }, "k2");
    expect(m.send({ type: "ANSWER", remaining: 1 }, "k3")).toBe("asking");
    expect(m.send({ type: "ANSWER", remaining: 0 }, "k3")).toBe("asking");
    expect(m.send({ type: "BRIEF_SUBMITTED" }, "k1")).toBe("asking");
    expect(m.seenKeys).toEqual(["k1", "k2", "k3"]);
  });
});
