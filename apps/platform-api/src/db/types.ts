// Kysely table types for the M0 tables (+ M1-02 accounts) of specs/platform/db.yaml. Keys are fully qualified (AGENTS.md).
import type { ColumnType, Generated } from "kysely";

type Ts = ColumnType<Date, Date | string, Date | string>;
type TsDef = ColumnType<Date, Date | string | undefined, Date | string>;
type TsNull = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
/** jsonb: read as parsed JSON; written through `json()` (explicit cast). */
type Json<T = unknown> = ColumnType<T, unknown, unknown>;
/** bigint: postgres.js returns int8 as string. */
type Big = ColumnType<string, number | string | bigint, number | string | bigint>;
type BigNull = ColumnType<string | null, number | string | bigint | null, number | string | bigint | null>;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string | null;
  is_staff: Generated<boolean>;
  totp_secret_ref: string | null;
  mfa_enrolled_at: TsNull;
  /** M2-08: RFC 6238 time step of the last accepted code (a code is accepted once). */
  totp_last_step: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  /** M2-08: HMAC hashes of the unused recovery codes. */
  mfa_recovery_hashes: Json<string[] | null>;
  deleted_at: TsNull;
  pd_consent_at: TsNull;
  offer_accepted_at: TsNull;
  offer_version: string | null;
  /** B2-26 (migration 0035): consent to letters about new abilities («Теперь умеем»); null — no letters. */
  updates_consent_at: TsNull;
  created_at: TsDef;
}

export interface OrgsTable {
  id: Generated<string>;
  name: string;
  plan: Generated<string>;
  ru_only: Generated<boolean>;
  require_founder_review: Generated<boolean>;
  passport_collection_allowed: Generated<boolean>;
  suspended_at: TsNull;
  region_code: string | null;
  t1_restricted: Generated<boolean>;
  /** D70: pilot limits of the org (NULL — billing/pilot-limits.ts defaults). */
  pilot_builds_limit: number | null;
  pilot_edits_limit: number | null;
  /** B2-01: client | staff | eval (migration 0031); the purpose of the org's llm_calls (B2-04). */
  kind: ColumnType<OrgKind, OrgKind | undefined, OrgKind>;
  /** B2-02: demo replay — the org's runs replay recorded model answers for free (staff orgs only; migration 0032). */
  demo_replay: Generated<boolean>;
  created_at: TsDef;
}

/** Kind of an organization (B2-01, D76 (10)): a customer, the founder's own org, probes and measurements. */
export type OrgKind = "client" | "staff" | "eval";

export interface MembershipsTable {
  org_id: string;
  user_id: string;
  role: "owner" | "editor" | "viewer";
  created_at: TsDef;
}

export interface SystemsTable {
  id: Generated<string>;
  org_id: string;
  slug: string;
  schema_key: string;
  name: string;
  stage: Generated<string>;
  card: Json<Record<string, unknown> | null>;
  card_version: Generated<number>;
  card_approved_version: number | null;
  pending_questions: Json<unknown[]>;
  draft_revision: Generated<number>;
  preview_revision: number | null;
  prod_revision: number | null;
  schema_hwm_revision: number | null;
  shard_id: string | null;
  suspended_at: TsNull;
  draft_data_purged_at: TsNull;
  /** M2-05 (F5): the owner was warned about the purge of the draft data (beyond db.yaml, impl-notes M2-05). */
  draft_purge_notice_at: TsNull;
  /** B2-02: the recorded scenario of a system created in demo replay (tools/fixtures/demo/<name>.jsonl), else null. */
  demo_scenario: string | null;
  last_activity_at: TsDef;
  created_by: string;
  updated_at: TsDef;
  deleted_at: TsNull;
  created_at: TsDef;
}

export interface MessagesTable {
  id: Generated<string>;
  system_id: string;
  seq: number;
  role: string;
  kind: string;
  text: string | null;
  payload: Json<Record<string, unknown> | null>;
  run_id: string | null;
  author_user_id: string | null;
  created_at: TsDef;
}

/** B2-20 (migration 0033): revisions of the system plan awaiting approval (db.yaml#system_plans). */
export interface SystemPlansTable {
  system_id: string;
  revision: number;
  status: string;
  source: string;
  plan: Json<Record<string, unknown>>;
  errors: Json<unknown[]>;
  fingerprint: string | null;
  run_id: string | null;
  build_run_id: string | null;
  author_user_id: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: TsDef;
  /** B2-21 (migration 0034): stage checkpoints of the build by this plan revision, by stage id. */
  checkpoints: Json<Record<string, unknown>>;
}

