// Tool loop over @wizard/llm route(): structured output via one required tool (with ≤2 repairs) and a general
// multi-tool loop for agents (models.yaml#call_policy: structured_output, parallel_tool_calls, tool_parse_repair).
import type {
  CallType,
  LlmMessage,
  OrgPolicy,
  RouteContext,
  RouteInput,
  RouteOutput,
  ToolCall,
} from "@wizard/llm";
import type { z } from "zod";
import { type AgentEventSink, identityStep, type RunStepFn } from "./events.js";
import { looseObject } from "./loose-json.js";
import { type Tool, ToolFailure, type ToolIssue, toolError } from "./tool.js";

export type RouteFn = (input: RouteInput) => Promise<RouteOutput>;

export interface CallBase {
  route: RouteFn;
  callType: CallType;
  orgPolicy: OrgPolicy | null;
  ctx: RouteContext;
  containsPiiHint?: boolean;
  signal?: AbortSignal;
  onEvent?: AgentEventSink;
  runStep?: RunStepFn;
  /** Step name prefix for runStep (default: callType). */
  stepName?: string;
}

export const MAX_PARALLEL_TOOL_CALLS = 8;
export const DEFAULT_MAX_REPAIRS = 2;

export interface CallStats {
  calls: number;
  creditsCharged: number;
  ruFallback: boolean;
}

const emptyStats = (): CallStats => ({ calls: 0, creditsCharged: 0, ruFallback: false });

function addStats(s: CallStats, out: RouteOutput): void {
  s.calls += 1;
  s.creditsCharged = Math.round((s.creditsCharged + out.creditsCharged) * 1000) / 1000;
  s.ruFallback ||= out.ruFallback;
}

async function callRoute(
  base: CallBase,
  messages: LlmMessage[],
  tools: Tool[],
  toolChoice: "auto" | "required",
  n: number,
): Promise<RouteOutput> {
  const runStep = base.runStep ?? identityStep;
  const input: RouteInput = {
    callType: base.callType,
    messages: [...messages],
    tools: tools.map((t) => t.definition),
    toolChoice,
    orgPolicy: base.orgPolicy,
    ctx: base.ctx,
    ...(base.containsPiiHint !== undefined ? { containsPiiHint: base.containsPiiHint } : {}),
    ...(base.signal ? { signal: base.signal } : {}),
  };
  const out = await runStep(`${base.stepName ?? base.callType}#${n}`, () => base.route(input));
  base.onEvent?.({
    type: "llm_call",
    callType: base.callType,
    n,
    toolCalls: out.result.toolCalls.length,
    creditsCharged: out.creditsCharged,
    ruFallback: out.ruFallback,
  });
  return out;
}

function assistantMessage(out: RouteOutput): LlmMessage {
  return {
    role: "assistant",
    content: out.result.text ?? "",
    ...(out.result.toolCalls.length > 0 ? { toolCalls: out.result.toolCalls } : {}),
  };
}

export type StructuredResult<T> =
  | { ok: true; value: T; messages: LlmMessage[]; stats: CallStats }
  | { ok: false; issues: ToolIssue[]; messages: LlmMessage[]; stats: CallStats };

/**
 * One structured answer: the model must call `tool`; invalid arguments are returned to it as a tool result
 * (zod issues + semantic check) and the call is repeated at most `maxRepairs` times.
 */
export async function callTool<S extends z.ZodType>(
  opts: CallBase & {
    messages: LlmMessage[];
    tool: Tool<S>;
    maxRepairs?: number;
    /**
     * Tools the model may call next to `tool` in the same answer (e.g. report_capability_gap); they run like in
     * runToolLoop, their results go back to the model, and they never replace the required `tool` call.
     */
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool list
    sideTools?: Tool<any, any>[];
    /**
     * B2-41: when the model answers with the arguments as JSON text instead of calling `tool`, they are taken as the
     * call if they pass the tool's checks (no extra model call); otherwise the answer is NO_TOOL_CALL as usual.
     */
    textArgs?: boolean;
  },
): Promise<StructuredResult<z.output<S>>> {
  const messages = [...opts.messages];
  const stats = emptyStats();
  const maxRepairs = opts.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  const side = opts.sideTools ?? [];
  const sideByName = new Map(side.map((t) => [t.name, t]));
  const offered = [opts.tool, ...side];
  let issues: ToolIssue[] = [];
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const out = await callRoute(opts, messages, offered, "required", attempt + 1);
    addStats(stats, out);
    messages.push(assistantMessage(out));
    const calls = out.result.toolCalls;
    const mine = calls.find((c) => c.name === opts.tool.name);
    let value: z.output<S> | undefined;
    const textual = !mine && opts.textArgs && out.result.text ? looseObject(out.result.text) : undefined;
    if (textual) {
      const parsed = opts.tool.parse(textual);
      if (parsed.ok) value = parsed.value;
    }
    if (!mine && value === undefined) {
      issues = [
        {
          path: "",
          code: "NO_TOOL_CALL",
          message: `Ответ должен быть вызовом инструмента ${opts.tool.name}.`,
        },
      ];
    } else if (mine) {
      const parsed = opts.tool.parse(mine.args);
      if (parsed.ok) value = parsed.value;
      else issues = parsed.issues;
    }
    for (const [i, c] of calls.entries()) {
      let content: unknown;
      if (c === mine)
        content =
          value !== undefined
            ? { ok: true }
            : toolError("INVALID_ARGS", "Аргументы не прошли проверку, исправь и вызови снова.", issues);
      else if (sideByName.has(c.name))
        content = (await execute(c, i, sideByName, MAX_PARALLEL_TOOL_CALLS)).content;
      else
        content = toolError(
          "UNKNOWN_TOOL",
          side.length === 0
            ? `Доступен только инструмент ${opts.tool.name}.`
            : `Доступны только инструменты: ${offered.map((t) => t.name).join(", ")}.`,
        );
      messages.push({ role: "tool", toolCallId: c.id, toolName: c.name, content });
    }
    if (value !== undefined) return { ok: true, value, messages, stats };
    if (!mine) {
      messages.push({ role: "user", content: `Ответь только вызовом инструмента ${opts.tool.name}.` });
    }
    if (attempt < maxRepairs) opts.onEvent?.({ type: "repair", callType: opts.callType, attempt, issues });
  }
  return { ok: false, issues, messages, stats };
}

