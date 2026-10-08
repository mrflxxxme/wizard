// Shapes of specs/platform/api.yaml#/components/schemas (M0 subset) and workflows.yaml#events.types.
import type { BriefDiagrams, BriefVersion, SystemBrief, Theme } from "@wizard/appspec";

export type { BriefDiagrams, BriefVersion, SystemBrief, Theme };

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

export type MessageKind = "text" | "questions" | "answers" | "card" | "run_report" | "notice" | "plan";

/** api.yaml#postMessage.target (M3-01): an element picked in the preview (ui-kit.yaml#wz_id). */
export interface MessageTarget {
  wzId: string;
  componentName: string;
  file: string;
  line: number;
  route?: string;
}

/** api.yaml#postMessage.block (B2-29): the canvas block a wish is about («ткни и скажи»). */
export interface MessageBlock {
  id: string;
  title: string;
  module?: string;
  sectionIndex?: number;
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
  /** B2-02: the org replays recorded model answers (no spend). */
  demoReplay?: boolean;
  /** B2-25: modules — the canvas screen (beta v2 plan), legacy (or absent) — the v1 workspace. */
  pipeline?: "legacy" | "modules";
}

/**
 * B2-20 goal interview question (pendingQuestions of a modules-pipeline system): button options with one recommended;
 * topic=params names the module parameter the answer sets.
 */
export interface GoalQuestion {
  id: string;
  topic?: "goals" | "niche" | "roles" | "resources" | "params";
  module?: string;
  param?: string;
  text: string;
  whyItMatters?: string;
  options: { id: string; label: string; recommended: boolean; description?: string }[];
  allowCustom?: boolean;
}

/** One automation chain of the sketch (api.yaml#PlanSketch.automations, B2-25). */
export interface SketchAutomation {
  name: string;
  label: string | null;
  module?: string;
  trigger: { type: string; entity?: string; entityLabel?: string; offsetMinutes?: number; cron?: string };
  steps: { type: string; entity?: string; entityLabel?: string; channel?: string; to?: string }[];
}

/** api.yaml#PlanSketch (B2-20, B2-25): what the plan compiles to, for the canvas. */
export interface PlanSketch {
  stage: "interview" | "plan";
  niche: string;
  goals: { id: string; label: string; statement: string; modules: string[] }[];
  modules: {
    id: string;
    name: string;
    summary?: string;
    goals: string[];
    status: "available" | "soon";
    /** type and options (enum, enum_list) — B2-29: toggles of a module screen. */
    params: {
      name: string;
      label: string;
      value?: unknown;
      type?: string;
      options?: { value: string; label: string }[];
    }[];
  }[];
  roles: { name: string; label: string; access: string }[];
  entities: { name: string; label: string; fields: { name: string; label: string; type: string }[] }[];
  screens: {
    route: string;
    title: string;
    audience: "public" | "cabinet";
    roles: string[];
    module?: string;
  }[];
  /** variants — ready layout variants of the type (B2-29: «Другой вид»). */
  sections: {
    index: number;
    type: string;
    label: string;
    variant: string;
    variants?: string[];
    title?: string;
  }[];
  metrics: { id: string; label: string; goal: string; module: string; unit: string }[];
  scenarios: { id: string; title: string; goal: string; module: string }[];
  outOfScope: { request: string; replacement: string; category: string; module?: string }[];
  custom: { id: string; title: string; kind: string; budgetRub: number }[];
  accent?: string | null;
  /** Design direction of the plan (B2-37): theme, mood, voice, fonts, photo style, palette; null in the interview. */
  design?: {
    theme: string;
    themeName: string;
    mood: string[];
    rhythm: string;
    voice: string;
    fonts: { heading: string; body: string };
    photoStyle: string;
    palette: { accent: string; accentText: string; onAccent: string; bg: string; band: string; ink: string };
  } | null;
  automations?: SketchAutomation[];
  access?: {
    role: string;
    roleLabel: string;
    entity: string;
    entityLabel: string;
    scope: "all" | "own" | "some";
  }[];
  retention?: { entity: string; entityLabel: string; days: number; mode: "delete" | "anonymize" }[];
  warnings: string[];
  errors: { code: string; path?: string; message_ru: string; hint?: string }[];
  fingerprint: string | null;
}

