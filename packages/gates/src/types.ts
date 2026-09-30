// Gate contracts: specs/quality/gates.yaml#report, specs/architecture.yaml#interfaces.gate_context.
import type { AppSpec } from "@wizard/appspec";
import type postgres from "postgres";

export type GateLevel = "G0" | "G1" | "G2";
export type Milestone = "M0" | "M1" | "M2" | "M3" | "M4";
export type CheckStatus = "pass" | "fail" | "warn" | "skip" | "error";
export type Severity = "blocker" | "warning";

export interface Check {
  id: string;
  status: CheckStatus;
  severity: Severity;
  message_ru: string;
  file?: string;
  line?: number;
  /** JSON Pointer into the spec. */
  path?: string;
  acId?: string;
  evidence?: string;
  fixHint?: string;
}

export interface GateSummary {
  pass: number;
  fail: number;
  warn: number;
  skip: number;
  error: number;
}

export interface GateReport {
  level: GateLevel;
  passed: boolean;
  specVersion: number;
  startedAt: string;
  durationMs: number;
  checks: Check[];
  summary: GateSummary;
  explanations?: unknown[];
}

/** Handle to a running runtime (G1, M0-11); opaque here. */
export type RuntimeHandle = unknown;

export interface GateContext {
  spec: AppSpec;
  prevSpec: AppSpec | null;
  specVersion: number;
  /** System-relative path → source (ui/**, functions/**). Other paths are ignored. */
  files: ReadonlyMap<string, string>;
  env: "draft" | "prod";
  systemKey: string;
  /** Migrator role; G0 uses it only for the shadow schema inside a rolled-back transaction. */
  db: postgres.Sql;
  runtime?: RuntimeHandle;
  checks?: Check[];
  /** Default: env WIZARD_MILESTONE, else M0. */
  milestone?: Milestone | string;
  now?: Date;
  signal?: AbortSignal;
}
