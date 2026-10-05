export const PACKAGE = "@wizard/connectors";

/** Typed helpers for declaring connectors and actions. */
export { defineAction, defineConnector } from "./define.js";
/** M2-52 (D71): which declared egress hosts are valid public targets (not internal, not platform domains). */
export {
  type EgressHostProblem,
  egressHostProblem,
  INTERNAL_SUFFIXES,
  newEgressHosts,
  PLATFORM_DOMAINS,
  platformDomains,
  specEgressHosts,
} from "./egress-hosts.js";
/** Email: config, validateSpec (subject/body PII rules), sendTemplate (outbox | dev SMTP | platform | client SMTP), platform mail. */
export {
  type ComposedMail,
  type EmailConfig,
  emailConfigSchema,
  emailConnector,
  sendPlatformEmail,
  sendTemplateToAddress,
  validateEmailSpec,
} from "./email.js";
/** ConnectorError {code, retryable, message}; UniqueViolation — SystemDb.insert conflict. */
export {
  CONNECTOR_ERROR_CODES,
  ConnectorError,
  type ConnectorErrorCode,
  isConnectorError,
  UniqueViolation,
} from "./errors.js";
/** RFC 5322/2047 helpers: header sanitising, encoded words, address formatting, header parsing. */
export {
  buildMessage,
  decodeWords,
  displayName,
  encodeWords,
  formatAddress,
  headerSafe,
  isPlainAddress,
  parseHeaders,
} from "./mime.js";
/** SSRF guard: private-address check, public DNS resolution, guarded fetch, TCP dialer; CIDR match, client IP. */
export {
  type Dialer,
  effectiveClientIp,
  type GuardedFetchOptions,
  guardedFetch,
  ipInCidrs,
  isPrivateAddress,
  type Resolver,
  resolvePublic,
  systemResolver,
  tcpDialer,
} from "./net.js";
/** Workflow notify step (M2-50): recipients $record/$owner/$role/visitor with consent, per-recipient keys, journal. */
export {
  type NotifyResult,
  type NotifyStepInput,
  runNotifyStep,
  UNSUBSCRIBE_FOOTER_RU,
  VISITOR_MESSAGES_PER_DAY,
} from "./notify.js";
/** Platform-owned connector settings (shared Telegram bot, platform SMTP, dev receiver) from WIZARD_* env. */
export { type PlatformEnvOptions, platformConfigFromEnv } from "./platform.js";
/** QR connector: config, validateSpec, token issue on insert, POST /_wizard/qr/check; revoked hashes in ctx.store. */
export {
  issueQrToken,
  QR_REVOKED_PREFIX,
  QR_SECRET,
  type QrCheckInput,
  type QrCheckResponse,
  type QrConfig,
  qrCheck,
  qrConfigSchema,
  qrConnector,
  validateQrSpec,
} from "./qr.js";
/** QR offline package (h, id, display line, status — no token/PII) and sync with first-scan-wins (M2-03). */
export {
  decodeQrCursor,
  encodeQrCursor,
  parseQrSyncBody,
  QR_CLOCK_SKEW_MS,
  QR_EVENT_RETENTION_MS,
  QR_MANIFEST_TTL_MS,
  QR_SYNC_MAX_EVENTS,
  type QrManifest,
  type QrManifestEntry,
  type QrOfflineDenied,
  type QrOfflineStore,
  type QrSyncBody,
  type QrSyncEvent,
  type QrSyncInput,
  type QrSyncResponse,
  type QrSyncResult,
  qrManifest,
  qrManifestId,
  qrOfflineHash,
  qrSync,
} from "./qr-offline.js";
/** QR code PNG (inline email attachment). */
export { qrPng } from "./qr-png.js";
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
/** Logger allowlist, outbox receivers, invokeAction (validation, idempotency, retries), store-backed quotas. */
export {
  CALL_TTL_MS,
  consumeQuota,
  createConnectorLogger,
  type InvokeOptions,
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
/** Minimal SMTP submission client (implicit TLS / mandatory STARTTLS; plaintext only for the dev receiver). */
export { type SmtpEndpoint, SmtpError, type SmtpSendOptions, sendSmtp } from "./smtp.js";
/** Reserved system slugs and the invitation quota (L3-29). */
export {
  consumeInviteQuota,
  INVITES_PER_DAY,
  isReservedSystemSlug,
  RESERVED_SYSTEM_SLUGS,
} from "./system-policy.js";
/** Telegram: config, validateSpec (G2-TG-01), sendToUser (shared/own bot), deep links, webhooks, bot management. */
export {
  appLabel,
  createTelegramLink,
  handlePlatformUpdate,
  handleTelegramUpdate,
  LINK_TTL_MS,
  LINKED_TEXT,
  linkChat,
  linkTokenHash,
  newLinkToken,
  type PlatformHookDeps,
  parseTelegramUpdate,
  platformHookToken,
  platformLinkTarget,
  secretMatches,
  TELEGRAM_SECRET_HEADER,
  type TelegramConfig,
  type TelegramUpdate,
  telegramBot,
  telegramBotToken,
  telegramConfigSchema,
  telegramConnector,
  telegramDeleteWebhook,
  telegramGetMe,
  telegramHookToken,
  telegramLoginEnabled,
  telegramSetWebhook,
  telegramWebhookSecret,
  validateTelegramSpec,
  WEBHOOK_BODY_MAX,
  type WebhookReply,
} from "./telegram.js";
/** Bot API call with error mapping, `/bot<token>` masking, derived 32-char tokens. */
export { botCall, derivedToken, maskTelegramToken, TELEGRAM_API_BASE } from "./telegram-api.js";
/** Template placeholders: PII resolution against the spec, notify steps of an integration, rendering. */
export {
  CANCEL_LINK_PLACEHOLDER,
  OWNER_REF,
  type PlaceholderInfo,
  parseRecipients,
  type RecipientRef,
  recordRecipientKind,
  renderTemplate,
  resolvePlaceholder,
  UNSUBSCRIBE_LINK_PLACEHOLDER,
} from "./templates.js";
/** Connector contract types (specs/connectors/connector-interface.md §1). */
export type * from "./types.js";
/** M2-53: incoming webhooks — config, G0, secret address (hookToken), signature/shared secret check, field mapping. */
export {
  DEV_WEBHOOK_KEY,
  INCOMING_WEBHOOK_BODY_MAX,
  INCOMING_WEBHOOK_RATE_PER_MINUTE,
  type IncomingWebhook,
  mapWebhookFields,
  parseWebhookBody,
  validateWebhookSpec,
  verifyWebhook,
  WEBHOOK_SECRET_PREFIX,
  type WebhookConfig,
  type WebhookVerdict,
  webhookConfigSchema,
  webhookConnector,
  webhookHookToken,
  webhookKeyFromEnv,
  webhookUrl,
  webhookWorkflows,
} from "./webhook/index.js";
/** YooKassa: config, validateSpec, /api/pay (API or draft mock), pay-mock, webhooks (verify, re-read, apply), refunds. */
export {
  applyPaymentCanceled,
  applyPaymentSucceeded,
  applyRefundSucceeded,
  confirmMockPayment,
  handleYookassaNotification,
  type NotificationResult,
  type PaymentEventResult,
  type PayResult,
  PENDING_REUSE_MS,
  type ProviderPayment,
  parseYookassaNotification,
  startPayment,
  validateYookassaSpec,
  YOOKASSA_EVENTS,
  type YookassaBinding,
  type YookassaConfig,
  yookassaConfigSchema,
  yookassaConnector,
  yookassaHookToken,
  yookassaSourceAllowed,
  yookassaWebhookUrl,
} from "./yookassa.js";
/** YooKassa API v3 client: Basic auth, Idempotence-Key (sha256 → UUID), error mapping, built-in IP allowlist. */
export {
  type ApiPayment,
  type ApiRefund,
  DEFAULT_YOOKASSA_PLATFORM,
  idempotenceKey,
  YOOKASSA_API_BASE,
  YOOKASSA_IP_ALLOWLIST,
  yookassaPlatform,
} from "./yookassa-api.js";
