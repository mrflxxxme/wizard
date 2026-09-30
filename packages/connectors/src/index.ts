export const PACKAGE = "@wizard/connectors";

/** Typed helpers for declaring connectors and actions. */
export { defineAction, defineConnector } from "./define.js";
/** Email: config, validateSpec; sendTemplate is a test-mode stub in M0. */
export { type EmailConfig, emailConfigSchema, emailConnector, validateEmailSpec } from "./email.js";
/** ConnectorError {code, retryable, message}; UniqueViolation — SystemDb.insert conflict. */
export {
  CONNECTOR_ERROR_CODES,
  ConnectorError,
  type ConnectorErrorCode,
  isConnectorError,
  UniqueViolation,
} from "./errors.js";
/** QR connector: config, validateSpec, token issue on insert, POST /_wizard/qr/check. */
export {
  issueQrToken,
  QR_SECRET,
  type QrCheckInput,
  type QrCheckResponse,
  type QrConfig,
  qrCheck,
  qrConfigSchema,
  qrConnector,
  validateQrSpec,
} from "./qr.js";
/** QR payload WZ1.<kid>.<rand>.<sig>: sign/verify, keyring rotation, revocation hash. */
export {
  base32,
  generateQrKey,
  newQrKeyring,
  newQrRand,
  parseQrKeyring,
  parseQrPayload,
  QR_GRACE_MS,
  type QrKey,
  type QrKeyring,
  type QrScope,
  type QrVerifyResult,
  qrTokenHash,
  rotateQrKeyring,
  serializeQrKeyring,
  signQrToken,
  verifyQrToken,
} from "./qr-token.js";
/** Registry of all four connectors and G0 validation of spec.integrations. */
export { CONNECTORS, getConnector, validateIntegration, validateIntegrations } from "./registry.js";
/** Logger allowlist, outbox receivers, invokeAction with input/output validation and idempotency. */
export {
  CALL_TTL_MS,
  createConnectorLogger,
  invokeAction,
  JsonlOutbox,
  MemoryOutbox,
  outboxMessage,
  requireTestMode,
} from "./runtime.js";
/** secret://name refs and M0 readers (.env WIZARD_SECRET_<SYSTEMID>_<NAME>, cached ≤ 5 min). */
export {
  cachedSecretReader,
  envSecretReader,
  parseSecretRef,
  SECRET_CACHE_MAX_MS,
  secretEnvVar,
  secretRef,
  staticSecretReader,
} from "./secrets.js";
/** Telegram: config, validateSpec, effective bot/login settings; sendToUser is a test-mode stub in M0. */
export {
  type TelegramConfig,
  telegramBot,
  telegramConfigSchema,
  telegramConnector,
  telegramLoginEnabled,
  validateTelegramSpec,
} from "./telegram.js";
/** Connector contract types (specs/connectors/connector-interface.md §1). */
export type * from "./types.js";
/** YooKassa: config, validateSpec, /api/pay (M0 mock), pay-mock confirmation, payment.succeeded/canceled core. */
export {
  applyPaymentCanceled,
  applyPaymentSucceeded,
  confirmMockPayment,
  type PaymentEventResult,
  type PayResult,
  PENDING_REUSE_MS,
  type ProviderPayment,
  startPayment,
  validateYookassaSpec,
  type YookassaBinding,
  type YookassaConfig,
  yookassaConfigSchema,
  yookassaConnector,
} from "./yookassa.js";
