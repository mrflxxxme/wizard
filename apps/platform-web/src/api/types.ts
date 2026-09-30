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
