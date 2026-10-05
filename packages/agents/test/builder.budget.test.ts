// Acceptance M0-13: cap=1 → budget_exceeded before the cap is exceeded, no LLM call until the answer
// (builder.yaml#budgets.test, workflows.yaml#run_lifecycle.budget.test).
import { createRouter, MemoryUsageSink } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import { createMemoryHost, executeBuild, raiseStep, upperBoundCredits } from "../src/builder/index.js";
import { eventProblems, g1Stub, golden, report, startSpec } from "./builder-helpers.js";

const g = await golden("forum");

function forumHost(answer: (decisionId: string) => string) {
  const sink = new MemoryUsageSink();
  const router = createRouter({ mode: "fixture", fixture: { suite: "demo", name: "forum" }, sink, env: {} });
  const mem = createMemoryHost({
    spec: startSpec(g.spec),
    route: router,
    // G0 is not the point here: a passing stub keeps the test fast and DB-free.
    gates: { G0: async () => report("G0", true), G1: g1Stub },
    answer: (req) => ({ choice: answer(req.decisionId) === "raise" ? String(req.options[0]?.id) : "stop" }),
  });
  return { mem, sink };
}

describe("budget", () => {
  test("cap=1: budget_exceeded before exceeding, stop → cancelled, no LLM call after it", async () => {
    const { mem, sink } = forumHost(() => "stop");
    const out = await executeBuild(mem, { card: g.card, cap: 1, mode: "create" });
    expect(out).toMatchObject({ status: "cancelled", reason: "budget_stop" });
    const i = mem.events.findIndex((e) => e.type === "budget_exceeded");
    expect(i).toBeGreaterThanOrEqual(0);
    const exceeded = mem.events[i]?.payload as { used: number; cap: number; nextStep: string };
    expect(exceeded.cap).toBe(1);
    expect(exceeded.used).toBeLessThanOrEqual(1);
    const after = mem.events.slice(i + 1).map((e) => e.type);
    expect(after).toEqual(["needs_input", "input_received", "build_metrics", "run_finished"]);
    const ask = mem.events[i + 1]?.payload as { decisionId: string; options: { id: string }[] };
    expect(ask.decisionId).toBe("budget");
    expect(ask.options.map((o) => o.id)).toEqual([`raise_cap_${raiseStep(1)}`, "stop"]);
    // Ledger ≤ cap: every usage record happened before budget_exceeded.
    const spent = sink.records.reduce((s, r) => s + r.creditsMilli, 0) / 1000;
    expect(spent).toBeLessThanOrEqual(1);
    expect(sink.records.length).toBe(mem.calls.length);
    expect(eventProblems(mem.events)).toEqual([]);
  });

  test("raise_cap_N raises the cap and the build goes on", async () => {
    const { mem } = forumHost(() => "raise");
    const out = await executeBuild(mem, { card: g.card, cap: 1, mode: "create" });
    expect(out.status).toBe("succeeded");
    expect(mem.events.filter((e) => e.type === "budget_exceeded").length).toBeGreaterThan(0);
    const last = mem.events.filter((e) => e.type === "budget_update").at(-1)?.payload as {
      used: number;
      cap: number;
    };
    expect(last.used).toBeLessThanOrEqual(last.cap);
    expect(last.cap).toBeGreaterThan(1);
  });

  test("upper bound: input estimate × input price + max_tokens × output price of the priciest chain model", () => {
    const small = upperBoundCredits("build_code", [{ role: "user", content: "x" }]);
    const big = upperBoundCredits("build_code", [{ role: "user", content: "x".repeat(320_000) }]);
    // 16000 output tokens × 829.6 ₽/1M (glm-5.1) ≈ 13.27 ₽ ≈ 2.655 credits at 5 ₽/credit.
    expect(small).toBeCloseTo(2.655, 2);
    expect(big - small).toBeCloseTo((100_000 * 198.86) / 1e6 / 5, 1);
  });

  test("host-managed budget: the builder passes upperBoundCredits and emits no budget events itself", async () => {
    const sink = new MemoryUsageSink();
    const router = createRouter({
      mode: "fixture",
      fixture: { suite: "demo", name: "forum" },
      sink,
      env: {},
    });
    const mem = createMemoryHost({
      spec: startSpec(g.spec),
      route: router,
      managesBudget: true,
      gates: { G0: async () => report("G0", true), G1: g1Stub },
    });
    const out = await executeBuild(mem, { card: g.card, cap: 1, mode: "create" });
    expect(out.status).toBe("succeeded");
    expect(mem.events.some((e) => e.type.startsWith("budget_"))).toBe(false);
    expect(mem.calls.every((c) => (c.upperBoundCredits ?? 0) > 0)).toBe(true);
  });
});
