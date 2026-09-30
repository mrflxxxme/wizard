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
import { SYSTEM_FIELDS, USERS_ENTITY } from "./reserved.js";
import {
  type AppSpec,
  type Entity,
  type Field,
  type FieldType,
  type PermissionOp,
  validateSpec,
} from "./schema.js";
import { SYSTEM_FIELD_TYPES, USER_REF_RE } from "./semantic.js";

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
  | (Base<"alter_column_type", true> & { entity: string; field: Field; from: FieldType })
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

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("NUL byte in SQL literal");
  return `'${value.replace(/'/g, "''")}'`;
}

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

const FORMAT_RE: Partial<Record<FieldType, string>> = {
  email: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
  phone: "^\\+[1-9][0-9]{6,14}$",
  url: "^https?://[^\\s]+$",
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
      expr: `char_length(${col}) <= ${len}`,
      limit: len,
    });
  }
  const fmt = FORMAT_RE[field.type];
  if (fmt) out.push({ name: `ck_${field.name}_fmt`, kind: "fmt", expr: `${col} ~ ${quoteLiteral(fmt)}` });
  if (field.type === "enum" && field.enum) {
    const values = field.enum.map((o) => o.value);
    out.push({
      name: `ck_${field.name}_enum`,
      kind: "enum",
      expr: `${col} IN (${values.map(quoteLiteral).join(", ")})`,
      values,
    });
  }
  if (["int", "decimal", "money"].includes(field.type)) {
    if (field.min !== undefined)
      out.push({
        name: `ck_${field.name}_min`,
        kind: "min",
        expr: `${col} >= ${field.min}`,
        limit: field.min,
      });
    if (field.max !== undefined)
      out.push({
        name: `ck_${field.name}_max`,
        kind: "max",
        expr: `${col} <= ${field.max}`,
        limit: field.max,
      });
  }
  return out;
}

function isUnique(field: Field): boolean {
  return field.unique === true || field.type === "qr_token";
}

function fkTarget(field: Field): string | undefined {
  return field.type === "ref" && field.ref && field.ref.entity !== USERS_ENTITY
    ? field.ref.entity
    : undefined;
}