/** api.yaml#PlanEdit (B2-20): the deterministic edits the canvas sends («ткни и скажи», B2-29). */
export type PlanEdit =
  | { op: "set_param"; module: string; param: string; value: unknown }
  | { op: "remove_module"; module: string }
  | {
      op: "add_section";
      type: string;
      variant?: string;
      content?: Record<string, unknown>;
      at?: number;
    }
  | { op: "update_section"; index: number; variant?: string }
  | { op: "remove_section"; index: number }
  | { op: "move_section"; from: number; to: number };

/** api.yaml#SystemPlanRevision (B2-20). */
export interface SystemPlanRevision {
  revision: number;
  status: "awaiting_approval" | "approved" | "superseded";
  source?: string;
  plan: Record<string, unknown>;
  errors: { code: string; path?: string; message_ru: string; hint?: string }[];
  sketch: PlanSketch | null;
  fingerprint: string | null;
  createdAt?: string;
  approvedAt?: string | null;
  buildRunId?: string | null;
  /** true — a preview of editSystemPlan, not saved. */
  dryRun?: boolean;
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
  /** B2-02: demo replay of a staff org; the recorded scenarios come with it. */
  demoReplay?: boolean;
  demoScenarios?: DemoScenario[];
}

/** B2-02: a recorded scenario (tools/fixtures/demo/<name>.jsonl) offered as a brief on S1. */
export interface DemoScenario {
  name: string;
  title: string;
  brief: string;
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
  /** D70: the pilot limit (builds and edits in 30 days). */
  usage?: PilotUsage;
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

/** api.yaml#PilotCounter (D70): limit null — the org is not on the pilot. */
export interface PilotCounter {
  limit: number | null;
  used: number;
  left: number | null;
  nextAt: string | null;
}

/** api.yaml#PilotUsage (getOrgUsage): «На пилоте бесплатно» and what is left, no credits. */
export interface PilotUsage {
  pilot: boolean;
  free: boolean;
  builds: PilotCounter;
  edits: PilotCounter;
}

/** api.yaml#SupportRequest (/admin «Обращения»). */
export interface SupportRequestItem {
  id: string;
  orgId: string;
  orgName: string;
  email: string | null;
  systemId: string | null;
  systemName: string | null;
  screen: string | null;
  text: string;
  wantsTeam: boolean;
  createdAt: string;
  replyBy: string;
  answeredAt: string | null;
}

/** api.yaml#DevelopmentCategory. */
export type DevelopmentCategory =
  | "payments"
  | "subscriptions"
  | "integration"
  | "messaging"
  | "design"
  | "domain"
  | "media"
  | "data"
  | "mobile"
  | "ai"
  | "other";

/** api.yaml adminDevelopmentRequests. */
export interface DevelopmentRequests {
  categories: {
    category: DevelopmentCategory;
    last7: number;
    last30: number;
    total: number;
    systems: number;
    lastAt: string;
  }[];
  items: {
    id: string;
    category: DevelopmentCategory;
    quote: string;
    offered: string | null;
    createdAt: string;
    orgId: string;
    orgName: string;
    systemId: string | null;
    systemName: string | null;
    email: string | null;
    /** B2-26: done — a ready module covers the request (module factory). */
    status?: "open" | "done";
    doneAt?: string | null;
    candidateId?: string | null;
  }[];
}

/** api.yaml#ModuleCandidate (B2-26): a candidate in the weekly rating of the module factory. */
export interface ModuleCandidate {
  id: string;
  key: string;
  category: DevelopmentCategory;
  title: string;
  status: "new" | "approved" | "disabled" | "ready";
  moduleId: string | null;
  moduleName: string | null;
  rank: number | null;
  weekRequests: number;
  weekCustom: number;
  totalRequests: number;
  totalCustom: number;
  systems: number;
  clients: number;
  examples: { quote: string; source: "request" | "custom" }[];
  lastSeenAt: string | null;
  computedAt: string | null;
  note: string | null;
  decidedAt: string | null;
  readyAt: string | null;
  suggested: { id: string; name: string; status: "ready" | "draft" } | null;
}

/** api.yaml#CatalogModuleRef (B2-26). */
export interface CatalogModuleRef {
  id: string;
  name: string;
  summary: string;
  status: "ready" | "draft";
  available: boolean;
}

/** api.yaml adminModuleCandidates status filter. */
export type CandidateFilter = "open" | "new" | "approved" | "disabled" | "ready" | "all";

/** api.yaml adminModuleCandidates. */
export interface ModuleCandidates {
  computedAt: string | null;
  items: ModuleCandidate[];
  modules: CatalogModuleRef[];
}

/** api.yaml adminModuleCandidate. */
export interface ModuleCandidateCard {
  candidate: ModuleCandidate;
  requests: {
    id: string;
    quote: string;
    status: "open" | "done";
    createdAt: string;
    doneAt: string | null;
    systemId: string | null;
    systemName: string | null;
  }[];
  notified: number;
}

/** api.yaml adminDecideModuleCandidate. */
export interface ModuleCandidateDecision {
  candidate: ModuleCandidate;
  announced: { done: number; sent: number; noConsent: number; failed: number } | null;
}

/** api.yaml#UpdatesConsent (B2-26): letters about new abilities. */
export interface UpdatesConsent {
  on: boolean;
  since: string | null;
}

/** api.yaml#/components/schemas/DestructiveConsequence (M2-72). */
export interface DestructiveConsequence {
  kind: "drop_table" | "drop_column" | "alter_column_type" | "set_not_null" | "alter_check";
  entity: string;
  entityLabel: string;
  field?: string;
  fieldLabel?: string;
  affected: number;
  unconvertible: number;
  archived: boolean;
  blocking: boolean;
  text_ru: string;
}

/** api.yaml#/components/schemas/DestructiveConsequences (GET /systems/:id/destructive). */
export interface DestructiveConsequences {
  revision: number;
  baseRevision: number | null;
  required: boolean;
  blocking: boolean;
  hash: string | null;
  changes: DestructiveConsequence[];
  confirmation?: { status: "confirmed" | "stale"; confirmedAt: string } | null;
  canConfirm?: boolean;
}

/** api.yaml#/components/schemas/DestructiveChangeRecord: a row of the journal of destructive changes. */
export interface DestructiveChangeRecord {
  id: string;
  revision: number;
  baseRevision: number | null;
  status: "confirmed" | "superseded" | "applied" | "undone";
  consequences: DestructiveConsequence[];
  confirmedBy: string;
  confirmedAt: string;
  appliedAt: string | null;
  undoneBy: string | null;
  undoneAt: string | null;
  undoRunId: string | null;
  undoable: boolean;
}

/** GET /systems/:id/destructive/changes. */
export interface DestructiveJournal {
  items: DestructiveChangeRecord[];
  undo: { changeId: string; toRevision: number } | null;
  canUndo: boolean;
}

/** V3-02 GET/PUT /systems/:id/brief: the latest version (or ?version=N) with its three diagrams; null before the interview. */
export interface BriefView {
  brief: BriefVersion | null;
  diagrams: BriefDiagrams | null;
  /** PUT only: false — the brief equals the latest version, nothing was written. */
  changed?: boolean;
}

/** V3-02 GET /systems/:id/brief/versions: newest first, without the briefs. */
export interface BriefVersions {
  versions: Omit<BriefVersion, "brief">[];
  nextBefore: number | null;
}

/** V3-06 api.yaml#SystemSession: the interview, a build or an edit of the brief. */
export interface SystemSession {
  id: string;
  kind: "interview" | "build" | "edit";
  source: "chat" | "panel" | null;
  status: "running" | "waiting" | "done" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  runIds: string[];
  briefVersions: number[];
  changes: string[];
  changesTotal: number;
  build: { mode: string | null; revision: number | null; failure: string | null } | null;
}
