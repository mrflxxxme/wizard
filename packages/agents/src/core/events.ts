// Agent loop events (internal journal) and the host emitter for RunEvents (specs/platform/workflows.yaml#events).
import type { CallType } from "@wizard/llm";
import type { ToolIssue } from "./tool.js";

/** Internal loop events: never contain prompt/response content (data-boundary.yaml#routing.storage_of_content). */
export type AgentEvent =
  | {
      type: "llm_call";
      callType: CallType;
      /** 1-based call number inside this loop/structured call. */
      n: number;
      toolCalls: number;
      creditsCharged: number;
      ruFallback: boolean;
    }
  | { type: "tool_result"; name: string; ok: boolean; code?: string }
  | { type: "repair"; callType: CallType; attempt: number; issues: ToolIssue[] };

export type AgentEventSink = (e: AgentEvent) => void;

/** Host-provided emitter of RunEvents: type ∈ workflows.yaml#events.types, payload as specified there. */
export type EmitFn = (type: string, payload: Record<string, unknown>) => void | Promise<void>;

/** Durable step wrapper: identity in M0, DBOS.runStep in M1 (architecture.yaml#interfaces.agent_host). */
export type RunStepFn = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export const identityStep: RunStepFn = (_name, fn) => fn();
