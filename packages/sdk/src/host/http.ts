// Error → HTTP mapping shared by hosts (runtime.yaml#data_api.error_shape, #functions.app_errors).
import { DEFAULT_APP_ERROR_MESSAGE, ERROR_MESSAGES, WizardError } from "../errors.js";
import type { ErrorDetails } from "../sdk.js";

export const ERROR_HTTP_STATUS: Readonly<Record<string, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  UNKNOWN_FIELD: 422,
  FIELD_HIDDEN: 422,
  FIELD_READONLY: 422,
  CONFLICT: 409,
  CONSENT_REQUIRED: 422,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  TIMEOUT: 504,
  LIMIT_EXCEEDED: 422,
  INTERNAL: 500,
};

export interface ErrorBody {
  error: { code: string; message: string; details?: ErrorDetails; requestId?: string };
}

/** Runtime codes keep their HTTP status; application codes from ctx.error → 400. Unknown errors → 500. */
export function toErrorResponse(e: unknown, requestId?: string): { status: number; body: ErrorBody } {
  if (!(e instanceof WizardError)) {
    return {
      status: 500,
      body: { error: { code: "INTERNAL", message: ERROR_MESSAGES.INTERNAL as string, requestId } },
    };
  }
  const { message: _m, ...rest } = e.details;
  const message = e.details.message ?? ERROR_MESSAGES[e.code] ?? DEFAULT_APP_ERROR_MESSAGE;
  return {
    status: ERROR_HTTP_STATUS[e.code] ?? 400,
    body: { error: { code: e.code, message, details: rest, ...(requestId ? { requestId } : {}) } },
  };
}
