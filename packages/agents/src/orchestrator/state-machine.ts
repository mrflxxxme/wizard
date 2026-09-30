// Orchestrator state machine: specs/agents/orchestrator.yaml#state_machine. Events are internal (not RunEvents).
import { AgentError } from "../core/errors.js";

export const ORCH_STATES = [
  "idle",
  "analyzing",
  "asking",
  "carding",
  "awaiting_approval",
  "approved",
  "building",
  "needs_user",
  "done",
  "cancelled",
  "failed",
] as const;
export type OrchState = (typeof ORCH_STATES)[number];

export type OrchEvent =
  | { type: "BRIEF_SUBMITTED" }
  | { type: "ANALYSIS_DONE"; forks: number }
  | { type: "ANSWER"; remaining: number }
  | { type: "REST_BY_RECOMMENDATION" }
  | { type: "CARD_READY" }
  | { type: "CARD_EDIT"; cardVersion: number }
  /** balanceOk: M1+ balance ≥ cap; undefined (M0) passes. */
  | { type: "APPROVE"; balanceOk?: boolean }
  | { type: "BUILD_STARTED" }
  | { type: "BUILDER_NEEDS_USER" }
  | { type: "USER_CHOICE" }
  | { type: "BUILD_DONE" }
  | { type: "CHANGE_REQUESTED" }
  | { type: "CANCEL" }
  | { type: "LLM_FAILED" };
export type OrchEventType = OrchEvent["type"];

export const ORCH_EVENT_TYPES: readonly OrchEventType[] = [
  "BRIEF_SUBMITTED",
  "ANALYSIS_DONE",
  "ANSWER",
  "REST_BY_RECOMMENDATION",
  "CARD_READY",
  "CARD_EDIT",
  "APPROVE",
  "BUILD_STARTED",
  "BUILDER_NEEDS_USER",
  "USER_CHOICE",
  "BUILD_DONE",
  "CHANGE_REQUESTED",
  "CANCEL",
  "LLM_FAILED",
];

export const MAX_CARD_VERSIONS = 5;

interface Transition {
  from: OrchState | "*";
  event: OrchEventType;
  to: OrchState;
  // biome-ignore lint/suspicious/noExplicitAny: guard receives the matching event variant
  guard?: (e: any) => boolean;
}

export const TRANSITIONS: readonly Transition[] = [
  { from: "idle", event: "BRIEF_SUBMITTED", to: "analyzing" },
  { from: "analyzing", event: "ANALYSIS_DONE", to: "asking", guard: (e) => e.forks > 0 },
  { from: "analyzing", event: "ANALYSIS_DONE", to: "carding", guard: (e) => e.forks === 0 },
  { from: "asking", event: "ANSWER", to: "asking", guard: (e) => e.remaining > 0 },
  { from: "asking", event: "ANSWER", to: "carding", guard: (e) => e.remaining === 0 },
  { from: "asking", event: "REST_BY_RECOMMENDATION", to: "carding" },
  { from: "carding", event: "CARD_READY", to: "awaiting_approval" },
  {
    from: "awaiting_approval",
    event: "CARD_EDIT",
    to: "carding",
    guard: (e) => e.cardVersion < MAX_CARD_VERSIONS,
  },
  { from: "awaiting_approval", event: "APPROVE", to: "approved", guard: (e) => e.balanceOk !== false },
  { from: "approved", event: "BUILD_STARTED", to: "building" },
  { from: "building", event: "BUILDER_NEEDS_USER", to: "needs_user" },
  { from: "needs_user", event: "USER_CHOICE", to: "building" },
  { from: "building", event: "BUILD_DONE", to: "done" },
  { from: "done", event: "CHANGE_REQUESTED", to: "analyzing" },
  { from: "*", event: "CANCEL", to: "cancelled" },
  { from: "analyzing", event: "LLM_FAILED", to: "failed" },
  { from: "carding", event: "LLM_FAILED", to: "failed" },
];

/** Pure transition; an impossible event throws INVALID_TRANSITION and changes nothing. */
export function transition(state: OrchState, event: OrchEvent): OrchState {
  for (const t of TRANSITIONS) {
    if ((t.from === state || t.from === "*") && t.event === event.type && (!t.guard || t.guard(event)))
      return t.to;
  }
  throw new AgentError("INVALID_TRANSITION", "Это действие сейчас недоступно.", { state, event: event.type });
}

export function canTransition(state: OrchState, event: OrchEvent): boolean {
  try {
    transition(state, event);
    return true;
  } catch {
    return false;
  }
}

/** Machine with idempotency: an event repeated with the same idempotencyKey does not change the state. */
export class OrchestratorMachine {
  state: OrchState;
  private readonly seen: Set<string>;

  constructor(state: OrchState = "idle", seenKeys: Iterable<string> = []) {
    this.state = state;
    this.seen = new Set(seenKeys);
  }

  send(event: OrchEvent, idempotencyKey?: string): OrchState {
    if (idempotencyKey !== undefined && this.seen.has(idempotencyKey)) return this.state;
    this.state = transition(this.state, event);
    if (idempotencyKey !== undefined) this.seen.add(idempotencyKey);
    return this.state;
  }

  get seenKeys(): string[] {
    return [...this.seen];
  }
}
