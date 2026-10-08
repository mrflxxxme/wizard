export type LlmErrorCode =
  | "UNKNOWN_CALL_TYPE"
  | "LLM_UNAVAILABLE"
  | "FIXTURE_MISS"
  | "BUDGET_EXCEEDED"
  | "PII_TOKEN_IN_T1_PAYLOAD"
  | "PII_IN_T1_PAYLOAD"
  | "RECORD_NOT_ALLOWED"
  | "IMPORT_PAYLOAD_NOT_SYNTHETIC"
  | "T1_FORBIDDEN"
  | "RUNTIME_AI_INVALID"
  /** Gateway allowlist (D18): a western API host or closed western model with platform keys. */
  | "MODEL_NOT_ALLOWED"
  | "ABORTED";

/** Messages are user-facing (Russian); details never contain prompt text beyond what the spec allows (FIXTURE_MISS). */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: LlmErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.details = details;
  }
}
