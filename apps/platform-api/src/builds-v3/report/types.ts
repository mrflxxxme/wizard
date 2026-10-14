// V4-04 (D79 (10), docs/plans/2026-10-11-v4.md §5.3): the report of a v3 build — the acceptance of the founder's build.

/** One HTTP response seen while a goal scenario of the brief was checked in the browser. */
export interface ScenarioHttp {
  scenario: string;
  method: string;
  /** Path and query of the system's own host; other hosts — the origin only. */
  url: string;
  status: number;
  /** document | fetch | xhr. */
  type: string;
  /** Body of a failed API answer (status ≥ 400), redacted, ≤ 500 characters. */
  body?: string;
  /** The request did not get an answer (net::ERR_…). */
  failure?: string;
}

export interface ReportStage {
  stage: string;
  status: string;
  rub: number;
  minutes: number;
  calls?: number;
  fallback?: boolean;
  note?: string;
}

export interface ReportScenario {
  id: string;
  status: string;
  problems: string[];
  http: ScenarioHttp[];
  /** V4-21: promises of its «видит …» steps the site does not show (they went to «Запросы на развитие»). */
  unkept?: string[];
  /** Of `unkept`, those withdrawn for want of the owner's facts (specialists, reviews, prices — D49), not repaired. */
  withdrawn?: string[];
  /** Where its time went (ms): composing, the check (G0, G1, promises) and the repair round; absent — not recorded. */
  timing?: ScenarioTiming;
}

/** The durations of a scenario (ms), from its checkpoint. */
export interface ScenarioTiming {
  totalMs: number;
  composeMs: number;
  checkMs: number;
  g0Ms: number;
  g1Ms: number;
  promisesMs: number;
  repairMs: number;
  repairCheckMs: number;
}

export interface ReportGate {
  level: string;
  revision: number;
  passed: boolean;
  /** Failed or errored checks: id and the Russian message. */
  failed: { id: string; status: string; message: string }[];
}

export interface ReportCall {
  step: string | null;
  callType: string;
  model: string;
  tier: string;
  status: string;
  errorCode: string | null;
  rub: number;
  latencyMs: number | null;
  /** Tokens of the call: all input (cached included), cached input, output, reasoning (part of output). */
  tokens: { input: number; cached: number; output: number; reasoning: number };
}

export interface ReportShot {
  width: 390 | 1440;
  /** Key in the shared file storage (wz_reports/<uuid>). */
  key: string;
  mime: string;
}

export interface BuildReport {
  v: 1;
  runId: string;
  systemId: string | null;
  systemName: string | null;
  orgId: string;
  orgKind: string;
  startedBy: string | null;
  status: string;
  failure: { code: string | null; message: string | null } | null;
  startedAt: string | null;
  finishedAt: string | null;
  minutes: number;
  rub: number;
  stages: ReportStage[];
  scenarios: ReportScenario[];
  gates: ReportGate[];
  critic: {
    scores: number[];
    stop: string | null;
    note: string | null;
    /** The main findings of the critic's last cycle in words («P1 · Услуга 1 без цены · /@390#services»). */
    top?: string[];
    /** Problems of the deterministic checks left after the critic (code, page and section, what is wrong). */
    left?: { code: string; where: string; message: string }[];
    /**
     * Why the last cycle applied nothing: findings without an edit or a patch, and the edits refused with their reason
     * («патч: фрагмент не найден в файле ровно один раз»).
     */
    why?: { noEdit: string[]; rejected: string[] };
  } | null;
  techreview: { status: string | null; blockers: string[]; notes: string[] } | null;
  calls: ReportCall[];
  shots: ReportShot[];
  /** Key of the records of the build's model calls (founder builds; jsonl, V4-03). */
  records: string | null;
  /** Why something of the report could not be collected (the screenshots without a browser…). */
  gaps: string[];
  createdAt: string;
}
