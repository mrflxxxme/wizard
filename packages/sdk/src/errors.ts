import type { ErrorDetails } from "./sdk.js";

/** Application error code format (sdk.md §2.5). */
export const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{2,40}$/;

/** Default Russian messages for runtime error codes (runtime.yaml#data_api.error_codes). */
export const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  UNAUTHENTICATED: "Войдите в систему",
  FORBIDDEN: "Недостаточно прав для этого действия",
  NOT_FOUND: "Запись не найдена",
  VALIDATION_FAILED: "Проверьте заполнение полей",
  UNKNOWN_FIELD: "Такого поля нет",
  FIELD_HIDDEN: "Поле недоступно",
  FIELD_READONLY: "Поле нельзя изменить",
  CONFLICT: "Такое значение уже есть",
  CONSENT_REQUIRED: "Нужно согласие на обработку персональных данных",
  RATE_LIMITED: "Слишком много запросов, попробуйте позже",
  PAYLOAD_TOO_LARGE: "Слишком большой запрос",
  TIMEOUT: "Операция выполнялась слишком долго",
  LIMIT_EXCEEDED: "Превышен лимит операции",
  INTERNAL: "Внутренняя ошибка, мы уже разбираемся",
  EGRESS_DISABLED: "Внешние запросы недоступны",
  NETWORK: "Нет связи с сервером",
};

/** Message used when an app error has no `details.message` (runtime.yaml#functions.app_errors). */
export const DEFAULT_APP_ERROR_MESSAGE = "Операция отклонена";

export class WizardError extends Error {
  readonly code: string;
  readonly details: ErrorDetails;
  /** HTTP status when the error came from the runtime API (client side). */
  status?: number;

  constructor(code: string, details: ErrorDetails = {}) {
    super(details.message ?? ERROR_MESSAGES[code] ?? DEFAULT_APP_ERROR_MESSAGE);
    this.name = "WizardError";
    this.code = code;
    this.details = details;
  }
}

export function isWizardError(e: unknown): e is WizardError {
  return e instanceof WizardError;
}

/** `ctx.error(code, details)`: validates the code format so generated code cannot invent arbitrary codes. */
export function makeError(code: string, details?: ErrorDetails): WizardError {
  if (!ERROR_CODE_RE.test(code)) {
    return new WizardError("INTERNAL", { message: ERROR_MESSAGES.INTERNAL, invalidCode: code });
  }
  return new WizardError(code, details);
}