function sqlDefault(field: Field): string | undefined {
  const d = field.default;
  if (d === undefined || ["ref", "file", "qr_token"].includes(field.type)) return undefined;
  if (field.type === "json") return `${quoteLiteral(JSON.stringify(d))}::jsonb`;
  if (typeof d === "number" && Number.isFinite(d)) return String(d);
  if (typeof d === "boolean") return d ? "TRUE" : "FALSE";
  if (typeof d === "string") return `${quoteLiteral(d)}::${sqlType(field.type)}`;
  return undefined;
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

const uniqueName = (table: string, field: string) => pgName("uq", table, field);
const fkName = (table: string, field: string) => pgName("fk", table, field);

interface IndexDef {
  name: string;
  fields: string[];
  unique: boolean;
}

function indexesFor(entity: Entity): Map<string, IndexDef> {
  const out = new Map<string, IndexDef>();
  // FK columns are indexed automatically (joins, ON DELETE, rowFilter on ownerField).
  for (const f of entity.fields) {
    if (f.type === "ref")
      out.set(pgName("ix", entity.name, f.name), { name: "", fields: [f.name], unique: false });
  }
  for (const idx of entity.indexes ?? []) {
    const unique = idx.unique === true;
    out.set(pgName(unique ? "ux" : "ix", entity.name, ...idx.fields), {
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

function diffField(entity: string, prev: Field, next: Field, steps: MigrationStep[]): void {
  if (prev.type !== next.type) {
    steps.push({ kind: "alter_column_type", destructive: true, entity, field: next, from: prev.type });
    const target = fkTarget(next);
    if (target) steps.push(fkStep(entity, next, target));
    return;
  }
  if (!prev.required && next.required)
    steps.push({ kind: "set_not_null", destructive: true, entity, field: next });
  if (prev.required && !next.required)
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
      const notNull = f.required === true && sqlDefault(f) !== undefined;
      steps.push({ kind: "add_column", destructive: false, entity: e, field: f, notNull });
      const target = fkTarget(f);
      if (target) steps.push(fkStep(e, f, target));
    } else {
      if (old.type !== f.type) retyped.add(f.name);
      diffField(e, old, f, steps);
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
  lockTimeout?: string;
}

/**
 * Renders a plan to SQL statements. Execute them in order inside ONE transaction
 * (the first statement is `SET LOCAL lock_timeout`). Includes toRLS(plan.next) for the set_rls step.
 * Throws when the plan has errors (invalid spec or DESTRUCTIVE_IN_PROD).
 */
export function toDDL(plan: MigrationPlan, schemaName: string, opts: DdlOptions = {}): string[] {
  assertSqlName(schemaName, "schema name");
  if (plan.errors.length) {
    const codes = [...new Set(plan.errors.map((e) => e.code))].join(", ");
    throw new Error(`migration plan has errors: ${codes}`);
  }
  const s = quoteIdent(schemaName);
  const t = (table: string) => `${s}.${quoteIdent(table)}`;
  const touch = `${s}.${quoteIdent("wz_touch_updated_at")}`;
  const out: string[] = [`SET LOCAL lock_timeout = ${quoteLiteral(opts.lockTimeout ?? "3s")}`];
  for (const step of plan.steps) {
    switch (step.kind) {
      case "create_schema":
        out.push(`CREATE SCHEMA IF NOT EXISTS ${s}`);
        out.push(
          `CREATE OR REPLACE FUNCTION ${touch}() RETURNS trigger LANGUAGE plpgsql AS $wz$ BEGIN NEW.updated_at := now(); RETURN NEW; END $wz$`,
        );
        break;
      case "create_table": {
        const e = step.entity;
        const cols = [
          `${quoteIdent("id")} uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
          `${quoteIdent("created_at")} timestamptz NOT NULL DEFAULT now()`,
          `${quoteIdent("updated_at")} timestamptz`,
          `${quoteIdent("created_by")} uuid DEFAULT nullif(current_setting('wizard.user_id', true), '')::uuid`,
          ...e.fields.map((f) => columnSql(e.name, f, f.required === true)),
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
          `ALTER TABLE ${t(step.entity)} ADD COLUMN ${columnSql(step.entity, step.field, step.field.required === true && sqlDefault(step.field) !== undefined)}`,
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
        out.push(...toRLS(plan.next, schemaName, opts));
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

function columnType(entity: Entity, name: string): string | undefined {
  if ((SYSTEM_FIELDS as readonly string[]).includes(name))
    return SYSTEM_FIELD_TYPES[name as keyof typeof SYSTEM_FIELD_TYPES];
  const f = entity.fields.find((x) => x.name === name);
  return f ? sqlType(f.type) : undefined;
}

/** SQL predicate for a rowFilter entry; `$user.<attr>` reads current_setting('wizard.user_<attr>', true). */
function filterPredicate(entity: Entity, key: string, value: string | number | boolean): string {
  const type = columnType(entity, key);
  if (!type) throw new Error(`rowFilter: unknown field ${entity.name}.${key}`);
  const col = quoteIdent(key);
  if (typeof value === "string") {
    const m = USER_REF_RE.exec(value);
    if (m)
      return `${col} = nullif(current_setting(${quoteLiteral(`wizard.user_${m[1]}`)}, true), '')::${type}`;
    return `${col} = ${quoteLiteral(value)}::${type}`;
  }
  if (typeof value === "boolean") return `${col} = ${value ? "TRUE" : "FALSE"}`;
  if (!Number.isFinite(value)) throw new Error("rowFilter: non-finite number");
  return `${col} = ${value}`;
}

/**
 * RLS for every entity table: ENABLE + FORCE, all previous wz_* policies dropped, then one permissive
 * policy per (role, op) from permissions. No policy → no access (deny by default).
 * Column-level rules (hiddenFields/readonlyFields) are enforced by the runtime query builder, not RLS.
 */
export function toRLS(spec: AppSpec, schemaName: string, opts: DdlOptions = {}): string[] {
  assertSqlName(schemaName, "schema name");
  const s = quoteIdent(schemaName);
  const out: string[] = [];
  for (const e of spec.entities) {
    out.push(`ALTER TABLE ${s}.${quoteIdent(e.name)} ENABLE ROW LEVEL SECURITY`);
    out.push(`ALTER TABLE ${s}.${quoteIdent(e.name)} FORCE ROW LEVEL SECURITY`);
  }
  out.push(
    `DO $wz$ DECLARE p record; BEGIN FOR p IN SELECT policyname, tablename FROM pg_policies WHERE schemaname = ${quoteLiteral(schemaName)} AND policyname LIKE 'wz\\_%' LOOP EXECUTE format('DROP POLICY %I ON %I.%I', p.policyname, ${quoteLiteral(schemaName)}, p.tablename); END LOOP; END $wz$`,
  );
  const entities = new Map(spec.entities.map((e) => [e.name, e]));
  for (const p of spec.permissions) {
    const entity = entities.get(p.entity);
    if (!entity) continue;
    const conds = [`current_setting('wizard.role', true) = ${quoteLiteral(p.role)}`];
    for (const [k, v] of Object.entries(p.rowFilter ?? {})) conds.push(filterPredicate(entity, k, v));
    const cond = conds.join(" AND ");
    for (const op of p.ops) {
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
  }
  return out;
}