export interface RevisionsTable {
  system_id: string;
  version: number;
  parent_version: number | null;
  kind: string;
  author: string;
  author_user_id: string | null;
  run_id: string | null;
  spec: Json<Record<string, unknown>>;
  ops: Json<unknown[]>;
  files_manifest_sha: string;
  bundle_key: string | null;
  g0_passed: boolean | null;
  idempotency_key: string | null;
  summary_ru: string | null;
  created_at: TsDef;
}

export interface FilesTable {
  sha256: string;
  size: Big;
  content_type: string;
  storage_key: string;
  created_at: TsDef;
}

export interface RunsTable {
  id: Generated<string>;
  org_id: string;
  system_id: string | null;
  kind: string;
  mode: string | null;
  status: Generated<string>;
  current_step: string | null;
  input: Json<Record<string, unknown>>;
  pending_input: Json<Record<string, unknown> | null>;
  card_version: number | null;
  credits_estimate_milli: BigNull;
  credits_cap_milli: BigNull;
  credits_used_milli: ColumnType<string, number | string | undefined, number | string>;
  base_revision: number | null;
  result_revision: number | null;
  failure_code: string | null;
  failure_message_ru: string | null;
  cancel_requested_at: TsNull;
  started_by: string | null;
  dbos_workflow_id: string | null;
  heartbeat_at: TsNull;
  started_at: TsNull;
  finished_at: TsNull;
  created_at: TsDef;
}

export interface RunEventsTable {
  run_id: string;
  seq: number;
  type: string;
  payload: Json<Record<string, unknown>>;
  ts: TsDef;
}

export interface GateReportsTable {
  run_id: string;
  system_id: string;
  revision: number;
  level: string;
  passed: boolean;
  report: Json<Record<string, unknown>>;
  created_at: TsDef;
}

/** db.yaml#g1_checks: QA scenarios of a passed G1 (runs/g1-checks.ts StoredG1Check[]), reused by the publish G1. */
export interface G1ChecksTable {
  system_id: string;
  revision: number;
  run_id: string;
  checks: Json<unknown[]>;
  created_at: TsDef;
}

export interface LlmCallsTable {
  id: Generated<string>;
  org_id: string;
  system_id: string | null;
  run_id: string | null;
  step: string | null;
  call_type: string;
  agent_role: string | null;
  tier: string;
  provider: string;
  model_id: string;
  attempt: number;
  status: string;
  error_code: string | null;
  route_reason: string;
  fallback_from: string | null;
  policy_version: string;
  scrubbed: boolean;
  pii_categories_count: Json<Record<string, number>>;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  tool_calls: number;
  latency_ms: number | null;
  ttft_ms: number | null;
  cost_rub: ColumnType<string, number | string, number | string>;
  credits_milli: Big;
  billable: boolean;
  mode: string;
  request_hash: string | null;
  created_at: TsDef;
}

export interface LocksTable {
  system_id: string;
  run_id: string;
  holder_user_id: string | null;
  acquired_at: TsDef;
  lease_until: Ts;
}

export interface AuthOtpsTable {
  id: Generated<string>;
  email: string;
  code_hash: string;
  attempts: Generated<number>;
  expires_at: Ts;
  consumed_at: TsNull;
  ip_hash: string | null;
  created_at: TsDef;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  csrf_hash: string;
  expires_at: Ts;
  revoked_at: TsNull;
  /** M2-08: TOTP step-up of a staff session (api.yaml#info.x-auth.M2). */
  mfa_verified_at: TsNull;
  created_at: TsDef;
}

export interface InvitesTable {
  id: Generated<string>;
  org_id: string;
  email: string;
  role: "owner" | "editor" | "viewer";
  token_hash: string;
  invited_by: string;
  expires_at: Ts;
  accepted_at: TsNull;
  revoked_at: TsNull;
  created_at: TsDef;
}

export interface PublicationsTable {
  id: Generated<string>;
  system_id: string;
  env: Generated<string>;
  revision: number;
  schema_revision: number;
  prev_publication_id: string | null;
  migration_plan: Json;
  bundle_key: string;
  status: string;
  run_id: string | null;
  created_by: string;
  live_at: TsNull;
  suspended_reason: string | null;
  created_at: TsDef;
}

