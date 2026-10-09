// Error codes and HTTP statuses: specs/platform/api.yaml#/components/schemas/Error (x-http-status).
export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  OTP_INVALID: 401,
  INSUFFICIENT_CREDITS: 402,
  PLAN_LIMIT: 402,
  BUILDS_LIMIT: 402,
  EDITS_LIMIT: 402,
  FORBIDDEN: 403,
  MFA_REQUIRED: 403,
  NOT_OWNER: 403,
  CARD_BINDING_REQUIRED: 403,
  FOUNDER_REVIEW_PENDING: 403,
  ORG_SUSPENDED: 403,
  REGISTRATION_INVITE_ONLY: 403,
  PAYMENTS_DISABLED: 403,
  NOT_FOUND: 404,
  SYSTEM_LOCKED: 409,
  NO_GATE_FAILURE: 409,
  RUN_NOT_CANCELLABLE: 409,
  RUN_NOT_WAITING_INPUT: 409,
  CARD_VERSION_STALE: 409,
  NO_CARD: 409,
  NO_PLAN: 409,
  PLAN_REVISION_STALE: 409,
  PREVIEW_NOT_READY: 409,
  INVITE_EXPIRED: 410,
  EXPORT_LINK_USED: 410,
  VERSION_CONFLICT: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  HOST_NOT_ALLOWED: 421,
  OPS_INVALID: 422,
  IDEMPOTENCY_MISMATCH: 422,
  CONSENT_REQUIRED: 422,
  LAST_OWNER: 422,
  CARD_BINDING_REJECTED: 422,
  OPERATOR_NAME_REQUIRED: 422,
  OPERATOR_CONTACT_REQUIRED: 422,
  OPERATOR_ADDRESS_REQUIRED: 422,
  INN_INVALID: 422,
  SELLER_REQUISITES_REQUIRED: 422,
  OGRN_INVALID: 422,
  PHONE_LOGIN_PLAN_REQUIRED: 422,
  CARD_NOT_RU: 422,
  SYSTEM_SUSPENDED: 422,
  GATES_FAILED: 422,
  DESTRUCTIVE_IN_PROD: 422,
  DESTRUCTIVE_BLOCKED: 422,
  DESTRUCTIVE_CONSEQUENCES_CHANGED: 409,
  DESTRUCTIVE_UNDO_UNAVAILABLE: 409,
  ROLLBACK_TARGET_INVALID: 422,
  PLAN_INVALID: 422,
  DEMO_REPLAY_NO_SCENARIO: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  LLM_UNAVAILABLE: 503,
  LLM_BUDGET_EXHAUSTED: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ErrorBody {
  code: ErrorCode;
  message_ru: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    readonly message_ru: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(`${code}: ${message_ru}`);
    this.name = "ApiError";
    this.status = ERROR_STATUS[code];
  }
  body(): ErrorBody {
    return this.details
      ? { code: this.code, message_ru: this.message_ru, details: this.details }
      : { code: this.code, message_ru: this.message_ru };
  }
}

export const notFound = (what = "Объект"): ApiError => new ApiError("NOT_FOUND", `${what} не найден`);
export const invalid = (message_ru: string, details?: Record<string, unknown>): ApiError =>
  new ApiError("VALIDATION_FAILED", message_ru, details);
