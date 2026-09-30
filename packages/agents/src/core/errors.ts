// Agent-level errors. Codes are for code and models; `message` is Russian (shown to the user when surfaced).

export type AgentErrorCode =
  | "INVALID_TRANSITION"
  | "INVALID_INPUT"
  | "ORCH_INVALID_OUTPUT"
  | "NO_TOOL_CALL"
  | "UNKNOWN_TOOL"
  | "INVALID_ARGS"
  | "TOO_MANY_TOOL_CALLS"
  | "TOOL_FAILED";

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: AgentErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.details = details;
  }
}
