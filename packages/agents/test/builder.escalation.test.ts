// Acceptance M0-13: 5 typecheck failures in a row → needs_input decision=escalation with the builder.yaml buttons,
// no 6th LLM call; repeated threshold after retry → run_failed; gate iterations; loop detector.
import { type AppSpec, applyOps, emptySpec } from "@wizard/appspec";
import { LlmError, type LlmResult } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import { createMemoryHost, ESCALATION_OPTIONS, executeBuild } from "../src/builder/index.js";
import { cardFor, eventProblems, g1Stub, report, stop, tc, turn } from "./builder-helpers.js";
import { scriptedRoute } from "./helpers.js";

/** A tiny valid spec to start from (the build itself is scripted). */
function baseSpec(): AppSpec {
  const r = applyOps(
    emptySpec("Тест"),
    [
      {
        op: "add_role",
        name: "admin",
        label: "Админ",
        access: "login",
        loginMethods: ["email_otp"],
        isAdmin: true,
      },
      {
        op: "add_entity",
        name: "note",
        label: "Заметка",
        fields: [{ name: "title", label: "Заголовок", type: "string" }],
      },
      { op: "set_permission", role: "admin", entity: "note", ops: ["read", "create"] },
    ],
    0,
  );
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}

const plan = turn(
  tc("submit_plan", { steps: [{ id: "P1", kind: "code", title: "Экран", targets: ["ui/"], acRefs: [] }] }),
);
const brokenWrite = (n: number) =>
  turn(
    tc(
      "write_file",
      { path: "ui/Home.tsx", content: `export default function Home() { return ${n} + "x" as number; }\n` },
      `w${n}`,
    ),
    tc("run_gate", { level: "G0" }, `g${n}`),
  );
const tsFail = () =>
  report("G0", false, [
    {
      id: "G0-TS-01",
      status: "fail",
      message_ru: "Ошибка типов в ui/Home.tsx:1 (TS2352)",
      file: "ui/Home.tsx",
      line: 1,
    },
  ]);

function setup(script: (LlmResult | Error)[], answers: string[], g0 = tsFail) {
  const { route, inputs } = scriptedRoute(script);
  const asked: string[] = [];
  const mem = createMemoryHost({
    spec: baseSpec(),
    version: 1,
    route,
    gates: { G0: async () => g0(), G1: g1Stub },
    answer: (req) => {
      asked.push(req.decisionId);
      return { choice: answers.shift() ?? "rollback" };
    },
  });
  return { mem, inputs, asked };
}

