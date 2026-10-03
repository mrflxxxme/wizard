// Gate contracts: specs/quality/gates.yaml#report, specs/architecture.yaml#interfaces.gate_context.

import type { AppSpec } from "@wizard/appspec";
import type postgres from "postgres";
import type { RenderJob, RenderOutcome } from "./g1/render/host.js";
import type { RenderAnswer } from "./g1/render/remote.js";
import type { QaCheck } from "./g1/types.js";

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

/**
 * Handle to a running runtime (architecture.yaml#interfaces.runtime_handle): apps/runtime createRuntimeApp(...)
 * satisfies it structurally; gates never imports apps/runtime.
 */
export interface RuntimeHandle {
  fetch(req: Request): Promise<Response>;
  loadSystem(input: {
    systemKey: string;
    env: "draft" | "prod";
    spec: AppSpec;
    artifactDir?: string | null;
    slug?: string;
  }): Promise<unknown>;
  outbox(): readonly { integration: string; action: string; userId?: string | null; payload: unknown }[];
  /**
   * M1 job runner (runtime.yaml#workflows): workflow triggers, due _w_jobs and retention at `now`; `since` bounds the
   * cron window. Without it the DSL steps runWorkflows/advanceTime report error.
   */
  runJobs?(input: { slug: string; env: "draft" | "prod"; now?: Date; since?: Date }): Promise<JobRunReport>;
  /**
   * M2-19: a page render Worker in the sandbox for this bundle (cluster, WIZARD_SANDBOX=k8s; platform-api executors);
   * absent → the local render process (unsafe-local). close() removes the Worker.
   */
  renderer?(input: { key: string; code: string }): Promise<PageRenderer>;
  readonly env?: { systemsDomain?: string; publicScheme?: string; unsafeLocalExec?: boolean };
}

/** One sandboxed page render Worker (RuntimeHandle.renderer). */
export interface PageRenderer {
  render(job: RenderJob, answer: RenderAnswer, timeoutMs: number): Promise<RenderOutcome>;
  close(): Promise<void>;
}

/** Result of RuntimeHandle.runJobs (apps/runtime RunJobsReport, structurally). */
export interface JobRunReport {
  ran: number;
  failed: readonly { kind: string; name: string; step?: number; stepType?: string; code: string }[];
  retention?: readonly { entity: string; mode: string; rows: number }[];
  pending?: number;
}

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
  /** G1: runtime in test mode (connectors: 'outbox'); without it G1 reports error. */
  runtime?: RuntimeHandle;
  /** G1: DB role the runtime switches to (receives grants on the ephemeral schema). Default wizard_runtime. */
  runtimeRole?: string;
  /** G1: checks from QA (qa.yaml#checks.output); merged over the ones G1 derives from the spec (same id → QA wins). */
  checks?: QaCheck[];
  /** G2-AF-04 identity zone: the system slug (runtime.yaml#routing.system_slug). */
  slug?: string;
  /** G2-SECRET-02 for prod: is the secret set in the vault (existence only, the value is never read). */
  secretExists?: (name: string) => Promise<boolean>;
  /** G2-AF-04 override and G2-AF-08 org signals (abuse.yaml#brands.override, #scoring). */
  abuse?: {
    orgAgeDays?: number;
    plan?: string;
    abuseReportsPrev?: number;
    /** platform.brand_allowlist: brand ids or names the org proved it owns. */
    brandAllowlist?: string[];
  };
  /** Default: env WIZARD_MILESTONE, else M0. */
  milestone?: Milestone | string;
  now?: Date;
  signal?: AbortSignal;
}
