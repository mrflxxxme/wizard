// Migration planning and SQL generation. Source: specs/appspec/ops.yaml#migrations.
//
// Usage (all statements of one plan in ONE transaction; the first statement is SET LOCAL lock_timeout):
//   const plan = planMigration(prev, next, { env });
//   if (plan.errors.length) -> block publication (G0)
//   await sql.begin(async (tx) => { for (const s of toDDL(plan, schema, { runtimeRole })) await tx.unsafe(s); });
// Runtime queries then run inside a transaction with
//   SET LOCAL ROLE <runtimeRole>; select set_config('wizard.role', $1, true), set_config('wizard.user_id', $2, true)
// ($user.<attr> in rowFilter reads set_config('wizard.user_<attr>', ..., true)).
import { err, type OpsError } from "./errors.js";
import { SYSTEM_FIELDS } from "./reserved.js";
import {
  type AppSpec,
  type Entity,
  type Field,
  type FieldType,
  type PermissionOp,
  validateSpec,
} from "./schema.js";
import { SYSTEM_FIELD_TYPES, USER_REF_RE } from "./semantic.js";
import {
  dollarQuote,
  FORMAT_RE,
  type LiteralType,
  quoteIdent,
  SqlValueError,
  sqlLiteral,
  textLiteral,
} from "./sql.js";

export { quoteIdent } from "./sql.js";
/** @deprecated use sqlLiteral(value, type) or textLiteral(value) from ./sql.js. */
export const quoteLiteral = textLiteral;

type Base<K extends string, D extends boolean> = { kind: K; destructive: D };

export type MigrationStep =
  | Base<"create_schema", false>
  | (Base<"create_table", false> & { entity: Entity })
  | (Base<"add_column", false> & { entity: string; field: Field; notNull: boolean })
  | (Base<"set_default", false> & { entity: string; field: Field })
  | (Base<"relax_not_null", false> & { entity: string; field: string })
  | (Base<"set_not_null", true> & { entity: string; field: Field })
  | (Base<"alter_enum_add_value" | "relax_check", false> & {
      entity: string;
      name: string;
      expr: string | null;
    })
  | (Base<"alter_check", true> & { entity: string; name: string; expr: string | null })
  | (Base<"add_unique", false> & { entity: string; field: string; name: string })
  | (Base<"drop_unique", true> & { entity: string; name: string })
  | (Base<"add_fk", false> & {
      entity: string;
      field: string;
      target: string;
      onDelete: OnDelete;
      name: string;
    })
  | (Base<"drop_fk", true> & { entity: string; name: string })
  | (Base<"add_index", false> & { entity: string; name: string; fields: string[]; unique: boolean })
  | (Base<"drop_index", true> & { name: string })
  | (Base<"drop_column", true> & { entity: string; field: string })
  | (Base<"drop_table", true> & { entity: string })
  | (Base<"alter_column_type", true> & { entity: string; field: Field; from: FieldType; notNull: boolean })
  | Base<"set_rls", false>;

export type StepKind = MigrationStep["kind"];
type OnDelete = "restrict" | "cascade" | "set_null";

export interface MigrationPlan {
  env: "draft" | "prod";
  steps: MigrationStep[];
  /** true when no step is destructive (the only kind allowed in prod). */
  additiveOnly: boolean;
  destructive: MigrationStep[];
  /** Validation errors of `next` and DESTRUCTIVE_IN_PROD; non-empty → toDDL refuses. */
  errors: OpsError[];
  /** Spec the plan migrates to (source for set_rls). */
  next: AppSpec;
}

/** Context role for platform-side access (ctx.systemDb, workflows, retention). */
export const SYSTEM_ROLE = "__system";
const SYSTEM_ROLE_COND = `current_setting('wizard.role', true) = ${textLiteral(SYSTEM_ROLE)}`;

/**
 * Tables created in every system schema by create_schema (runtime.yaml#postgres.system_tables).
 * Names are not valid AppSpec identifiers (users is reserved, `_w_` cannot start an ident), so no clashes.
 */