/** M1-01, db.yaml#secrets_refs: metadata of connector secrets; the value lives only in the backend. */
export interface SecretsRefsTable {
  id: Generated<string>;
  org_id: string;
  system_id: string;
  env: string;
  name: string;
  backend: string;
  backend_path: string;
  created_by: string | null;
  rotated_at: TsNull;
  created_at: TsDef;
}

/** M1-03, billing.yaml#ledger: append-only (UPDATE/DELETE are refused by a trigger). */
export interface CreditLedgerTable {
  id: ColumnType<string, never, never>;
  org_id: string;
  kind: "grant" | "charge" | "hold" | "release" | "expire" | "refund" | "adjustment";
  amount_milli: Big;
  bucket: "free_welcome" | "free_monthly" | "plan_monthly" | "topup" | "adjustment" | null;
  bucket_expires_at: TsNull;
  run_id: string | null;
  system_id: string | null;
  payment_id: string | null;
  idempotency_key: string;
  note_ru: string | null;
  created_by: string | null;
  created_at: TsDef;
}

export interface ImportsTable {
  id: Generated<string>;
  system_id: string;
  source_sha: string;
  profile: Json | null;
  mapping: Json | null;
  status: string;
  rows_imported: number | null;
  expires_at: Ts;
  created_by: string;
  created_at: TsDef;
}

export interface ExportsTable {
  id: Generated<string>;
  system_id: string;
  env: string;
  run_id: string | null;
  status: string;
  storage_key: string | null;
  size: BigNull;
  download_token_hash: string | null;
  download_token_expires_at: TsNull;
  downloads: Generated<number>;
  expires_at: Ts;
  created_by: string;
  created_at: TsDef;
}

export interface DeletionLogTable {
  id: Generated<string>;
  system_id: string;
  env: string;
  entity: string;
  mode: string;
  cutoff: TsNull;
  rows_affected: number;
  run_id: string | null;
  created_at: TsDef;
}

/** M2-07, billing.yaml#card_binding: a bound card (no PAN — last4 and an HMAC fingerprint of first6/last4/expiry). */
export interface PaymentMethodsTable {
  id: Generated<string>;
  org_id: string;
  provider: Generated<string>;
  provider_method_id: string;
  card_last4: string;
  card_type: string | null;
  issuer_country: string;
  card_fingerprint: string;
  bound_by: string;
  bound_at: TsDef;
  revoked_at: TsNull;
  created_at: TsDef;
}

/** M2-07: payments of the platform shop (card binding 1 ₽, subscription, topup). */
export interface PaymentsTable {
  id: Generated<string>;
  org_id: string;
  kind: "card_binding" | "subscription" | "topup";
  amount_kop: Big;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled" | "refunded";
  provider_payment_id: string | null;
  idempotence_key: string;
  packs: number | null;
  settled_at: TsNull;
  meta: ColumnType<Record<string, unknown>, unknown, unknown>;
  created_at: TsDef;
}

/** M2-07, billing.yaml#recurring: `plan` is the plan of the next period (a downgrade waits for it). */
export interface SubscriptionsTable {
  org_id: string;
  plan: "start" | "business";
  status: "active" | "past_due" | "cancelled";
  payment_method_id: string | null;
  current_period_start: Ts;
  current_period_end: Ts;
  cancel_at_period_end: Generated<boolean>;
  next_charge_at: TsNull;
  failed_attempts: Generated<number>;
}

/** db.yaml#founder_reviews: a revision waiting for staff before prod (abuse.yaml#scoring.effect, G2-AF-08/09). */
export interface FounderReviewsTable {
  system_id: string;
  revision: number;
  status: "pending" | "approved" | "rejected";
  reviewer: string | null;
  note: string | null;
  decided_at: TsNull;
  created_at: TsDef;
}

/** db.yaml#pilot_invites (M2-15): founder invitations of the invite-only registration (WIZARD_REGISTRATION=invite). */
export interface PilotInvitesTable {
  id: Generated<string>;
  email: string;
  org_name: string | null;
  credits: Generated<number>;
  expires_at: Ts;
  accepted_at: TsNull;
  accepted_user_id: string | null;
  org_id: string | null;
  revoked_at: TsNull;
  /** pilot-admin: orgs.require_founder_review set at acceptance (default true). */
  require_founder_review: Generated<boolean>;
  created_at: TsDef;
}

