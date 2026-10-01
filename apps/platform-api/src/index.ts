export const APP = "@wizard/platform-api";

/** Consent text from the runtime's legal template registry (drafts until the lawyer). */
export { renderConsentText, withConsentText } from "./agents/consent.js";
export { bundleDraft, MIGRATOR_ROLE, migrateDraft, RUNTIME_ROLE, seedDraft } from "./agents/draft.js";
export { type AgentExecutorsOptions, createAgentExecutors } from "./agents/executors.js";
/** System tables added after a schema was created (users.last_login_at, _w_deletion_log): idempotent upgrade DDL. */
export { upgradeSystemTables } from "./agents/system-tables.js";
export { createPlatformApi, type PlatformApi, type PlatformApiOptions } from "./app.js";
export { MEMBER_LIMITS, OFFER_VERSION, type OrgRole } from "./auth/accounts.js";
export { type Mailer, type MailMessage, type OutboxLetter, OutboxMailer } from "./auth/mailer.js";
export {
  applyRegion,
  type GeoRegion,
  innValid,
  isRestrictedRegion,
  RESTRICTED_REGIONS,
} from "./auth/region.js";
export { cookieNames } from "./auth/sessions.js";
export {
  type BalanceMilli,
  Billing,
  type BillingOptions,
  insufficient,
  REFUND_CODES,
  type RunCharge,
  type RunOutcome,
} from "./billing/ledger.js";
/** M2-07: platform shop payments — card binding, subscriptions (renewals, dunning), topups; sweep() is hourly. */
export {
  activeCard,
  addMonth,
  BINDINGS_PER_IP_DAY,
  BINDINGS_PER_ORG_DAY,
  type BillingView,
  CARD_BINDING_KOP,
  ORGS_PER_CARD,
  PAST_DUE_DAYS,
  Payments,
  type PaymentsOptions,
  RETRY_DAYS,
} from "./billing/payments.js";
export {
  assertPlanLimit,
  type Bucket,
  PLANS,
  type PlanId,
  type PlanLimit,
  RUB_PER_CREDIT,
  TOPUP,
  WELCOME,
} from "./billing/plans.js";
/** YooKassa API client of the platform's own shop (never a client's shop). */
export { PlatformShop, type ShopOptions, type ShopPayment } from "./billing/shop.js";
export {
  assertStartupAllowed,
  type Config,
  loadConfig,
  type ReceiptConfig,
  StartupError,
} from "./config.js";
export {
  createDb,
  type Db,
  type DbHandle,
  DEFAULT_ORG_ID,
  DEV_USER_EMAIL,
  DEV_USER_ID,
  migrate,
  seed,
} from "./db/index.js";
export { ApiError, ERROR_STATUS, type ErrorCode } from "./errors.js";
export { ExportStore, sweepExpiredExports } from "./exports/storage.js";
export { type AuthUser, checkOrgAccess } from "./http/auth.js";
export { ImportStore, sweepExpiredImports } from "./imports/storage.js";
/** retention_cron platform part (M2-05): runtime journals → platform.deletion_log, consent notices, delete_system. */
export { type RetentionCronDeps, type RetentionCronReport, runRetentionCron } from "./privacy/cron.js";
export { type PurgedSystem, purgeDeletedSystems, SYSTEM_PURGE_DAYS } from "./privacy/delete-system.js";
export { collectDeletionLogs, type MovedEntry, notifyConsentWithdrawals } from "./privacy/deletion-log.js";
export { publishBlockers, specPublishBlockers } from "./publish/blockers.js";
/** G2 at prod publication: founder reviews (db.yaml#founder_reviews), abuse_flag journal, G2 context from the DB. */
export {
  type AbuseFlag,
  abuseContext,
  decideFounderReview,
  type FounderReviewStatus,
  founderReviewStatus,
  type ModerationLog,
  pendingFounderReviews,
  secretExistsFor,
} from "./publish/moderation.js";
export {
  applyProdMigration,
  httpSmoke,
  type ProdSmoke,
  type PublishOptions,
  prodUrl,
  type SmokeInput,
  type SmokeResult,
} from "./publish/prod.js";
export {
  draftSnapshot,
  SNAPSHOT_LIMIT,
  type SnapshotInput,
  type SnapshotResult,
} from "./publish/snapshot.js";
export {
  createDbosDispatcher,
  DBOS_APP,
  DBOS_SCHEMA,
  dbosLogger,
  QUEUE_INTERVIEW,
  QUEUE_RUNS,
  queueOf,
  RUN_WORKFLOW,
} from "./runs/dispatch.js";
export {
  type Durable,
  decodeError,
  type EncodedError,
  encodeError,
  type InputMessage,
  inProcessDurable,
  LocalMailboxes,
  ReplayedError,
  type StepOptions,
  TOPIC_INPUT,
  TOPIC_LOCK,
} from "./runs/durable.js";
export { EVENT_TYPES, EventBus, type EventType, INTERNAL_EVENTS, type RunEvent } from "./runs/events.js";
export { gateResultPayload, recordGateReport } from "./runs/gates.js";
export {
  ACTIVE_STATUSES,
  type EngineDeps,
  type EngineRole,
  NEEDS_LOCK,
  type RunDispatcher,
  RunEngine,
  TERMINAL_STATUSES,
} from "./runs/queue.js";
export { stubExecutors } from "./runs/stub.js";
export * from "./runs/types.js";
export { DbUsageSink } from "./runs/usage.js";
export { SECRET_NAME, type SecretPut, SecretStore } from "./secrets/store.js";
export { IllegalTransition, STAGES, type Stage } from "./services/stage.js";
export { BlobStore } from "./storage/blobs.js";
