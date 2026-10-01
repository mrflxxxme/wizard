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
  deleted_at: TsNull;
  pd_consent_at: TsNull;
  offer_accepted_at: TsNull;
  offer_version: string | null;
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
  created_at: TsDef;
}

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

export interface DB {
  "platform.users": UsersTable;
  "platform.orgs": OrgsTable;
  "platform.memberships": MembershipsTable;
  "platform.systems": SystemsTable;
  "platform.messages": MessagesTable;
  "platform.revisions": RevisionsTable;
  "platform.files": FilesTable;
  "platform.runs": RunsTable;
  "platform.run_events": RunEventsTable;
  "platform.gate_reports": GateReportsTable;
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
  "platform.payment_methods": PaymentMethodsTable;
  "platform.payments": PaymentsTable;
  "platform.subscriptions": SubscriptionsTable;
}
