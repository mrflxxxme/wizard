// @wizard/agents/core: zod → JSON Schema tools, structured call with repairs, general tool loop.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { callTool, defineTool, runToolLoop, ToolFailure } from "../src/core/index.js";
import { CTX, OPEN_POLICY, scriptedRoute, toolResult } from "./helpers.js";

const echo = defineTool({
  name: "echo",
  description: "Echo a value.",
  input: z.object({ value: z.string().max(5), n: z.number().int().default(1) }),
  check: (v) => (v.value === "bad" ? [{ path: "value", message: "Плохое значение" }] : []),
  run: (v) => ({ echoed: v.value.repeat(v.n) }),
});

const base = (route: ReturnType<typeof scriptedRoute>["route"]) => ({
  route,
  callType: "build_code" as const,
  orgPolicy: OPEN_POLICY,
  ctx: CTX,
});

describe("tool definitions from zod", () => {
  test("JSON Schema is generated from the same zod schema", () => {
    expect(echo.definition.name).toBe("echo");
    const p = echo.definition.parameters as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(p.type).toBe("object");
    expect(Object.keys(p.properties)).toEqual(["value", "n"]);
    expect(p.required).toEqual(["value"]); // default → optional for the model
    expect(p).not.toHaveProperty("$schema");
    expect(echo.parse({ value: "abc" })).toEqual({ ok: true, value: { value: "abc", n: 1 } });
    const bad = echo.parse({ value: "toolong" });
    expect(bad.ok).toBe(false);
  });

  test("tool names must be snake_case latin", () => {
    expect(() => defineTool({ name: "Bad-Name", description: "", input: z.object({}) })).toThrow();
  });
});

describe("callTool", () => {
  test("invalid args are returned to the model structurally, then repaired", async () => {
    const { route, inputs } = scriptedRoute([
      toolResult("echo", { value: "bad" }),
      toolResult("echo", { value: "ok" }),
    ]);
    const events: string[] = [];
    const r = await callTool({
      ...base(route),
      messages: [{ role: "user", content: "go" }],
      tool: echo,
      onEvent: (e) => events.push(e.type),
    });
    expect(r.ok).toBe(true);
    expect(r.stats.calls).toBe(2);
    expect(inputs[0]?.toolChoice).toBe("required");
    expect(inputs[0]?.tools?.[0]?.name).toBe("echo");
    const toolMsg = inputs[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({
      content: {
        ok: false,
        error: { code: "INVALID_ARGS", issues: [{ path: "value", message: "Плохое значение" }] },
      },
    });
    expect(events).toEqual(["llm_call", "repair", "llm_call"]);
  });

  test("≤ 2 repairs, then ok=false with issues; a text answer is also a failure", async () => {
    const { route, inputs } = scriptedRoute([
      { text: "привет", toolCalls: [], finishReason: "stop" },
      toolResult("echo", { value: 1 }),
      toolResult("echo", { value: "bad" }),
      toolResult("echo", { value: "ok" }),
    ]);
    const r = await callTool({ ...base(route), messages: [{ role: "user", content: "go" }], tool: echo });
    expect(r.ok).toBe(false);
    expect(inputs).toHaveLength(3);
    expect(inputs[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: "Ответь только вызовом инструмента echo.",
    });
    if (!r.ok) expect(r.issues[0]?.message).toBe("Плохое значение");
  });
});

describe("runToolLoop", () => {
  const fail = defineTool({
    name: "fail",
    description: "Always fails.",
    input: z.object({}),
    run: () => {
      throw new ToolFailure(
        "OPS_ERROR",
        "Ошибка операции",
        [{ path: "ops.0", message: "нет сущности" }],
        [{ code: "X" }],
      );
    },
  });

  test("executes tools, returns errors structurally and stops when the model answers with text", async () => {
    const calls = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, name: "echo", args: { value: "a" } }));
    const { route, inputs } = scriptedRoute([
      {
        toolCalls: [
          ...calls.slice(0, 1),
          { id: "u", name: "nope", args: {} },
          { id: "f", name: "fail", args: {} },
        ],
        finishReason: "tool-calls",
      },
      { toolCalls: calls, finishReason: "tool-calls" },
      { text: "готово", toolCalls: [], finishReason: "stop" },
    ]);
    const r = await runToolLoop({
      ...base(route),
      messages: [{ role: "user", content: "go" }],
      tools: [echo, fail],
      maxTurns: 5,
    });
    expect(r.reason).toBe("stop");
    expect(r.text).toBe("готово");
    expect(r.stats.calls).toBe(3);
    expect(inputs[0]?.toolChoice).toBe("auto");
    const codes = r.results.map((x) => (x.ok ? "ok" : (x.content as { error: { code: string } }).error.code));
    expect(codes).toEqual(["ok", "UNKNOWN_TOOL", "OPS_ERROR", ...Array(8).fill("ok"), "TOO_MANY_TOOL_CALLS"]);
    expect(r.results[0]?.content).toEqual({ echoed: "a" });
    expect(r.results[2]?.content).toMatchObject({ data: [{ code: "X" }] });
  });

  test("stopOn tool and maxTurns", async () => {
    const { route } = scriptedRoute([toolResult("echo", { value: "a" })]);
    const r = await runToolLoop({
      ...base(route),
      messages: [],
      tools: [echo],
      maxTurns: 3,
      stopOn: ["echo"],
    });
    expect(r.reason).toBe("tool");
    const s2 = scriptedRoute([toolResult("fail", {}), toolResult("fail", {})]);
    const r2 = await runToolLoop({ ...base(s2.route), messages: [], tools: [fail], maxTurns: 2 });
    expect(r2.reason).toBe("max_turns");
  });

  test("each LLM call goes through runStep", async () => {
    const { route } = scriptedRoute([
      toolResult("echo", { value: "a" }),
      { toolCalls: [], finishReason: "stop" },
    ]);
    const steps: string[] = [];
    await runToolLoop({
      ...base(route),
      messages: [],
      tools: [echo],
      maxTurns: 3,
      stepName: "code",
      runStep: (name, fn) => {
        steps.push(name);
        return fn();
      },
    });
    expect(steps).toEqual(["code#1", "code#2"]);
  });
});

test("package exports @wizard/agents/core and @wizard/agents/orchestrator", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    exports: Record<string, string>;
  };
  expect(pkg.exports["./core"]).toBe("./src/core/index.ts");
  expect(pkg.exports["./orchestrator"]).toBe("./src/orchestrator/index.ts");
});