export const SYSTEM_TABLES: Record<string, string[]> = {
  users: [
    `"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
    `"role" text NOT NULL`,
    `"display_name" text`,
    `"phone" text UNIQUE`,
    `"email" text UNIQUE`,
    `"telegram_id" bigint UNIQUE`,
    `"telegram_chat_id" bigint`,
    `"attrs" jsonb NOT NULL DEFAULT '{}'`,
    `"invited_by" uuid`,
    `"created_at" timestamptz NOT NULL DEFAULT now()`,
    `"blocked_at" timestamptz`,
    `"last_login_at" timestamptz`,
  ],
  _w_sessions: [
    `"token_hash" bytea PRIMARY KEY`,
    `"user_id" uuid NOT NULL`,
    `"created_at" timestamptz NOT NULL DEFAULT now()`,
    `"last_seen_at" timestamptz`,
    `"expires_at" timestamptz NOT NULL`,
  ],
  _w_otp: [
    `"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
    `"channel" text NOT NULL`,
    `"destination_hash" bytea NOT NULL`,
    `"code_hash" bytea NOT NULL`,
    `"attempts" integer NOT NULL DEFAULT 0`,
    `"expires_at" timestamptz NOT NULL`,
  ],
  _w_jobs: [
    `"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
    `"kind" text NOT NULL CHECK ("kind" IN ('function', 'workflow_step', 'retention'))`,
    `"payload" jsonb NOT NULL DEFAULT '{}'`,
    `"run_at" timestamptz NOT NULL DEFAULT now()`,
    `"attempts" integer NOT NULL DEFAULT 0`,
    `"locked_until" timestamptz`,
    `"idempotency_key" text UNIQUE`,
  ],
  _w_connector_calls: [
    `"idempotency_key" text PRIMARY KEY`,
    `"integration" text NOT NULL`,
    `"action" text NOT NULL`,
    `"status" text NOT NULL`,
    `"result" jsonb`,
    `"created_at" timestamptz NOT NULL DEFAULT now()`,
  ],
  _w_qr_events: [
    `"client_event_id" text PRIMARY KEY`,
    `"device_id" text NOT NULL`,
    `"integration" text NOT NULL`,
    `"result" text NOT NULL`,
    `"clock_skew" boolean NOT NULL DEFAULT false`,
    `"received_at" timestamptz NOT NULL DEFAULT now()`,
  ],
  _w_qr_devices: [
    `"device_id" text PRIMARY KEY`,
    `"user_id" uuid`,
    `"last_sync_at" timestamptz`,
    `"pending" integer NOT NULL DEFAULT 0`,
  ],
  _w_telegram_links: [
    `"token_hash" bytea PRIMARY KEY`,
    `"user_id" uuid NOT NULL`,
    `"expires_at" timestamptz NOT NULL`,
  ],
  _w_consents: [
    `"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
    `"entity" text NOT NULL`,
    `"row_id" uuid NOT NULL`,
    `"policy_version" text NOT NULL`,
    `"consent_text_hash" bytea NOT NULL`,
    `"given_at" timestamptz NOT NULL DEFAULT now()`,
    `"ip_hmac" bytea`,
  ],
  // Deletion journal of the system (counters only, no values): retention, consent withdrawal, subject requests.
  // The platform moves it into platform.deletion_log (security/compliance.yaml#system_package.retention).
  _w_deletion_log: [
    `"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`,
    `"at" timestamptz NOT NULL DEFAULT now()`,
    `"entity" text NOT NULL`,
    `"mode" text NOT NULL CHECK ("mode" IN ('delete', 'anonymize', 'retention', 'consent_revoked', 'subject_request'))`,
    `"cutoff" timestamptz`,
    `"rows_affected" integer NOT NULL`,
    `"fields" text[] NOT NULL DEFAULT '{}'`,
  ],
  _w_audit: [
    `"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`,
    `"at" timestamptz NOT NULL DEFAULT now()`,
    `"actor_user_id" uuid`,
    `"role" text`,
    `"entity" text NOT NULL`,
    `"record_id" uuid`,
    `"op" text NOT NULL`,
    `"fields" text[] NOT NULL DEFAULT '{}'`,
  ],
};

const PHASE: Record<StepKind, number> = {
  create_schema: 0,
  drop_fk: 1,
  drop_index: 2,
  drop_unique: 3,
  drop_column: 4,
  drop_table: 5,
  alter_column_type: 6,
  create_table: 7,
  add_column: 8,
  set_default: 9,
  relax_not_null: 10,
  set_not_null: 11,
  relax_check: 12,
  alter_enum_add_value: 12,
  alter_check: 12,
  add_unique: 13,
  add_fk: 14,
  add_index: 15,
  set_rls: 16,
};

// ---------------------------------------------------------------------------------------------
// Naming and quoting

const SQL_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Postgres truncates identifiers to 63 bytes; keep long generated names unique with a hash suffix. */
function pgName(...parts: string[]): string {
  const base = parts.join("_");
  return base.length <= 63 ? base : `${base.slice(0, 54)}_${fnv1a(base)}`;
}

