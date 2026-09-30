// reduceRun on the recorded feeds «форум» and «кондитерская» (platform-screens.yaml#sse.client_rules, S4 acceptance).
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RunEvent } from "../src/api/types.js";
import { initialRunState, type RunState, reduceRun } from "../src/run/reducer.js";
import { loadFeed } from "./mock/server.js";

const stream = (name: "forum" | "bakery"): RunEvent[] =>
  loadFeed(name).build.map((e, i) => ({
    runId: "r1",
    seq: i + 1,
    type: e.type,
    ts: "2026-09-30T10:00:00.000Z",
    payload: e.payload,
  }));

const run = (events: RunEvent[], from: RunState = initialRunState()) => events.reduce(reduceRun, from);

const ev = (seq: number, type: string, payload: Record<string, unknown> = {}): RunEvent => ({
  runId: "r1",
  seq,
  type,
  ts: "2026-09-30T10:00:00.000Z",
  payload,
});

afterEach(() => vi.restoreAllMocks());

describe.each(["forum", "bakery"] as const)("recorded stream «%s»", (name) => {
  test("final state snapshot", () => {
    expect(run(stream(name))).toMatchSnapshot();
  });

  test("replay after reconnect (duplicates, overlap) gives the same state", () => {
    const events = stream(name);
    const half = Math.floor(events.length / 2);
    const replayed = run([
      ...events.slice(0, half),
      ...events.slice(half - 5, half),
      ...events.slice(0, 3),
      ...events.slice(half),
    ]);
    expect(replayed).toEqual(run(events));
  });

  test("steps are the plan, all done; G0–G2 passed; preview reload trigger set", () => {
    const s = run(stream(name));
    const plan = loadFeed(name).build.find((e) => e.type === "plan_ready")?.payload.steps as unknown[];
    expect(s.steps).toHaveLength(plan.length);
    expect(s.steps.every((x) => x.status === "done")).toBe(true);
    expect(Object.values(s.gates).map((g) => g.status)).toEqual(["passed", "passed", "passed"]);
    expect(s.g0PassedRevision).not.toBeNull();
    expect(s.phase).toBe("finished");
  });
});

describe("single events", () => {
  test("builder phases (ops/code) mark the plan items of that kind; other phases get their own row", () => {
    const s = run([
      ev(1, "run_started", { kind: "build" }),
      ev(2, "step_started", { step: "plan", label_ru: "Составляю план" }),
      ev(3, "plan_ready", {
        steps: [
          { id: "P1", kind: "ops", title: "Данные" },
          { id: "P2", kind: "code", title: "Экраны" },
        ],
      }),
      ev(4, "step_finished", { step: "plan" }),
      ev(5, "step_started", { step: "ops", label_ru: "Собираю модель данных" }),
    ]);
    expect(s.steps.map((x) => [x.id, x.title, x.status])).toEqual([
      ["P1", "Данные", "running"],
      ["P2", "Экраны", "queued"],
      ["plan", "Составляю план", "done"],
    ]);
    const s2 = run(
      [
        ev(6, "step_finished", { step: "ops" }),
        ev(7, "step_started", { step: "code", label_ru: "Пишу код" }),
        ev(8, "step_finished", { step: "code" }),
      ],
      s,
    );
    expect(s2.steps.filter((x) => x.inPlan).map((x) => x.status)).toEqual(["done", "done"]);
  });

  test("unknown type → ignored with console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s0 = run([ev(1, "run_started", { kind: "build" })]);
    const s1 = reduceRun(s0, ev(2, "model_switched", { fromModel: "a", toModel: "b" }));
    expect(warn).toHaveBeenCalledOnce();
    expect({ ...s1, lastSeq: 1 }).toEqual(s0);
  });

  test("agent_message delta is appended by messageId", () => {
    const s = run([
      ev(1, "agent_message", { agent: "builder", messageId: "m", text: "Пишу " }),
      ev(2, "agent_message", { agent: "builder", messageId: "m", text: "экраны", delta: true }),
    ]);
    expect(s.messages).toEqual([{ id: "m", agent: "builder", text: "Пишу экраны" }]);
  });

  test("needs_input → input_received with the same inputId closes the card and the budget alert", () => {
    const s = run([
      ev(1, "budget_exceeded", { used: 6, cap: 6 }),
      ev(2, "needs_input", {
        inputId: "i1",
        kind: "decision",
        decisionId: "budget",
        prompt_ru: "?",
        options: [{ id: "a", label: "A", recommended: true }],
      }),
    ]);
    expect(s.input?.options[0]).toEqual({ id: "a", label: "A", recommended: true });
    expect(reduceRun(s, ev(3, "input_received", { inputId: "other" })).input).not.toBeNull();
    const done = reduceRun(s, ev(3, "input_received", { inputId: "i1", choice: "a" }));
    expect(done.input).toBeNull();
    expect(done.budgetExceeded).toBeNull();
  });

  test("gate_result failed keeps ≤ 20 failed checks with messages cut to 300", () => {
    const failedChecks = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, message_ru: "x".repeat(400) }));
    const s = run([ev(1, "gate_result", { level: "G1", passed: false, failedChecks, totalChecks: 30 })]);
    expect(s.gates.G1.status).toBe("failed");
    expect(s.gates.G1.failedChecks).toHaveLength(20);
    expect(s.gates.G1.failedChecks[0]?.message_ru).toHaveLength(300);
    expect(s.g0PassedRevision).toBeNull();
  });

  test("run_failed and step_finished.ruFallback", () => {
    const s = run([
      ev(1, "step_started", { step: "x", label_ru: "Шаг", attempt: 2 }),
      ev(2, "step_finished", { step: "x", ruFallback: true }),
      ev(3, "run_failed", {
        code: "GATES_FAILED",
        message_ru: "Не прошло",
        retryable: false,
        lastGoodRevision: 2,
      }),
    ]);
    expect(s.steps[0]).toMatchObject({ title: "Шаг", attempt: 2, status: "done" });
    expect(s.ruFallback).toBe(true);
    expect(s.failure).toEqual({
      code: "GATES_FAILED",
      message_ru: "Не прошло",
      retryable: false,
      lastGoodRevision: 2,
    });
  });
});
