// ConnectorError: connector-interface.md §3.
export const CONNECTOR_ERROR_CODES = {
  CONFIG_INVALID: false,
  SECRET_MISSING: false,
  AUTH_FAILED: false,
  INVALID_REQUEST: false,
  NOT_FOUND: false,
  RATE_LIMITED: true,
  UPSTREAM_UNAVAILABLE: true,
  RECIPIENT_UNAVAILABLE: false,
  PII_BLOCKED: false,
  EGRESS_DISABLED: false,
} as const;

export type ConnectorErrorCode = keyof typeof CONNECTOR_ERROR_CODES;

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly retryable: boolean;
  readonly providerCode?: string;
  /** Provider status (HTTP or SMTP reply code) for the PII-free log line. */
  readonly providerStatus?: number;
  /** Wait hint from the provider (Telegram parameters.retry_after, HTTP Retry-After). */
  readonly retryAfterMs?: number;

  constructor(
    code: ConnectorErrorCode,
    message: string,
    opts: { providerCode?: string; providerStatus?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.retryable = CONNECTOR_ERROR_CODES[code];
    if (opts.providerCode !== undefined) this.providerCode = opts.providerCode;
    if (opts.providerStatus !== undefined) this.providerStatus = opts.providerStatus;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export function isConnectorError(e: unknown): e is ConnectorError {
  return e instanceof ConnectorError;
}

/** SystemDb.insert throws this on a unique constraint conflict (Postgres 23505). */
export class UniqueViolation extends Error {
  readonly entity: string;
  readonly field: string;
  constructor(entity: string, field: string) {
    super(`unique violation on ${entity}.${field}`);
    this.name = "UniqueViolation";
    this.entity = entity;
    this.field = field;
  }
}