/** db.yaml#ops_alerts (M2-15): founder alerts sent once per key (e.g. llm_cap_80:<yyyy-mm>). */
export interface OpsAlertsTable {
  key: string;
  created_at: TsDef;
}

/** db.yaml#platform_settings (M2-09): platform switches set by the founder's CLI (beta_readiness), with who/when. */
export interface PlatformSettingsTable {
  key: string;
  value: Json;
  updated_by: string;
  updated_at: TsDef;
  created_at: TsDef;
}

/** db.yaml#brand_allowlist: brands the org proved it owns (abuse.yaml#patterns.brands.override, G2-AF-04). */
export interface BrandAllowlistTable {
  org_id: string;
  brand_id: string;
  verified_by: string;
  evidence_note: string;
  created_at: TsDef;
}

export type AbuseCategory =
  | "phishing"
  | "fraud"
  | "brand_impersonation"
  | "illegal_content"
  | "pd_violation"
  | "spam"
  | "other"
  | "auto_g2";
export type AbuseStatus = "new" | "triaged" | "takedown" | "dismissed" | "restored";

/** db.yaml#abuse_reports: «Пожаловаться» tickets (security/abuse.yaml#report, #takedown; M2-08). */
export interface AbuseReportsTable {
  id: Generated<string>;
  system_id: string | null;
  publication_id: string | null;
  url: string;
  category: AbuseCategory;
  text: string | null;
  contact_email: string | null;
  reporter_ip_hash: string | null;
  status: Generated<AbuseStatus>;
  sla_deadline: Ts;
  assignee: string | null;
  resolution_note: string | null;
  resolved_at: TsNull;
  created_at: TsDef;
}

/** db.yaml#staff_audit_log: every staff action (compliance.yaml#platform.security_org). */
export interface StaffAuditLogTable {
  id: Generated<string>;
  actor: string;
  action: string;
  target: string;
  note: string | null;
  created_at: TsDef;
}

/** db.yaml#ai_action_calls (M3-02): one row per runtime AI call id; no record values, no model answers. */
export interface AiActionCallsTable {
  id: string;
  org_id: string;
  system_id: string;
  env: "draft" | "prod";
  action: string;
  call_type: "runtime_ai_extract" | "runtime_ai_generate";
  source: "button" | "workflow" | "backfill";
  status: "pending" | "ok" | "error";
  error_code: string | null;
  credits_milli: Generated<string>;
  finished_at: TsNull;
  created_at: TsDef;
}

/** db.yaml#ai_backfills (M3-02): one-time fill of old records by a change card flag. */
export interface AiBackfillsTable {
  id: Generated<string>;
  system_id: string;
  env: "draft" | "prod";
  action: string;
  run_id: string | null;
  status: Generated<"pending" | "done" | "failed">;
  filled: Generated<number>;
  skipped: Generated<number>;
  stop_code: string | null;
  finished_at: TsNull;
  created_at: TsDef;
}

/** «Написать команде» (D68): copies of client messages for /admin (db.yaml#support_requests). */
export interface SupportRequestsTable {
  id: Generated<string>;
  org_id: string;
  user_id: string | null;
  system_id: string | null;
  screen: string | null;
  text: string;
  wants_team: boolean;
  reply_by: ColumnType<Date, Date | string, Date | string>;
  answered_at: TsNull;
  answered_by: string | null;
  created_at: TsDef;
}

/** «Запросы на развитие» (D73, db.yaml#development_requests). */
export interface DevelopmentRequestsTable {
  id: Generated<string>;
  org_id: string;
  system_id: string | null;
  run_id: string | null;
  user_id: string | null;
  category: string;
  quote: string;
  offered: string | null;
  /** B2-26: the module candidate of the request (weekly rating), open | done (a ready module covers it). */
  candidate_id: string | null;
  status: ColumnType<"open" | "done", "open" | "done" | undefined, "open" | "done">;
  done_at: TsNull;
  created_at: TsDef;
}

/** Status of a module candidate (B2-26, db.yaml#module_candidates). */
export type ModuleCandidateStatus = "new" | "approved" | "disabled" | "ready";