export interface ToolLoopResult {
  reason: "stop" | "tool" | "max_turns";
  /** Final assistant text when the model stopped without tool calls. */
  text?: string;
  messages: LlmMessage[];
  results: { call: ToolCall; ok: boolean; content: unknown }[];
  stats: CallStats;
}

/**
 * General loop: route → execute tool calls (≤8 per turn, extras get TOO_MANY_TOOL_CALLS) → feed results back,
 * until the model answers without tools, a tool listed in `stopOn` succeeds, or `maxTurns` is reached.
 */
export async function runToolLoop(
  opts: CallBase & {
    messages: LlmMessage[];
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool list
    tools: Tool<any, any>[];
    maxTurns: number;
    stopOn?: string[];
    toolChoice?: "auto" | "required";
    maxParallel?: number;
  },
): Promise<ToolLoopResult> {
  const messages = [...opts.messages];
  const stats = emptyStats();
  const results: ToolLoopResult["results"] = [];
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const maxParallel = opts.maxParallel ?? MAX_PARALLEL_TOOL_CALLS;
  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    const out = await callRoute(opts, messages, opts.tools, opts.toolChoice ?? "auto", turn);
    addStats(stats, out);
    messages.push(assistantMessage(out));
    const calls = out.result.toolCalls;
    if (calls.length === 0) {
      return {
        reason: "stop",
        ...(out.result.text ? { text: out.result.text } : {}),
        messages,
        results,
        stats,
      };
    }
    let stopped = false;
    for (const [i, call] of calls.entries()) {
      const { ok, content } = await execute(call, i, byName, maxParallel);
      opts.onEvent?.({
        type: "tool_result",
        name: call.name,
        ok,
        ...(ok ? {} : { code: (content as { error: { code: string } }).error.code }),
      });
      results.push({ call, ok, content });
      messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content });
      if (ok && opts.stopOn?.includes(call.name)) stopped = true;
    }
    if (stopped) return { reason: "tool", messages, results, stats };
  }
  return { reason: "max_turns", messages, results, stats };
}

async function execute(
  call: ToolCall,
  index: number,
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool list
  byName: Map<string, Tool<any, any>>,
  maxParallel: number,
): Promise<{ ok: boolean; content: unknown }> {
  if (index >= maxParallel) {
    return {
      ok: false,
      content: toolError("TOO_MANY_TOOL_CALLS", `Не больше ${maxParallel} вызовов инструментов за один ход.`),
    };
  }
  const tool = byName.get(call.name);
  if (!tool) {
    return { ok: false, content: toolError("UNKNOWN_TOOL", `Инструмента ${call.name} нет.`) };
  }
  const parsed = tool.parse(call.args);
  if (!parsed.ok) {
    return { ok: false, content: toolError("INVALID_ARGS", "Аргументы не прошли проверку.", parsed.issues) };
  }
  if (!tool.run) return { ok: true, content: { ok: true } };
  try {
    const content = await tool.run(parsed.value, call);
    return { ok: true, content: content ?? { ok: true } };
  } catch (e) {
    if (e instanceof ToolFailure) {
      const err = toolError(e.code, e.message, e.issues);
      return { ok: false, content: e.data === undefined ? err : { ...err, data: e.data } };
    }
    return { ok: false, content: toolError("TOOL_FAILED", "Инструмент завершился с ошибкой.") };
  }
}
