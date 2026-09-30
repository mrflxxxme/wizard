export const APP = "@wizard/platform-api";

export { CONSENT_TEMPLATES, renderConsentText, withConsentText } from "./agents/consent.js";
export { bundleDraft, MIGRATOR_ROLE, migrateDraft, RUNTIME_ROLE, seedDraft } from "./agents/draft.js";
export { type AgentExecutorsOptions, createAgentExecutors } from "./agents/executors.js";
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
export { assertStartupAllowed, type Config, loadConfig, StartupError } from "./config.js";
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
export { type AuthUser, checkOrgAccess } from "./http/auth.js";
export { EVENT_TYPES, type EventType, INTERNAL_EVENTS, type RunEvent } from "./runs/events.js";
export { gateResultPayload, recordGateReport } from "./runs/gates.js";
export { RunEngine } from "./runs/queue.js";
export { stubExecutors } from "./runs/stub.js";
export * from "./runs/types.js";
export { IllegalTransition, STAGES, type Stage } from "./services/stage.js";