describe("escalation", () => {
  test("5 failed typechecks in a row → escalation with 4 buttons, no 6th LLM call", async () => {
    const script = [plan, stop("Спека готова."), ...[1, 2, 3, 4, 5, 6, 7].map(brokenWrite)];
    const { mem, inputs } = setup(script, ["rollback"]);
    const out = await executeBuild(mem, { card: cardFor(baseSpec()), cap: 100, mode: "create" });
    expect(out).toMatchObject({ status: "cancelled", reason: "rollback" });
    const code = inputs.filter((i) => i.callType === "build_code");
    expect(code.length).toBe(5);
    const ask = mem.events.find((e) => e.type === "needs_input")?.payload as {
      decisionId: string;
      prompt_ru: string;
      options: { id: string; freeText?: boolean }[];
    };
    expect(ask.decisionId).toBe("escalation");
    expect(ask.options).toEqual(ESCALATION_OPTIONS);
    expect(ask.options.map((o) => o.id)).toEqual(["retry", "simplify", "rollback", "rephrase"]);
    expect(ask.options.find((o) => o.id === "rephrase")?.freeText).toBe(true);
    expect(ask.prompt_ru.length).toBeLessThanOrEqual(400);
    expect(ask.prompt_ru).toContain("Ошибка типов");
    // Nothing is called after needs_input.
    const i = mem.events.findIndex((e) => e.type === "needs_input");
    expect(mem.events.slice(i + 1).map((e) => e.type)).toEqual(["input_received", "run_finished"]);
    expect(eventProblems(mem.events)).toEqual([]);
  });

  test("retry resets the counter; the second threshold fails the run without a new escalation", async () => {
    const script = [plan, stop(), ...Array.from({ length: 12 }, (_, i) => brokenWrite(i))];
    const { mem, inputs, asked } = setup(script, ["retry"]);
    const out = await executeBuild(mem, { card: cardFor(baseSpec()), cap: 100, mode: "create" });
    expect(out).toMatchObject({ status: "failed", code: "CONSECUTIVE_ERRORS" });
    expect(asked).toEqual(["escalation"]);
    expect(inputs.filter((i) => i.callType === "build_code").length).toBe(10);
    // retry adds a user message for the model
    const after = inputs[7]?.messages.at(-1);
    expect(after).toMatchObject({ role: "user" });
    expect(mem.events.at(-1)).toMatchObject({ type: "run_failed", payload: { code: "CONSECUTIVE_ERRORS" } });
  });

  test("rephrase: the user's text becomes a new user message; freeText is not in the event", async () => {
    const fixed = turn(
      tc("write_file", { path: "ui/Home.tsx", content: "export default () => null;\n" }, "ok"),
    );
    const script = [plan, stop(), ...[1, 2, 3, 4, 5].map(brokenWrite), fixed, stop("Исправлено.")];
    const { route, inputs } = scriptedRoute(script);
    let g0 = 0;
    const mem = createMemoryHost({
      spec: baseSpec(),
      version: 1,
      route,
      gates: { G0: async () => (++g0 <= 5 ? tsFail() : report("G0", true)), G1: g1Stub },
      answer: () => ({ choice: "rephrase", text: "Сделай просто список заметок" }),
    });
    const out = await executeBuild(mem, { card: cardFor(baseSpec()), cap: 100, mode: "create" });
    expect(out.status).toBe("succeeded");
    expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("Сделай просто список заметок");
    const received = mem.events.find((e) => e.type === "input_received");
    expect(received?.payload).toEqual({ inputId: expect.any(String), choice: "rephrase" });
  });

  test("gate iterations: G0 failing after 3 fix rounds escalates; retry then GATES_FAILED", async () => {
    // The model 'fixes' by ending its turn immediately; G0 keeps failing with a decreasing count (no counter hits 5).
    const script: LlmResult[] = [plan, stop(), stop()];
    for (let i = 0; i < 10; i++)
      script.push(
        turn(tc("write_file", { path: "ui/Home.tsx", content: `export default () => ${i};\n` }, `f${i}`)),
        stop(),
      );
    let n = 10;
    const { mem, asked } = setup(script, ["retry"], () =>
      report(
        "G0",
        false,
        Array.from({ length: Math.max(1, n--) }, (_, i) => ({
          id: `G0-TS-01`,
          status: "fail" as const,
          message_ru: `ошибка ${i}`,
        })),
      ),
    );
    const out = await executeBuild(mem, { card: cardFor(baseSpec()), cap: 100, mode: "create" });
    expect(asked).toEqual(["escalation"]);
    expect(out).toMatchObject({ status: "failed", code: "GATES_FAILED" });
    expect(out.status === "failed" && out.reports?.[0]?.level).toBe("G0");
    const fixSteps = mem.events.filter((e) => e.type === "step_started" && e.payload.step === "fix");
    expect(fixSteps.length).toBe(6);
  });

  test("loop detector: 3 identical tool calls in a row count as a failure", async () => {
    const same = turn(tc("list_files", {}, "l"));
    const script = [plan, stop(), ...Array.from({ length: 15 }, () => same)];
    const { mem, inputs } = setup(script, ["rollback"], () => report("G0", true));
    const out = await executeBuild(mem, { card: cardFor(baseSpec()), cap: 100, mode: "create" });
    expect(out).toMatchObject({ status: "cancelled", reason: "rollback" });
    expect(inputs.filter((i) => i.callType === "build_code").length).toBe(15);
  });

  test("max_steps exhausted → escalation", async () => {
    const script = [
      plan,
      stop(),
      ...Array.from({ length: 10 }, (_, i) =>
        turn(tc("read_file", { path: "spec.json" }, `r${i}`), tc("list_files", { prefix: "ui/" }, `l${i}`)),
      ),
    ];
    const { mem, inputs, asked } = setup(script, ["rollback"], () => report("G0", true));
    const out = await executeBuild(mem, {
      card: cardFor(baseSpec()),
      cap: 100,
      mode: "create",
      limits: { maxSteps: 6 },
    });
    expect(asked).toEqual(["escalation"]);
    expect(out.status).toBe("cancelled");
    expect(inputs.length).toBe(6);
  });
});

describe("modes and failures", () => {
  test("fix: plan and ops are skipped; start from the gate report, fix, regate", async () => {
    const script = [
      turn(tc("write_file", { path: "ui/Home.tsx", content: "export default () => null;\n" }, "w")),
      stop("Исправил."),
    ];
    let n = 0;
    const { mem, inputs } = setup(script, [], () => (++n === 1 ? tsFail() : report("G0", true)));
    const out = await executeBuild(mem, { card: cardFor(baseSpec()), cap: 3, mode: "fix" });
    expect(out.status).toBe("succeeded");
    expect(inputs.map((i) => i.callType)).toEqual(["fix", "fix"]);
    expect(JSON.stringify(inputs[0]?.messages.at(-1))).toContain("Отчёт проверок G0: упало 1");
    const steps = mem.events.filter((e) => e.type === "step_started").map((e) => e.payload.step);
    expect(steps).toEqual(["verify", "fix", "verify", "verify"]);
    expect(eventProblems(mem.events)).toEqual([]);
  });

  test("LlmError → run_failed LLM_UNAVAILABLE (retryable); router budget error → BUDGET_STOPPED", async () => {
    for (const [err, code] of [
      [new LlmError("FIXTURE_MISS", "нет"), "LLM_UNAVAILABLE"],
      [new LlmError("BUDGET_EXCEEDED", "нет"), "BUDGET_STOPPED"],
    ] as const) {
      const { mem } = setup([err], []);
      const out = await executeBuild(mem, { card: cardFor(baseSpec()), cap: 100, mode: "create" });
      expect(out).toMatchObject({ status: "failed", code });
      expect(mem.events.at(-1)?.type).toBe("run_failed");
    }
  });

  test("aborted signal → cancelled before the next LLM call", async () => {
    const ac = new AbortController();
    const { route, inputs } = scriptedRoute([plan, stop()]);
    const mem = createMemoryHost({
      spec: baseSpec(),
      version: 1,
      route: async (i) => {
        const out = await route(i);
        ac.abort();
        return out;
      },
      signal: ac.signal,
      gates: { G0: async () => report("G0", true), G1: g1Stub },
    });
    const out = await executeBuild(mem, { card: cardFor(baseSpec()), cap: 100, mode: "create" });
    expect(out).toMatchObject({ status: "cancelled", reason: "aborted" });
    expect(inputs.length).toBe(1);
  });
});