/**
 * Name of a schema-wide object derived from a table and its columns (indexes, unique constraints). Index names
 * share one namespace per schema and idents may contain `_`, so parts are joined with `$` (not allowed in
 * idents): `ix_ticket$type_x` and `ix_ticket_type$x` stay distinct (with `_` both were `ix_ticket_type_x`,
 * and CREATE INDEX IF NOT EXISTS silently skipped the second one).
 */
function relName(prefix: string, table: string, ...columns: string[]): string {
  return pgName(`${prefix}_${[table, ...columns].join("$")}`);
}

function assertSqlName(name: string, what: string): void {
  if (!SQL_NAME_RE.test(name)) throw new Error(`invalid ${what}: ${name}`);
}

// ---------------------------------------------------------------------------------------------
// Types, constraints

export function sqlType(type: FieldType): string {
  switch (type) {
    case "int":
      return "bigint";
    case "decimal":
      return "numeric(18,6)";
    case "money":
      return "numeric(14,2)";
    case "bool":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "timestamptz";
    case "ref":
      return "uuid";
    case "json":
      return "jsonb";
    default:
      return "text";
  }
}

/** Default max length when a string-like field has no maxLength (text is unbounded). */
export const DEFAULT_MAX_LENGTH: Partial<Record<FieldType, number>> = {
  string: 255,
  email: 254,
  phone: 16,
  url: 2048,
};

type CheckKind = "len" | "fmt" | "enum" | "min" | "max";
interface CheckDef {
  name: string;
  kind: CheckKind;
  expr: string;
  limit?: number;
  values?: string[];
}

function checksFor(field: Field): CheckDef[] {
  const col = quoteIdent(field.name);
  const out: CheckDef[] = [];
  const len = field.maxLength ?? DEFAULT_MAX_LENGTH[field.type];
  if (len !== undefined && ["string", "text", "email", "phone", "url"].includes(field.type)) {
    out.push({
      name: `ck_${field.name}_len`,
      kind: "len",
      expr: `char_length(${col}) <= ${sqlLiteral(len, "int")}`,
      limit: len,
    });
  }
  const fmt = FORMAT_RE[field.type];
  if (fmt) out.push({ name: `ck_${field.name}_fmt`, kind: "fmt", expr: `${col} ~ ${textLiteral(fmt)}` });
  if (field.type === "enum" && field.enum) {
    const values = field.enum.map((o) => o.value);
    out.push({
      name: `ck_${field.name}_enum`,
      kind: "enum",
      expr: `${col} IN (${values.map((v) => sqlLiteral(v, "enum")).join(", ")})`,
      values,
    });
  }
  if (["int", "decimal", "money"].includes(field.type)) {
    if (field.min !== undefined)
      out.push({
        name: `ck_${field.name}_min`,
        kind: "min",
        expr: `${col} >= ${sqlLiteral(field.min, field.type)}`,
        limit: field.min,
      });
    if (field.max !== undefined)
      out.push({
        name: `ck_${field.name}_max`,
        kind: "max",
        expr: `${col} <= ${sqlLiteral(field.max, field.type)}`,
        limit: field.max,
      });
  }
  return out;
}

function isUnique(field: Field): boolean {
  return field.unique === true || field.type === "qr_token";
}

/** FK target table; refs to `users` point at the system users table created with the schema. */
function fkTarget(field: Field): string | undefined {
  return field.type === "ref" && field.ref ? field.ref.entity : undefined;
}

/** DEFAULT expression; throws SqlValueError when the default does not match the field type (validator rejects it first). */
function sqlDefault(field: Field): string | undefined {
  const d = field.default;
  if (d === undefined || ["ref", "file", "qr_token"].includes(field.type)) return undefined;
  return sqlLiteral(d, field.type);
}

function columnSql(table: string, field: Field, notNull: boolean): string {
  const parts = [quoteIdent(field.name), sqlType(field.type)];
  if (notNull) parts.push("NOT NULL");
  const def = sqlDefault(field);
  if (def !== undefined) parts.push(`DEFAULT ${def}`);
  for (const c of checksFor(field)) parts.push(`CONSTRAINT ${quoteIdent(c.name)} CHECK (${c.expr})`);
  if (isUnique(field)) parts.push(`CONSTRAINT ${quoteIdent(uniqueName(table, field.name))} UNIQUE`);
  return parts.join(" ");
}

const uniqueName = (table: string, field: string) => relName("uq", table, field);
const fkName = (table: string, field: string) => pgName("fk", table, field);

