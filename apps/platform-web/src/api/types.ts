// Shapes of specs/platform/api.yaml#/components/schemas (M0 subset) and workflows.yaml#events.types.
import type { Theme } from "@wizard/appspec";

export type { Theme };

export type SystemStage = "interview" | "card" | "building" | "ready" | "failed";

export interface System {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  stage: SystemStage;
  draftRevision: number;
  previewRevision?: number | null;
  prodRevision?: number | null;
  prodUrl?: string | null;
  suspended?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface QuestionOption {
  id: string;
  label: string;
  recommended: boolean;
  description?: string;
}

export interface Question {
  id: string;
  forkId: string;
  text: string;
  whyItMatters: string;
  options: QuestionOption[];
  allowCustom?: boolean;
}

export interface Answer {
  questionId: string;
  optionId?: string;
  text?: string;
}

export type MessageKind = "text" | "questions" | "answers" | "card" | "run_report" | "notice";

/** api.yaml#postMessage.target (M3-01): an element picked in the preview (ui-kit.yaml#wz_id). */
export interface MessageTarget {
  wzId: string;
  componentName: string;
  file: string;
  line: number;
  route?: string;
}

export interface Message {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  kind: MessageKind;
  text?: string;
  payload?: Record<string, unknown>;
  runId?: string | null;
  createdAt: string;
}

/** orchestrator.yaml#system_card; the API guarantees cardVersion, kind, estimate, cap. */
export interface SystemCard {
  cardVersion: number;
  kind: "create" | "change";
  title?: string;
  summary?: string;
  roles?: { name: string; label: string; access?: string; description?: string; can?: string[] }[];
  data?: { name: string; label: string; fields?: { label: string; kind?: string }[]; pii?: string }[];
  specVsCode?: { spec?: string[]; code?: string[] };
  screens?: { route: string; title: string; roles?: string[]; purpose?: string }[];
  integrations?: { connector: string; purpose?: string; userActionRequired?: string }[];
  automations?: { name: string; when?: string; then?: string }[];
  acceptance?: { id: string; text: string }[];
  pii?: {
    categories?: string[];
    summary?: string;
    retention?: { entity: string; deleteAfterDays?: number; humanText?: string }[];
  };
  estimate: {
    credits?: { min?: number; expected?: number; max?: number };
    minutes?: { min?: number; max?: number };
  };
  cap: { credits: number };
  assumptions?: string[];
  outOfScope?: string[];
  forkAnswers?: {
    questionId: string;
    forkId?: string;
    optionId?: string;
    text?: string;
    byRecommendation?: boolean;
  }[];
}

export type RunKind =
  | "interview_turn"
  | "build"
  | "publish"
  | "rollback"
  | "import_table"
  | "retention"
  | "nightly_eval"
  | "export";
export type RunStatus =
  | "queued"
  | "waiting_lock"
  | "running"
  | "needs_input"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Run {
  id: string;
  systemId?: string | null;
  kind: RunKind;
  mode?: "create" | "change" | "fix" | "point_edit";
  status: RunStatus;
  currentStep?: string | null;
  credits?: { estimate?: number; cap?: number; used?: number };
  baseRevision?: number | null;
  resultRevision?: number | null;
  failure?: { code: string; message_ru: string } | null;
  lastEventSeq?: number;
  createdAt: string;
}

export interface RevisionSummary {
  version: number;
  parentVersion?: number | null;
  author: "user" | "agent" | "system";
  kind?: "ops" | "files" | "style" | "revert" | "compliance";
  runId?: string | null;
  summary_ru?: string;
  g0Passed?: boolean | null;
  createdAt: string;
}

export interface Revision extends RevisionSummary {
  spec: { theme?: Theme; [k: string]: unknown };
  ops: unknown[];
  files: { path: string; sha256: string; size: number }[];
}

export type GateLevel = "G0" | "G1" | "G2";

export interface GateCheck {
  id: string;
  status: "pass" | "fail" | "warn" | "skip" | "error";
  severity: "blocker" | "warning";
  message_ru: string;
  file?: string;
  line?: number;
  acId?: string;
  fixHint?: string;
}

export interface GateReport {
  level: GateLevel;
  passed: boolean;
  specVersion?: number;
  durationMs?: number;
  summary?: { pass?: number; fail?: number; warn?: number; skip?: number; error?: number };
  checks: GateCheck[];
}

export interface PreviewUrl {
  url: string;
  revision: number;
  roles: { name: string; label?: string }[];
  expiresAt: string;
}

export interface SystemView {
  system: System;
  card?: SystemCard | null;
  pendingQuestions?: Question[];
  messages: Message[];
  activeRunId?: string | null;
  publishBlockers?: string[];
}

/** api.yaml#OrgSettings (GET served from M0 by M0-30). */
export interface OrgSettings {
  ruOnly?: boolean;
  buildModelLabel?: string;
  t1Restricted?: boolean;
}

export interface ApiErrorBody {
  code: string;
  message_ru: string;
  details?: Record<string, unknown>;
}

export interface RunEvent {
  runId: string;
  seq: number;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

export type OrgRole = "owner" | "editor" | "viewer";

/** api.yaml#User */
export interface User {
  id: string;
  email: string;
  name?: string | null;
  isStaff?: boolean;
}

/** GET /me memberships[] */
export interface Membership {
  orgId: string;
  orgName: string;
  role: OrgRole;
}

export interface Me {
  user: User;
  memberships: Membership[];
}

/** api.yaml#Member */
export interface Member {
  userId: string;
  email: string;
  name?: string | null;
  role: OrgRole;
  joinedAt?: string;
}

/** api.yaml#Invite */
export interface Invite {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: string;
}

/** api.yaml#listDeletionLog item: counters only, never values (compliance.yaml#system_package.retention). */
export interface DeletionLogEntry {
  env: "draft" | "prod";
  entity: string;
  mode: string;
  cutoff: string | null;
  rowsAffected: number;
  createdAt: string;
}

/** DELETE /systems/:id (M2-05): soft delete, purge after 30 days (workflows.yaml#delete_system). */
export interface SystemDeleted {
  id: string;
  deletedAt: string;
  purgeAfter: string;
}

/** api.yaml#LockStatus */
export interface LockStatus {
  held: boolean;
  runId?: string | null;
  holder?: { userId: string; name: string } | null;
  since?: string | null;
  queue?: string[];
}

/** api.yaml#Publication */
export interface Publication {
  id: string;
  env: "prod";
  revision: number;
  schemaRevision?: number;
  status: "planned" | "applying" | "live" | "superseded" | "failed" | "suspended";
  migrationSteps?: number;
  createdAt: string;
}

export type DiffKind =
  | "entity"
  | "field"
  | "role"
  | "permission"
  | "page"
  | "workflow"
  | "integration"
  | "function"
  | "theme"
  | "compliance"
  | "file";

/** GET /systems/:id/revisions/:v/diff changes[] */
export interface DiffChange {
  kind: DiffKind;
  text_ru: string;
  destructive?: boolean;
}

/** api.yaml#ImportColumnMapping */
export interface ImportColumnMapping {
  column: string;
  action: "map" | "skip" | "new_field";
  entity?: string;
  field?: string;
  pii?: "none" | "basic";
}

/** getImport profile item: column statistics only, never cell values (data-boundary.yaml#import). */
export interface ImportProfileItem {
  column: string;
  sheet?: string;
  typeGuess: string;
  piiKindGuess: string | null;
  nullShare: number;
  distinct: number;
}

export type ImportStatus =
  | "profiling"
  | "mapping"
  | "awaiting_confirm"
  | "importing"
  | "done"
  | "failed"
  | "expired";

/** GET /systems/:id/imports/:importId */
export interface ImportView {
  id: string;
  status: ImportStatus;
  runId: string | null;
  /** needs_input of decisionId=import_confirm. */
  inputId: string | null;
  profile: ImportProfileItem[];
  mapping: ImportColumnMapping[];
  rowsImported: number | null;
}

/** billing.yaml#plans; pilot — assigned only by the founder's CLI (M2-15). */
export type PlanId = "free" | "pilot" | "start" | "business";

/**
 * api.yaml#Org (GET /orgs/:orgId, viewer): plan, whether a RU card is bound (M2-07) and whether the platform takes
 * payments at all (WIZARD_PAYMENTS, M2-15; absent — on).
 */
export interface Org {
  id: string;
  name: string;
  plan: PlanId;
  role?: OrgRole;
  cardBound?: boolean;
  paymentsEnabled?: boolean;
}

/** api.yaml#CreditBalance: credits with 0.001 precision, rounded to 0.1 only in UI (billing.yaml#credit.unit). */
export interface CreditBalance {
  balance: number;
  held: number;
  available: number;
  buckets?: { source: string; remaining: number; expiresAt: string | null }[];
}

/** api.yaml#LedgerEntry: + grant, − charge. */
export interface LedgerEntry {
  id: string;
  kind: "grant" | "charge" | "hold" | "release" | "expire" | "refund" | "adjustment";
  amount: number;
  source?: string;
  runId?: string | null;
  systemId?: string | null;
  note_ru?: string;
  createdAt: string;
}

/**
 * api.yaml#Billing plus the M2-07 extensions (docs/reviews/impl-notes/M2-07.md): nextPlan (a downgrade waiting for the
 * period end), cardBinding (outcome of the latest binding, polled by the YooKassa return page), confirmationUrl
 * (first subscription payment on the YooKassa page).
 */
export interface Billing {
  plan: PlanId;
  status: "none" | "active" | "past_due" | "cancelled";
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  nextPlan?: "start" | "business" | null;
  card: { last4: string; issuerCountry: string; boundAt: string; cardType?: string | null } | null;
  cardBinding?: {
    status: "pending" | "bound" | "rejected" | "cancelled";
    code: string | null;
    message_ru: string | null;
  } | null;
  limits: { prodSystems: number; members: number; monthlyCredits: number };
  /** WIZARD_PAYMENTS (M2-15): false — payment operations answer 403 PAYMENTS_DISABLED. */
  paymentsEnabled?: boolean;
  confirmationUrl?: string | null;
}

/** api.yaml#Export (+ includePii, M2-10) with getExport.downloadUrl (single use, 15 min). */
export interface ExportView {
  id: string;
  env: "draft" | "prod";
  status: "running" | "ready" | "failed" | "expired";
  size?: number | null;
  downloads?: number;
  includePii?: boolean;
  expiresAt?: string;
  createdBy?: string;
  createdAt: string;
  downloadUrl?: string | null;
}

/** M2-08: api.yaml#createAbuseReport categories. */
export type AbuseCategory =
  | "phishing"
  | "fraud"
  | "brand_impersonation"
  | "illegal_content"
  | "pd_violation"
  | "spam"
  | "other";
export type AbuseStatus = "new" | "triaged" | "takedown" | "dismissed" | "restored";

/** api.yaml#AbuseReport (+ url, resolvedAt, systemName of the queue). */
export interface AbuseReport {
  id: string;
  systemId: string | null;
  category: AbuseCategory | "auto_g2";
  status: AbuseStatus;
  slaDeadline: string;
  createdAt: string;
  url: string;
  resolvedAt: string | null;
  systemName?: string | null;
}

/** api.yaml#AbuseTicket (staff). */
export interface AbuseTicket extends AbuseReport {
  text: string | null;
  contactEmail: string | null;
  resolutionNote: string | null;
  system: {
    id: string;
    name: string | null;
    orgId: string | null;
    prodUrl: string | null;
    suspended: boolean;
    /** orgs.suspended_at is set (abuse.yaml#takedown.flow, org-wide suspension). */
    orgSuspended?: boolean;
  } | null;
  access: { until: string } | null;
  journal: { action: string; note: string | null; actor: string; at: string }[];
}

/** api.yaml#StaffSession. */
export interface StaffSession {
  email?: string;
  isStaff: boolean;
  mfaEnrolled: boolean;
  mfaVerifiedUntil: string | null;
}

/** api.yaml#PilotReadiness (staff console «Пилот»). */
export interface PilotReadiness {
  on: boolean;
  by: string | null;
  at: string | null;
  note: string | null;
  checklist: { id: string; text: string }[];
}

/** api.yaml#PilotInvite. */
export interface PilotInvite {
  id: string;
  email: string;
  orgName: string | null;
  credits: number;
  requireFounderReview: boolean;
  status: "sent" | "accepted" | "expired";
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  orgId: string | null;
}

/** api.yaml#PilotOrg. */
export interface PilotOrg {
  id: string;
  name: string;
  plan: string;
  members: number;
  requireFounderReview: boolean;
  creditsAvailable: number;
  creditsSpentMonth: number;
  modelSpendRub: number;
}

/** api.yaml#LlmSpend. */
export interface LlmSpend {
  month: string;
  spentRub: number;
  capRub: number;
  sharePercent: number;
  warn: boolean;
  reached: boolean;
}

/** api.yaml#adminSystemData. */
export interface StaffData {
  env: "draft" | "prod";
  revision: number | null;
  accessUntil?: string;
  omittedPii?: number;
  entities: { name: string; label: string; rows: number }[];
  entity: string | null;
  columns: string[];
  rows: Record<string, string | null>[];
}

/** api.yaml#adminListFounderReviews item. */
export interface FounderReviewItem {
  systemId: string;
  systemName: string;
  orgId: string;
  revision: number;
  createdAt: string;
}