/** db.yaml#module_candidates (B2-26): a group of requests and custom parts in the weekly rating of the module factory. */
export interface ModuleCandidatesTable {
  id: Generated<string>;
  key: string;
  category: string;
  title: string;
  status: ColumnType<ModuleCandidateStatus, ModuleCandidateStatus | undefined, ModuleCandidateStatus>;
  module_id: string | null;
  rank: number | null;
  week_start: TsNull;
  week_requests: Generated<number>;
  week_custom: Generated<number>;
  total_requests: Generated<number>;
  total_custom: Generated<number>;
  systems: Generated<number>;
  clients: Generated<number>;
  examples: Json<{ quote: string; source: "request" | "custom" }[]>;
  last_seen_at: TsNull;
  computed_at: TsNull;
  note: string | null;
  decided_by: string | null;
  decided_at: TsNull;
  ready_at: TsNull;
  created_at: TsDef;
}

/** db.yaml#module_announcements (B2-26): the «Теперь умеем» letter, once per module and client. */
export interface ModuleAnnouncementsTable {
  module_id: string;
  user_id: string;
  candidate_id: string | null;
  system_id: string | null;
  created_at: TsDef;
}

/** db.yaml#destructive_changes (M2-72): owner confirmation of a destructive prod change and its journal. */
export interface DestructiveChangesTable {
  id: Generated<string>;
  system_id: string;
  revision: number;
  base_revision: number | null;
  consequences_hash: string;
  consequences: Json<unknown>;
  status: "confirmed" | "superseded" | "applied" | "undone";
  confirmed_by: string;
  confirmed_at: TsDef;
  archive_tag: string;
  archive_schema: string | null;
  archive_tables: Json<string[]>;
  publication_id: string | null;
  applied_at: TsNull;
  undone_by: string | null;
  undone_at: TsNull;
  undo_run_id: string | null;
  created_at: TsDef;
}

/** db.yaml#system_briefs (V3-02, migration 0036): versions of the system brief with the diff to the previous one. */
export interface SystemBriefsTable {
  system_id: string;
  version: number;
  brief: Json<Record<string, unknown>>;
  diff: Json<unknown[]>;
  author: "agent" | "owner";
  author_user_id: string | null;
  run_id: string | null;
  created_at: TsDef;
}

export interface DB {
  "platform.destructive_changes": DestructiveChangesTable;
  "platform.users": UsersTable;
  "platform.orgs": OrgsTable;
  "platform.memberships": MembershipsTable;
  "platform.systems": SystemsTable;
  "platform.messages": MessagesTable;
  "platform.revisions": RevisionsTable;
  "platform.system_plans": SystemPlansTable;
  "platform.files": FilesTable;
  "platform.runs": RunsTable;
  "platform.run_events": RunEventsTable;
  "platform.gate_reports": GateReportsTable;
  "platform.g1_checks": G1ChecksTable;
  "platform.llm_calls": LlmCallsTable;
  "platform.locks": LocksTable;
  "platform.publications": PublicationsTable;
  "platform.secrets_refs": SecretsRefsTable;
  "platform.auth_otps": AuthOtpsTable;
  "platform.sessions": SessionsTable;
  "platform.invites": InvitesTable;
  "platform.credit_ledger": CreditLedgerTable;
  "platform.imports": ImportsTable;
  "platform.exports": ExportsTable;
  "platform.deletion_log": DeletionLogTable;
  "platform.payment_methods": PaymentMethodsTable;
  "platform.payments": PaymentsTable;
  "platform.subscriptions": SubscriptionsTable;
  "platform.founder_reviews": FounderReviewsTable;
  "platform.brand_allowlist": BrandAllowlistTable;
  "platform.pilot_invites": PilotInvitesTable;
  "platform.ops_alerts": OpsAlertsTable;
  "platform.ai_action_calls": AiActionCallsTable;
  "platform.ai_backfills": AiBackfillsTable;
  "platform.platform_settings": PlatformSettingsTable;
  "platform.abuse_reports": AbuseReportsTable;
  "platform.staff_audit_log": StaffAuditLogTable;
  "platform.support_requests": SupportRequestsTable;
  "platform.development_requests": DevelopmentRequestsTable;
  "platform.module_candidates": ModuleCandidatesTable;
  "platform.module_announcements": ModuleAnnouncementsTable;
  "platform.system_briefs": SystemBriefsTable;
}
