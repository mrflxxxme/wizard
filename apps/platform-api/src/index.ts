export const APP = "@wizard/platform-api";

/** abuse.yaml#takedown escalations: org-wide suspension, automatic takedown (auto_suspend), the owner's «Оспорить». */
export {
  AF_BLOCKERS,
  AUTO_SUSPEND_REPORTS,
  type AutoSuspendResult,
  antifraudRecheck,
  checkAutoSuspend,
  DISPUTE_SENT_RU,
  disputeG2Block,
  setOrgSuspension,
} from "./abuse/escalation.js";
/** «Пожаловаться», takedown and staff access by ticket (security/abuse.yaml#report, #takedown; M2-08). */
export {
  ABUSE_SLA_MS,
  applyAbuseAction,
  CATEGORY_RU,
  checkAbuseSla,
  createAbuseReport,
  purgeAbuseContacts,
  REPORT_CATEGORIES,
  STAFF_ACCESS_TTL_MS,
  staffAccessUntil,
  systemOfUrl,
} from "./abuse/reports.js";
/** Staff accounts with mandatory TOTP (api.yaml#info.x-auth.M2): grant/revoke, MFA reset, session state. */
export { resetStaffMfa, STAFF_MFA_TTL_MS, setStaff, staffState } from "./abuse/staff.js";
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
/** M2-09: platform mail over SMTP (WIZARD_SMTP_*) or the Unisender Go HTTP API, outbox fallback when not configured. */
export { ApiMailer, platformMailer, SmtpMailer, type SmtpMailerOptions } from "./auth/smtp-mailer.js";
/** RFC 6238 TOTP on node:crypto (staff MFA): code of a base32 secret, verification with replay guard. */
export { base32Decode, base32Encode, newTotpSecret, otpauthUri, totpCode, verifyTotp } from "./auth/totp.js";
export {
  type BalanceMilli,
  Billing,
  type BillingOptions,
  insufficient,
  REFUND_CODES,
  type RunCharge,
  type RunOutcome,
} from "./billing/ledger.js";
/** M2-15: platform LLM spend cap of the calendar month (Europe/Moscow). */
export {
  LLM_BUDGET_EXHAUSTED_RU,
  LLM_CAP_WARN_SHARE,
  type LlmCapStatus,
  LlmMonthlyCap,
  llmSpentRub,
  moscowMonth,
} from "./billing/llm-cap.js";
/** B2-01, B2-04: model spend by purpose (org kind client | staff | eval) per Moscow day and the beta v2 budget. */
export {
  type B2BudgetStatus,
  b2BudgetStatus,
  checkB2Budget,
  type LlmSpendDay,
  type LlmSpendReport,
  llmSpendByDay,
  llmSpentByKindRub,
  ORG_KINDS,
  orgKind,
} from "./billing/llm-spend.js";
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
  type PaidPlan,
  PILOT_GRANT_DAYS,
  PLANS,
  type PlanId,
  type PlanLimit,
  phoneOtpAllowed,
  RUB_PER_CREDIT,
  TOPUP,
  WELCOME,
} from "./billing/plans.js";
/** YooKassa API client of the platform's own shop (never a client's shop). */
export { PlatformShop, type ShopOptions, type ShopPayment } from "./billing/shop.js";
export {
  assertStartupAllowed,
  type Config,
  DEFAULT_LLM_MONTHLY_CAP_RUB,
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
/**
 * Founder alerts: structured log + optional WIZARD_OPS_ALERT_URL webhook (deploy.yaml#pilot.observability);
 * claimOpsAlert/alertOnce — the one dedup path over db.yaml#ops_alerts.
 */
export {
  alertOnce,
  claimOpsAlert,
  createOpsAlert,
  type OpsAlert,
  type OpsAlertFn,
  type OpsAlertOptions,
} from "./ops/alert.js";
/** M2-09: the founder alert channel from the config (log, webhook, WIZARD_OPS_ALERT_EMAIL letter). */
export { opsAlertFromConfig } from "./ops/alert-config.js";
/** M2-09: founder alert «run failed rate > 20% за 1 ч» (one per clock hour). */
export { checkRunFailureRate, RUN_FAIL_RATE_MIN_RUNS, RUN_FAIL_RATE_THRESHOLD } from "./ops/checks.js";
/** M2-09: Prometheus metrics of platform-api and the worker (WIZARD_METRICS_PORT), DB gauges on scrape. */
export { collectDbGauges, platformMetrics, startMetricsServer } from "./ops/metrics.js";
/** M2-15 pilot: founder CLI (invite, plan, grant, orgs, spend) and the invite-only registration. */
export { PILOT_CLI_USAGE, type PilotCliDeps, parseArgs, runPilotCli } from "./pilot/cli.js";
export {
  acceptPilotInvite,
  admitNewUser,
  createPilotInvite,
  PILOT_INVITE_DAYS,
  PILOT_WELCOME_PATH,
  PilotError,
  type PilotInviteInput,
  type PilotInviteResult,
  pilotInviteLink,
  REGISTRATION_INVITE_ONLY_RU,
} from "./pilot/invites.js";
/** M2-09: beta_readiness (platform_settings) — partner invitations only after M2-13. */
export {
  BETA_READINESS_CHECKLIST_RU,
  BETA_READINESS_MISSING_RU,
  type BetaReadiness,
  getBetaReadiness,
  setBetaReadiness,
} from "./pilot/readiness.js";
/** Pilot operations shared by the CLI and the staff console «Пилот» (invites, orgs, grants, review flag, LLM spend). */
export {
  findPilotOrg,
  grantPilotCredits,
  type LlmSpendView,
  listPilotInvites,
  type PilotInviteStatus,
  type PilotInviteView,
  type PilotOrgRow,
  pilotOrgs,
  platformLlmSpend,
  revokePilotInvite,
  setFounderReviewRequired,
  setPilotPlan,
} from "./pilot/service.js";
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
  type FounderReviewReason,
  type FounderReviewStatus,
  founderReviewLetter,
  founderReviewReason,
  founderReviewStatus,
  type ModerationLog,
  ORG_SUSPENDED_RU,
  orgSuspended,
  pdFields,
  pendingFounderReviews,
  type ReviewNotice,
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