interface IndexDef {
  name: string;
  fields: string[];
  unique: boolean;
}

/** Declared indexes plus implicit ones (ops.yaml#ddl_rules): every ref field, ownerField, created_at. */
function indexesFor(entity: Entity): Map<string, IndexDef> {
  const out = new Map<string, IndexDef>();
  const implicit = [
    ...entity.fields.filter((f) => f.type === "ref").map((f) => f.name),
    ...(entity.ownerField !== undefined ? [entity.ownerField] : []),
    "created_at",
  ];
  for (const f of implicit) out.set(relName("ix", entity.name, f), { name: "", fields: [f], unique: false });
  for (const idx of entity.indexes ?? []) {
    const unique = idx.unique === true;
    out.set(relName(unique ? "ux" : "ix", entity.name, ...idx.fields), {
      name: "",
      fields: idx.fields,
      unique,
    });
  }
  for (const [name, def] of out) def.name = name;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Planning

function createEntitySteps(entity: Entity): MigrationStep[] {
  const steps: MigrationStep[] = [{ kind: "create_table", destructive: false, entity }];
  for (const f of entity.fields) {
    const target = fkTarget(f);
    if (target) steps.push(fkStep(entity.name, f, target));
  }
  for (const idx of indexesFor(entity).values())
    steps.push({ kind: "add_index", destructive: false, entity: entity.name, ...idx });
  return steps;
}

function fkStep(entity: string, f: Field, target: string): MigrationStep {
  return {
    kind: "add_fk",
    destructive: false,
    entity,
    field: f.name,
    target,
    onDelete: f.ref?.onDelete ?? "restrict",
    name: fkName(entity, f.name),
  };
}

function diffChecks(entity: string, prev: Field, next: Field, steps: MigrationStep[]): void {
  const a = new Map(checksFor(prev).map((c) => [c.name, c]));
  const b = new Map(checksFor(next).map((c) => [c.name, c]));
  for (const [name, old] of a) {
    if (!b.has(name)) steps.push({ kind: "relax_check", destructive: false, entity, name, expr: null });
    else if (b.get(name)?.expr !== old.expr) {
      const nw = b.get(name) as CheckDef;
      let widening = false;
      if (old.kind === "enum") widening = (old.values ?? []).every((v) => nw.values?.includes(v));
      else if (old.kind === "len" || old.kind === "max") widening = (nw.limit ?? 0) >= (old.limit ?? 0);
      else if (old.kind === "min") widening = (nw.limit ?? 0) <= (old.limit ?? 0);
      if (widening) {
        const kind = old.kind === "enum" ? "alter_enum_add_value" : "relax_check";
        steps.push({ kind, destructive: false, entity, name, expr: nw.expr });
      } else {
        steps.push({ kind: "alter_check", destructive: true, entity, name, expr: nw.expr });
      }
    }
  }
  for (const [name, c] of b) {
    if (!a.has(name)) steps.push({ kind: "alter_check", destructive: true, entity, name, expr: c.expr });
  }
}

/**
 * Whether the column is NOT NULL in the database. Fields with pii≠none of an entity with
 * retention.mode=anonymize stay nullable (anonymization nulls them); data API enforces `required`.
 */
function dbRequired(entity: Entity, field: Field): boolean {
  const anonymized = entity.retention?.mode === "anonymize" && (field.pii ?? "none") !== "none";
  return field.required === true && !anonymized;
}

function diffField(
  prevEntity: Entity,
  nextEntity: Entity,
  prev: Field,
  next: Field,
  steps: MigrationStep[],
): void {
  const entity = nextEntity.name;
  const wasRequired = dbRequired(prevEntity, prev);
  const isRequired = dbRequired(nextEntity, next);
  if (prev.type !== next.type) {
    const notNull = isRequired && sqlDefault(next) !== undefined;
    steps.push({
      kind: "alter_column_type",
      destructive: true,
      entity,
      field: next,
      from: prev.type,
      notNull,
    });
    const target = fkTarget(next);
    if (target) steps.push(fkStep(entity, next, target));
    return;
  }
  if (!wasRequired && isRequired)
    steps.push({ kind: "set_not_null", destructive: true, entity, field: next });
  if (wasRequired && !isRequired)
    steps.push({ kind: "relax_not_null", destructive: false, entity, field: next.name });
  if (JSON.stringify(sqlDefault(prev)) !== JSON.stringify(sqlDefault(next)))
    steps.push({ kind: "set_default", destructive: false, entity, field: next });
  diffChecks(entity, prev, next, steps);
  if (!isUnique(prev) && isUnique(next))
    steps.push({
      kind: "add_unique",
      destructive: false,
      entity,
      field: next.name,
      name: uniqueName(entity, next.name),
    });
  if (isUnique(prev) && !isUnique(next))
    steps.push({ kind: "drop_unique", destructive: true, entity, name: uniqueName(entity, next.name) });
  const ta = fkTarget(prev);
  const tb = fkTarget(next);
  const onDeleteChanged =
    ta && tb && (prev.ref?.onDelete ?? "restrict") !== (next.ref?.onDelete ?? "restrict");
  if (ta && (ta !== tb || onDeleteChanged))
    steps.push({ kind: "drop_fk", destructive: true, entity, name: fkName(entity, next.name) });
  if (tb && (ta !== tb || onDeleteChanged)) steps.push(fkStep(entity, next, tb));
}

function diffEntity(prev: Entity, next: Entity, steps: MigrationStep[]): void {
  const e = next.name;
  const prevFields = new Map(prev.fields.map((f) => [f.name, f]));
  const nextFields = new Map(next.fields.map((f) => [f.name, f]));
  const retyped = new Set<string>();
  for (const f of prev.fields) {
    if (!nextFields.has(f.name))
      steps.push({ kind: "drop_column", destructive: true, entity: e, field: f.name });
  }
  for (const f of next.fields) {
    const old = prevFields.get(f.name);
    if (!old) {
      // ops.yaml#required_new_column_policy: nullable + DEFAULT backfill, NOT NULL only when a default exists.
      const notNull = dbRequired(next, f) && sqlDefault(f) !== undefined;
      steps.push({ kind: "add_column", destructive: false, entity: e, field: f, notNull });
      const target = fkTarget(f);
      if (target) steps.push(fkStep(e, f, target));
    } else {
      if (old.type !== f.type) retyped.add(f.name);
      diffField(prev, next, old, f, steps);
    }
  }
  const a = indexesFor(prev);
  const b = indexesFor(next);
  for (const [name] of a) if (!b.has(name)) steps.push({ kind: "drop_index", destructive: true, name });
  for (const [name, idx] of b) {
    // Recreated columns lose their indexes, so re-add those too (CREATE INDEX IF NOT EXISTS).
    if (!a.has(name) || idx.fields.some((f) => retyped.has(f)))
      steps.push({ kind: "add_index", destructive: false, entity: e, ...idx });
  }
}

export interface PlanOptions {
  env?: "draft" | "prod";
}

/** Diffs two specs into ordered migration steps. `prev = null` plans a fresh schema. */
export function planMigration(prev: AppSpec | null, next: AppSpec, opts: PlanOptions = {}): MigrationPlan {
  const env = opts.env ?? "draft";
  const steps: MigrationStep[] = [];
  if (!prev) {
    steps.push({ kind: "create_schema", destructive: false });
    for (const e of next.entities) steps.push(...createEntitySteps(e));
  } else {
    const prevEntities = new Map(prev.entities.map((e) => [e.name, e]));
    const nextNames = new Set(next.entities.map((e) => e.name));
    for (const e of prev.entities) {
      if (!nextNames.has(e.name)) steps.push({ kind: "drop_table", destructive: true, entity: e.name });
    }
    for (const e of next.entities) {
      const old = prevEntities.get(e.name);
      if (!old) steps.push(...createEntitySteps(e));
      else diffEntity(old, e, steps);
    }
  }
  steps.push({ kind: "set_rls", destructive: false });
  const ordered = steps
    .map((s, i) => ({ s, i }))
    .sort((x, y) => PHASE[x.s.kind] - PHASE[y.s.kind] || x.i - y.i)
    .map((x) => x.s);

  const destructive = ordered.filter((s) => s.destructive);
  const errors: OpsError[] = [];
  const v = validateSpec(next);
  if (!v.ok) errors.push(...v.errors);
  if (env === "prod") {
    for (const s of destructive) {
      errors.push(
        err(
          "DESTRUCTIVE_IN_PROD",
          "",
          `Шаг миграции «${describeStep(s)}» разрушает данные и запрещён в prod`,
          {
            hint: "В prod разрешены только аддитивные изменения; удаление и сужение выполняются в draft",
          },
        ),
      );
    }
  }
  return { env, steps: ordered, additiveOnly: destructive.length === 0, destructive, errors, next };
}

export function describeStep(s: MigrationStep): string {
  const where = "entity" in s ? (typeof s.entity === "string" ? s.entity : s.entity.name) : "";
  const what =
    "field" in s ? (typeof s.field === "string" ? s.field : s.field.name) : "name" in s ? s.name : "";
  return [s.kind, where, what].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------------------------
// DDL

export interface DdlOptions {
  /** DB role used by the runtime; receives USAGE on the schema and DML on its tables. */
  runtimeRole?: string;
  /**
   * Per-system migration role (ops.yaml#migrations.roles; isolation.yaml M2: sys_owner_<key>_<env>). The schema is
   * created `AUTHORIZATION <role>`, then `SET LOCAL ROLE <role>` makes every following statement run with the
   * rights of this schema's owner only (no access to platform or other systems). The executing role MUST be a
   * member of it. Without it the statements run as the connecting role (M0-M1: wizard_owner).
   */
  migrationRole?: string;
  /** lock_timeout for the transaction, e.g. "3s", "500ms". Default "3s". */
  lockTimeout?: string;
}

const LOCK_TIMEOUT_RE = /^[1-9][0-9]{0,5}(ms|s|min)$/;

/** Session settings every generated script starts with: literals are encoded for standard_conforming_strings=on. */
function preamble(opts: DdlOptions): string[] {
  const lock = opts.lockTimeout ?? "3s";
  if (!LOCK_TIMEOUT_RE.test(lock)) throw new SqlValueError(`invalid lock_timeout: ${lock}`);
  return [`SET LOCAL lock_timeout = ${textLiteral(lock)}`, "SET LOCAL standard_conforming_strings = on"];
}

/**
 * Renders a plan to SQL statements. Execute them in order inside ONE transaction
 * (the first statement is `SET LOCAL lock_timeout`). Includes toRLS(plan.next) for the set_rls step.
 * Throws when the plan has errors (invalid spec or DESTRUCTIVE_IN_PROD).
 */
/** Number of preamble statements toRLS starts with (toDDL emits them once, at the top). */
const PREAMBLE_LENGTH = 2;

export function toDDL(plan: MigrationPlan, schemaName: string, opts: DdlOptions = {}): string[] {
  assertSqlName(schemaName, "schema name");
  if (plan.errors.length) {
    const codes = [...new Set(plan.errors.map((e) => e.code))].join(", ");
    throw new Error(`migration plan has errors: ${codes}`);
  }
  const s = quoteIdent(schemaName);
  const t = (table: string) => `${s}.${quoteIdent(table)}`;
  const touch = `${s}.${quoteIdent("wz_touch_updated_at")}`;
  const out: string[] = preamble(opts);
  const owner = opts.migrationRole;
  if (owner !== undefined) {
    assertSqlName(owner, "migration role");
    // Created by the connecting role (needs CREATE on the database), owned by the per-system role.
    if (plan.steps.some((x) => x.kind === "create_schema"))
      out.push(`CREATE SCHEMA IF NOT EXISTS ${s} AUTHORIZATION ${quoteIdent(owner)}`);
    out.push(`SET LOCAL ROLE ${quoteIdent(owner)}`);
  }
  for (const step of plan.steps) {
    switch (step.kind) {
      case "create_schema":
        if (owner === undefined) out.push(`CREATE SCHEMA IF NOT EXISTS ${s}`);
        out.push(
          `CREATE OR REPLACE FUNCTION ${touch}() RETURNS trigger LANGUAGE plpgsql AS ${dollarQuote(" BEGIN NEW.updated_at := now(); RETURN NEW; END ")}`,
        );
        for (const [name, cols] of Object.entries(SYSTEM_TABLES)) {
          out.push(`CREATE TABLE IF NOT EXISTS ${t(name)} (\n  ${cols.join(",\n  ")}\n)`);
        }
        break;
      case "create_table": {
        const e = step.entity;
        const cols = [
          `${quoteIdent("id")} uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
          `${quoteIdent("created_at")} timestamptz NOT NULL DEFAULT now()`,
          `${quoteIdent("updated_at")} timestamptz`,
          `${quoteIdent("created_by")} uuid DEFAULT nullif(current_setting('wizard.user_id', true), '')::uuid`,
          ...e.fields.map((f) => columnSql(e.name, f, dbRequired(e, f))),
        ];
        out.push(`CREATE TABLE ${t(e.name)} (\n  ${cols.join(",\n  ")}\n)`);
        out.push(
          `CREATE TRIGGER ${quoteIdent("wz_touch_updated_at")} BEFORE UPDATE ON ${t(e.name)} FOR EACH ROW EXECUTE FUNCTION ${touch}()`,
        );
        break;
      }
      case "add_column":
        out.push(`ALTER TABLE ${t(step.entity)} ADD COLUMN ${columnSql(step.entity, step.field, false)}`);
        if (step.notNull)
          out.push(`ALTER TABLE ${t(step.entity)} ALTER COLUMN ${quoteIdent(step.field.name)} SET NOT NULL`);
        break;
      case "alter_column_type":
        // Type changes recreate the column (data in it is lost) — draft only.
        out.push(`ALTER TABLE ${t(step.entity)} DROP COLUMN IF EXISTS ${quoteIdent(step.field.name)}`);
        out.push(
          `ALTER TABLE ${t(step.entity)} ADD COLUMN ${columnSql(step.entity, step.field, step.notNull)}`,
        );
        break;
      case "set_default": {
        const def = sqlDefault(step.field);
        const col = quoteIdent(step.field.name);
        out.push(
          `ALTER TABLE ${t(step.entity)} ALTER COLUMN ${col} ${def === undefined ? "DROP DEFAULT" : `SET DEFAULT ${def}`}`,
        );
        break;
      }
      case "relax_not_null":
        out.push(`ALTER TABLE ${t(step.entity)} ALTER COLUMN ${quoteIdent(step.field)} DROP NOT NULL`);
        break;
      case "set_not_null": {
        const col = quoteIdent(step.field.name);
        const def = sqlDefault(step.field);
        if (def !== undefined) out.push(`UPDATE ${t(step.entity)} SET ${col} = ${def} WHERE ${col} IS NULL`);
        out.push(`ALTER TABLE ${t(step.entity)} ALTER COLUMN ${col} SET NOT NULL`);
        break;
      }
      case "relax_check":
      case "alter_check":
      case "alter_enum_add_value":
        out.push(`ALTER TABLE ${t(step.entity)} DROP CONSTRAINT IF EXISTS ${quoteIdent(step.name)}`);
        if (step.expr !== null)
          out.push(
            `ALTER TABLE ${t(step.entity)} ADD CONSTRAINT ${quoteIdent(step.name)} CHECK (${step.expr})`,
          );
        break;
      case "add_unique":
        out.push(
          `ALTER TABLE ${t(step.entity)} ADD CONSTRAINT ${quoteIdent(step.name)} UNIQUE (${quoteIdent(step.field)})`,
        );
        break;
      case "drop_unique":
      case "drop_fk":
        out.push(`ALTER TABLE ${t(step.entity)} DROP CONSTRAINT IF EXISTS ${quoteIdent(step.name)}`);
        break;
      case "add_fk": {
        const action = { restrict: "RESTRICT", cascade: "CASCADE", set_null: "SET NULL" }[step.onDelete];
        out.push(
          `ALTER TABLE ${t(step.entity)} ADD CONSTRAINT ${quoteIdent(step.name)} FOREIGN KEY (${quoteIdent(step.field)}) REFERENCES ${t(step.target)} (${quoteIdent("id")}) ON DELETE ${action}`,
        );
        break;
      }
      case "add_index":
        out.push(
          `CREATE ${step.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdent(step.name)} ON ${t(step.entity)} (${step.fields.map(quoteIdent).join(", ")})`,
        );
        break;
      case "drop_index":
        out.push(`DROP INDEX IF EXISTS ${s}.${quoteIdent(step.name)}`);
        break;
      case "drop_column":
        out.push(`ALTER TABLE ${t(step.entity)} DROP COLUMN IF EXISTS ${quoteIdent(step.field)}`);
        break;
      case "drop_table":
        out.push(`DROP TABLE IF EXISTS ${t(step.entity)}`);
        break;
      case "set_rls":
        out.push(...toRLS(plan.next, schemaName, opts).slice(PREAMBLE_LENGTH));
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// RLS

const POLICY_CMD: Record<PermissionOp, string> = {
  read: "SELECT",
  create: "INSERT",
  update: "UPDATE",
  delete: "DELETE",
};

/** Spec-level type of a column (system columns: uuid/timestamptz). */
function columnType(entity: Entity, name: string): LiteralType | undefined {
  if ((SYSTEM_FIELDS as readonly string[]).includes(name))
    return SYSTEM_FIELD_TYPES[name as keyof typeof SYSTEM_FIELD_TYPES];
  return entity.fields.find((x) => x.name === name)?.type;
}

const sqlColumnType = (t: LiteralType): string => (t === "uuid" || t === "timestamptz" ? t : sqlType(t));

/** SQL reading `$user.<attr>` from the transaction context (runtime.yaml#postgres.context). */
function userAttrSql(attr: string): string {
  if (attr === "id") return "nullif(current_setting('wizard.user_id', true), '')";
  if (attr === "role") return "nullif(current_setting('wizard.role', true), '')";
  return `(nullif(current_setting('wizard.user_attrs', true), '')::jsonb ->> ${textLiteral(attr)})`;
}

/**
 * SQL predicate for a rowFilter entry. Context reads are wrapped in a scalar subquery so Postgres evaluates
 * them once per statement; a missing value yields NULL and the row is denied.
 */
function filterPredicate(entity: Entity, key: string, value: string | number | boolean): string {
  const type = columnType(entity, key);
  if (!type) throw new Error(`rowFilter: unknown field ${entity.name}.${key}`);
  const col = quoteIdent(key);
  const m = typeof value === "string" ? USER_REF_RE.exec(value) : null;
  if (m) return `${col} = (select ${userAttrSql(m[1] as string)}::${sqlColumnType(type)})`;
  return `${col} = ${sqlLiteral(value, type)}`;
}

/**
 * RLS for every entity table: ENABLE + FORCE, all previous wz_* policies dropped, then one permissive
 * policy per (role, op) from permissions. No policy → no access (deny by default).
 * Column-level rules (hiddenFields/readonlyFields) are enforced by the runtime query builder, not RLS.
 */
export function toRLS(spec: AppSpec, schemaName: string, opts: DdlOptions = {}): string[] {
  assertSqlName(schemaName, "schema name");
  const s = quoteIdent(schemaName);
  const out: string[] = preamble(opts);
  const tables = [...Object.keys(SYSTEM_TABLES), ...spec.entities.map((e) => e.name)];
  for (const table of tables) {
    out.push(`ALTER TABLE ${s}.${quoteIdent(table)} ENABLE ROW LEVEL SECURITY`);
    out.push(`ALTER TABLE ${s}.${quoteIdent(table)} FORCE ROW LEVEL SECURITY`);
  }
  const schemaLit = textLiteral(schemaName);
  out.push(
    `DO ${dollarQuote(` DECLARE p record; BEGIN FOR p IN SELECT policyname, tablename FROM pg_policies WHERE schemaname = ${schemaLit} AND policyname LIKE ${textLiteral("wz\\_%")} LOOP EXECUTE format(${textLiteral("DROP POLICY %I ON %I.%I")}, p.policyname, ${schemaLit}, p.tablename); END LOOP; END `)}`,
  );
  // ctx.systemDb and workflows run as role '__system' (runtime.yaml#postgres.context). A separate permissive
  // policy is equivalent to OR-ing it into every (role, op) policy, and also covers tables without permissions.
  for (const table of tables) {
    out.push(
      `CREATE POLICY "wz__system" ON ${s}.${quoteIdent(table)} AS PERMISSIVE FOR ALL TO PUBLIC USING (${SYSTEM_ROLE_COND}) WITH CHECK (${SYSTEM_ROLE_COND})`,
    );
  }
  const entities = new Map(spec.entities.map((e) => [e.name, e]));
  for (const p of spec.permissions) {
    const entity = entities.get(p.entity);
    if (!entity) continue;
    const roleCond = `current_setting('wizard.role', true) = ${textLiteral(p.role)}`;
    const filtered = [
      roleCond,
      ...Object.entries(p.rowFilter ?? {}).map(([k, v]) => filterPredicate(entity, k, v)),
    ].join(" AND ");
    // rowFilterOps (default: all ops of the permission) — ops the rowFilter applies to; others get the role only.
    const filterOps = new Set<PermissionOp>(p.rowFilterOps ?? p.ops);
    for (const op of p.ops) {
      const cond = filterOps.has(op) ? filtered : roleCond;
      const name = quoteIdent(pgName("wz", p.role, op));
      const head = `CREATE POLICY ${name} ON ${s}.${quoteIdent(entity.name)} AS PERMISSIVE FOR ${POLICY_CMD[op]} TO PUBLIC`;
      if (op === "create") out.push(`${head} WITH CHECK (${cond})`);
      else if (op === "update") out.push(`${head} USING (${cond}) WITH CHECK (${cond})`);
      else out.push(`${head} USING (${cond})`);
    }
  }
  if (opts.runtimeRole !== undefined) {
    assertSqlName(opts.runtimeRole, "runtime role");
    const r = quoteIdent(opts.runtimeRole);
    out.push(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
    out.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ${r}`);
    out.push(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${s} TO ${r}`);
  }
  return out;
}
