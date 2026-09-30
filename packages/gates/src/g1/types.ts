// Scenario DSL (specs/quality/gates.yaml#scenario_dsl) and QA checks (specs/agents/qa.yaml#checks.output).
import type { PermissionOp } from "@wizard/appspec";

export type Value = unknown;

export interface Expect {
  status?: "ok" | "created" | "denied" | "not_found" | "invalid" | "conflict" | "limit" | number;
  error?: string;
  fields?: Record<string, Value>;
  absentFields?: string[];
  count?: number | { gte?: number; lte?: number };
  outbox?: { connector: string; count?: number; to?: string; containsFields?: string[] };
}

export interface Step {
  as?: string | { role: string };
  create?: { entity: string; data: Record<string, Value>; save?: string };
  read?: { entity: string; id?: Value; where?: Record<string, Value>; save?: string };
  update?: { entity: string; id: Value; data: Record<string, Value>; save?: string };
  delete?: { entity: string; id: Value };
  callFn?: { name: string; args?: Record<string, Value>; save?: string };
  simulate?: { connector: string; event: string; data?: Record<string, Value> };
  runWorkflows?: Record<string, never>;
  advanceTime?: { minutes: number };
  expect?: Expect;
  consent?: true;
}

export interface Scenario {
  id: string;
  acId?: string;
  title: string;
  actors: Record<string, { role: string }>;
  milestone?: string;
  seed?: "default" | "none";
  steps: Step[];
}

/** PC-<role>-<entity>-<op> | -row | -hidden | -ro | -consent (qa.yaml#checks.permission_auto; consent: compliance.yaml#system_package.consent.gates). */
export type PermissionProbe =
  | { kind: "op"; op: PermissionOp; expect: "allow" | "deny" }
  | { kind: "row" }
  | { kind: "hidden"; fields: string[] }
  | { kind: "ro"; fields: string[] }
  | { kind: "consent" };

/** A check as QA hands it to G1 (qa.yaml#checks.output). */
export interface QaCheck {
  id: string;
  acId?: string;
  kind: "permission" | "scenario" | "constraint";
  level: "G1" | "G2";
  /** kind=permission. */
  role?: string;
  entity?: string;
  probe?: PermissionProbe;
  /** kind=scenario|constraint. */
  scenario?: Scenario;
  /** AC milestone (no field = M0). */
  milestone?: string;
}

export interface SeedUser {
  id: string;
  role: string;
  display_name: string;
  email: string;
  phone: string;
}

/** Output of generateSeed (qa.yaml#seed): synthetic users (2 per login role) and 3–10 rows per entity. */
export interface Seed {
  key: string;
  /** $now the dates are relative to (ISO). */
  now: string;
  users: SeedUser[];
  /** Entity → rows (each has `id`); insertion order is `order`. */
  rows: Record<string, Record<string, unknown>[]>;
  order: string[];
}
