// DataAccess over Postgres: kysely compiles the SQL, postgres.js executes it inside one transaction per call with
// the RLS context set by set_config(..., true) (runtime.yaml#postgres.context, #permissions.algorithm).
import { randomBytes, randomUUID } from "node:crypto";
import { type AppSpec, type Entity, isFileFieldType, literalProblem, systemRoleName } from "@wizard/appspec";
import { WizardError } from "@wizard/sdk";
import {
  type AccessPolicy,
  compilePolicy,
  type DbAdapter,
  isRangeValue,
  type RawDoc,
  type RawWhere,
  type RowConstraint,
  resolveIndex,
  type SchedulerAdapter,
  stripHidden,
  type TransactionRunner,
  type TxMode,
} from "@wizard/sdk/host";
import {
  type CompiledQuery,
  DummyDriver,
  type Expression,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type RawBuilder,
  type SqlBool,
  sql,
} from "kysely";
import type postgres from "postgres";
import { type ComplianceInfo, complianceInfo, consentMatches } from "../compliance.js";
import { FILE_ID_RE, FILE_NOT_FOUND_RU, type FileFieldGuard } from "../files/system-files.js";
import {
  type DataAccess,
  type DataOp,
  type DataTx,
  type Doc,
  type InvalidationBus,
  type InvalidationEvent,
  type ListQuery,
  type ListResult,
  type Subject,
  SYSTEM_ROLE,
  SYSTEM_SUBJECT,
  type WriteOptions,
} from "./access.js";
import { createInvalidationBus } from "./events.js";
import {
  type CheckedFilter,
  checkAllowedValues,
  checkFilters,
  checkValues,
  checkVisibleColumn,
  checkWritableKeys,
  columnType,
  fieldsError,
  intQuery,
  phoneDigits,
  searchColumns,
  splitBody,
} from "./validate.js";

// biome-ignore lint/suspicious/noExplicitAny: tables and columns come from the AppSpec at runtime.
type AnyDB = Record<string, any>;
type Row = Record<string, unknown>;
type Who = "subject" | "system";

/** Query compiler only: execution goes through postgres.js (tx.unsafe with parameters). */
const qb = new Kysely<AnyDB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const MAX_TOTAL = 10_000;
const SYSTEM_COLUMNS = ["id", "created_at", "updated_at", "created_by"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PgDataAccessOptions {
  sql: postgres.Sql;
  spec: AppSpec;
  /** app_<systemId>_<env> */
  schema: string;
  /**
   * DB role every transaction switches to via set_config('role', ..., true) (runtime.yaml#postgres.roles:
   * wizard_runtime, no BYPASSRLS). null → stay as the connecting role (it MUST then be wizard_runtime itself).
   */
  dbRole?: string | null;
  /**
   * DB role of system access (ctx.systemDb, workflows, scheduler, SYSTEM_SUBJECT): every system context switches
   * to it with set_config('role', ..., true) (security/isolation.yaml#db_access, L3-20). The connecting session
   * user MUST be allowed to SET it (toSystemRoleDDL members). Default systemRoleName(schema).
   */
  systemRole?: string;
  events?: InvalidationBus;
  /** runtime.yaml#postgres.statement_timeout */
  statementTimeout?: string;
  lockTimeout?: string;
  /** qr_token generator (connectors/qr.yaml#token, wired by the runtime to the qr connector); undefined → 24 random bytes, base64url. */
  qrToken?: (entity: string, field: string, id: string) => string | undefined | Promise<string | undefined>;
  /** Consent text/policy version of the system (LoadedSystem.compliance); default complianceInfo(spec). */
  compliance?: ComplianceInfo;
  /** File fields (runtime.yaml#files): values must be uploads for that entity.field; detached files are released. */
  files?: FileFieldGuard;
}

/** Consent handling of one write: check it (data API, ctx.db) and journal the accepted one in _w_consents. */
interface ConsentCheck {
  check: boolean;
  value?: unknown;
  ipHmac?: Uint8Array | null;
}

// ------------------------------------------------------------------------------------------------
// per-transaction state

interface Tx {
  sql: postgres.TransactionSql;
  /** DB roles of the two contexts: the subject's (null → the session user) and the system role. */
  roles: { subject: string | null; system: string };
  subject: Subject;
  current: Who;
  now: Date;
  pending: InvalidationEvent[];
  /** File ids detached by writes of this transaction (released after the commit). */
  released: string[];
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>;
}

function mutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

async function exec(t: Tx, q: { compile(): CompiledQuery }): Promise<postgres.RowList<Row[]>> {
  const c = q.compile();
  return t.sql.unsafe<Row[]>(c.sql, c.parameters as never[]);
}

/** `wizard.user_attrs`: users row without id/role, flattened with users.attrs (read by $user.<attr> in RLS). */
function userAttrs(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const extra = record.attrs;
  if (typeof extra === "object" && extra !== null && !Array.isArray(extra)) Object.assign(out, extra);
  for (const [k, v] of Object.entries(record)) {
    if (k === "id" || k === "role" || k === "attrs" || v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "bigint") out[k] = v.toString();
  }
  return out;
}

/**
 * RLS context of the next statements. System access is the DB role t.roles.system, never a GUC value (L3-20):
 * the subject context switches back to the runtime role, whose policies only match spec roles.
 */
async function setContext(t: Tx, who: Who): Promise<void> {
  const s = who === "system" ? SYSTEM_SUBJECT : t.subject;
  const dbRole = s.role === SYSTEM_ROLE ? t.roles.system : (t.roles.subject ?? "none");
  await t.sql.unsafe(
    "select set_config('role', $4, true), set_config('wizard.role', $1, true), set_config('wizard.user_id', $2, true), set_config('wizard.user_attrs', $3, true)",
    [s.role, s.id ?? "", JSON.stringify(userAttrs(s.record)), dbRole],
  );
  t.current = who;
}

async function ensure(t: Tx, who: Who): Promise<void> {
  if (t.current !== who) await setContext(t, who);
}

// ------------------------------------------------------------------------------------------------
// value conversion (runtime.yaml#data_api.doc_shape)

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function fromDb(type: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (type) {
    case "int":
    case "decimal":
    case "money":
      return typeof v === "number" ? v : Number(v);
    case "date":
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return String(v).slice(0, 10);
    case "datetime":
      return iso(v);
    case "bool":
      return v === true || v === "t" || v === "true";
    case "json":
      return typeof v === "string" ? JSON.parse(v) : v;
    default:
      return typeof v === "bigint" ? v.toString() : v;
  }
}

/** jsonb from a text parameter: postgres.js would JSON-encode a string bound to a jsonb parameter again. */
const jsonb = (v: unknown) => sql`cast(cast(${JSON.stringify(v)} as text) as jsonb)`;

function toDb(type: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (type === "json") return jsonb(v);
  return v;
}

function shape(e: Entity, row: Row, hidden: ReadonlySet<string>): Doc {
  const doc: Doc = {
    id: row.id,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    created_by: row.created_by ?? null,
  };
  for (const f of e.fields) doc[f.name] = fromDb(f.type, row[f.name]);
  return stripHidden(doc, hidden);
}

// ------------------------------------------------------------------------------------------------
// SQL fragments

const TRUE = sql<SqlBool>`TRUE`;
const FALSE = sql<SqlBool>`FALSE`;

function and(conds: Expression<SqlBool>[]): Expression<SqlBool> {
  if (conds.length === 0) return TRUE;
  return sql<SqlBool>`(${sql.join(conds, sql` AND `)})`;
}

function constraintConds(c: RowConstraint): Expression<SqlBool>[] {
  if (c === null) return [];
  if (c === false) return [FALSE];
  return Object.entries(c).map(([col, v]) => sql<SqlBool>`${sql.ref(col)} = ${v}`);
}

const escapeLike = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;

function filterConds(filters: readonly CheckedFilter[]): Expression<SqlBool>[] {
  return filters.map((f) => {
    const col = sql.ref(f.field);
    if (f.value === null)
      return f.op === "eq" ? sql<SqlBool>`${col} IS NULL` : sql<SqlBool>`${col} IS NOT NULL`;
    switch (f.op) {
      case "eq":
        return sql<SqlBool>`${col} = ${f.value}`;
      case "ne":
        return sql<SqlBool>`${col} IS DISTINCT FROM ${f.value}`;
      case "lt":
        return sql<SqlBool>`${col} < ${f.value}`;
      case "lte":
        return sql<SqlBool>`${col} <= ${f.value}`;
      case "gt":
        return sql<SqlBool>`${col} > ${f.value}`;
      case "gte":
        return sql<SqlBool>`${col} >= ${f.value}`;
      case "in":
        return sql<SqlBool>`${col} IN (${sql.join(f.value as unknown[])})`;
      case "contains":
        return sql<SqlBool>`${col}::text ILIKE ${escapeLike(String(f.value))}`;
    }
    return FALSE;
  });
}

/** `q` (V3-18): any readable text field ILIKE, a phone by its digits, an int field equal to «1042» / «№1042». */
function searchCond(cols: readonly { name: string; type: string }[], q: string): Expression<SqlBool> {
  const like = escapeLike(q);
  const digits = phoneDigits(q);
  const n = intQuery(q);
  const terms: Expression<SqlBool>[] = [];
  for (const c of cols) {
    const col = sql.ref(c.name);
    if (c.type === "int") {
      if (n !== null) terms.push(sql<SqlBool>`${col} = ${n}`);
    } else if (c.type === "phone" && digits)
      terms.push(sql<SqlBool>`regexp_replace(${col}, '[^0-9]', '', 'g') LIKE ${`%${digits}%`}`);
    else terms.push(sql<SqlBool>`${col} ILIKE ${like}`);
  }
  return terms.length ? sql<SqlBool>`(${sql.join(terms, sql` OR `)})` : FALSE;
}

/** ctx.db `where`: equality on index prefix, last key may be a range (sdk.md §2.4). */
function whereConds(e: Entity, policy: AccessPolicy, where: RawWhere | undefined): Expression<SqlBool>[] {
  const out: Expression<SqlBool>[] = [];
  for (const [key, v] of Object.entries(where ?? {})) {
    if (v === undefined) continue;
    const type = checkVisibleColumn(e, policy, key);
    const col = sql.ref(key);
    const check = (x: unknown) => {
      const lit = type === "enum" || type === "qr_token" || isFileFieldType(type) ? "string" : type;
      const p = x === null ? undefined : literalProblem(x, lit);
      if (p) throw fieldsError("VALIDATION_FAILED", [{ field: key, code: "INVALID_WHERE", message: p }]);
      return x;
    };
    if (v === null) out.push(sql<SqlBool>`${col} IS NULL`);
    else if (isRangeValue(v)) {
      if (v.gt !== undefined) out.push(sql<SqlBool>`${col} > ${check(v.gt)}`);
      if (v.gte !== undefined) out.push(sql<SqlBool>`${col} >= ${check(v.gte)}`);
      if (v.lt !== undefined) out.push(sql<SqlBool>`${col} < ${check(v.lt)}`);
      if (v.lte !== undefined) out.push(sql<SqlBool>`${col} <= ${check(v.lte)}`);
    } else out.push(sql<SqlBool>`${col} = ${check(v)}`);
  }
  return out;
}

function columnsOf(e: Entity): string[] {
  return [...SYSTEM_COLUMNS, ...e.fields.map((f) => f.name)];
}

// ------------------------------------------------------------------------------------------------
// Postgres error mapping

interface PgError {
  code?: string;
  constraint_name?: string;
  column_name?: string;
  detail?: string;
}

function mapPgError(err: unknown, e?: Entity): unknown {
  if (err instanceof WizardError) return err;
  const pg = err as PgError;
  switch (pg?.code) {
    case "23505": {
      // DETAIL (Key (...)=(...)) is suppressed under RLS; the constraint name is uq_<table>$<col> (ops.yaml#ddl_rules).
      const field = pg.constraint_name?.split("$")[1] ?? e?.fields.find((f) => f.unique)?.name;
      return new WizardError("CONFLICT", {
        ...(field ? { fields: [{ field, code: "CONFLICT", message: "Такое значение уже есть" }] } : {}),
      });
    }
    case "23502":
      return fieldsError(
        "VALIDATION_FAILED",
        pg.column_name ? [{ field: pg.column_name, code: "REQUIRED", message: "Обязательное поле" }] : [],
      );
    case "23503":
    case "23514":
    case "22P02":
    case "22007":
    case "22008":
    case "22003":
    case "22001":
      return new WizardError("VALIDATION_FAILED");
    case "42501":
      return new WizardError("FORBIDDEN");
    case "57014":
    case "55P03":
      return new WizardError("TIMEOUT");
    default:
      return err;
  }
}

// ------------------------------------------------------------------------------------------------

export function createPgDataAccess(o: PgDataAccessOptions): DataAccess {
  const { spec, schema } = o;
  const events = o.events ?? createInvalidationBus();
  const dbRole = o.dbRole === undefined ? "wizard_runtime" : o.dbRole;
  const systemRole = o.systemRole ?? systemRoleName(schema);
  const statementTimeout = o.statementTimeout ?? "1s";
  const lockTimeout = o.lockTimeout ?? "500ms";
  const compliance: ComplianceInfo = o.compliance ?? complianceInfo(spec);
  const entities = new Map(spec.entities.map((e) => [e.name, e]));
  const from = (name: string) => qb.withSchema(schema).selectFrom(name);

  function entity(name: string): Entity {
    const e = entities.get(name);
    if (!e) throw new WizardError("NOT_FOUND", { message: "Раздел не найден" });
    return e;
  }

  function policyFor(t: Tx, who: Who, e: Entity): AccessPolicy {
    const s = who === "system" ? SYSTEM_SUBJECT : t.subject;
    return compilePolicy(spec, e.name, { id: s.id, role: s.role, record: s.record });
  }

  function require(p: AccessPolicy, op: DataOp): void {
    if (!p.allows(op)) throw new WizardError("FORBIDDEN");
  }

  function subjectFor(user: Readonly<Record<string, unknown>>): Subject {
    const role = String(user.role ?? "");
    return {
      id: typeof user.id === "string" ? user.id : null,
      role,
      isAdmin: spec.roles.some((r) => r.name === role && r.isAdmin === true),
      record: user,
    };
  }

  function publicSubject(): Subject | null {
    const r = spec.roles.find((x) => x.access === "public");
    return r ? { id: null, role: r.name, isAdmin: false, record: {} } : null;
  }

  // ---------- transactions ----------

  async function withTx<T>(
    mode: TxMode | "default",
    subject: Subject,
    fn: (t: Tx) => Promise<T>,
    load?: string | null,
  ): Promise<T> {
    const pending: InvalidationEvent[] = [];
    const released: string[] = [];
    const opts =
      mode === "read"
        ? "isolation level repeatable read read only"
        : mode === "write"
          ? "isolation level serializable"
          : "";
    try {
      const body = async (tx: postgres.TransactionSql) => {
        const [head] = await tx.unsafe<{ now: Date }[]>(
          "select now() as now, set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
          [statementTimeout, lockTimeout],
        );
        if (dbRole !== null) await tx.unsafe("select set_config('role', $1, true)", [dbRole]);
        const t: Tx = {
          sql: tx,
          roles: { subject: dbRole, system: systemRole },
          subject,
          current: "subject",
          now: head?.now instanceof Date ? head.now : new Date(),
          pending,
          released,
          exclusive: mutex(),
        };
        if (load) {
          // CurrentUser → users row, read as __system (the users table is visible to __system only).
          await setContext(t, "system");
          const rows = await exec(t, from("users").selectAll().where("id", "=", load));
          const row = rows[0];
          if (!row || row.blocked_at) throw new WizardError("UNAUTHENTICATED");
          t.subject = { ...subject, record: row };
        }
        await setContext(t, "subject");
        return fn(t);
      };
      const result = opts ? await o.sql.begin(opts, body) : await o.sql.begin(body);
      if (pending.length) events.publish(pending);
      if (released.length) o.files?.released(released);
      return result as T;
    } catch (err) {
      throw mapPgError(err);
    }
  }

  // ---------- reads ----------

  async function selectDocs(
    t: Tx,
    who: Who,
    e: Entity,
    conds: Expression<SqlBool>[],
    order: { field: string; dir: "asc" | "desc" }[],
    limit: number,
    offset = 0,
  ): Promise<Row[]> {
    await ensure(t, who);
    let q = from(e.name)
      .select(columnsOf(e))
      .where(() => and(conds));
    for (const s of order) q = q.orderBy(s.field, s.dir);
    q = q.limit(limit);
    if (offset > 0) q = q.offset(offset);
    return [...(await exec(t, q))];
  }

  async function getRow(t: Tx, who: Who, e: Entity, p: AccessPolicy, id: string): Promise<Row | null> {
    if (!UUID_RE.test(id)) return null;
    const conds = [sql<SqlBool>`${sql.ref("id")} = ${id}`, ...constraintConds(p.rowConstraint("read"))];
    return (await selectDocs(t, who, e, conds, [], 1))[0] ?? null;
  }

  async function countRows(t: Tx, who: Who, e: Entity, conds: Expression<SqlBool>[], cap: number) {
    await ensure(t, who);
    const inner = from(e.name)
      .select(sql`1`.as("one"))
      .where(() => and(conds))
      .limit(cap);
    const rows = await exec(t, qb.selectFrom(inner.as("s")).select(sql<number>`count(*)::int`.as("n")));
    return Number(rows[0]?.n ?? 0);
  }

  // ---------- writes ----------

  function applyCreateConstraint(p: AccessPolicy, fields: Record<string, unknown>): void {
    const c = p.rowConstraint("create");
    if (c === false) throw new WizardError("FORBIDDEN");
    if (c === null) return;
    for (const [col, v] of Object.entries(c)) {
      const given = fields[col];
      if (given !== undefined && given !== null && String(given) !== String(v))
        throw new WizardError("FORBIDDEN");
      fields[col] = v;
    }
  }

  function checkUpdateConstraint(p: AccessPolicy, fields: Record<string, unknown>): void {
    const c = p.rowConstraint("update");
    if (!c) return;
    for (const [col, v] of Object.entries(c)) {
      if (Object.hasOwn(fields, col) && String(fields[col]) !== String(v)) throw new WizardError("FORBIDDEN");
    }
  }

  /**
   * Consent on create of a PII entity, or on update that writes a PII field (runtime.yaml#data_api).
   * true — consent was required and is valid: the write is journaled in _w_consents.
   */
  function checkConsent(
    subject: Subject,
    e: Entity,
    consent: unknown,
    written?: Record<string, unknown>,
  ): boolean {
    if (subject.role === SYSTEM_ROLE || subject.isAdmin) return false;
    const pii = e.fields.filter((f) => (f.pii ?? (f.type === "file" ? "basic" : "none")) !== "none");
    if (pii.length === 0) return false;
    if (written && !pii.some((f) => Object.hasOwn(written, f.name))) return false;
    if (!consentMatches(compliance, consent)) throw new WizardError("CONSENT_REQUIRED");
    return true;
  }

  /** compliance.yaml#system_package.consent.runtime: journal row {entity, row_id, policy_version, text hash, ip_hmac}. */
  async function journalConsent(t: Tx, e: Entity, id: string, ipHmac: Uint8Array | null | undefined) {
    await ensure(t, "system");
    await exec(
      t,
      qb
        .withSchema(schema)
        .insertInto("_w_consents")
        .values({
          entity: e.name,
          row_id: id,
          policy_version: compliance.policyVersion,
          consent_text_hash: Buffer.from(compliance.consentTextHash, "hex"),
          ip_hmac: ipHmac ? Buffer.from(ipHmac) : null,
        }),
    );
  }

  /** ref exists and is visible to the writer (runtime.yaml#data_api.writes). */
  async function checkRefs(t: Tx, who: Who, e: Entity, fields: Record<string, unknown>): Promise<void> {
    const issues: { field: string; code: string; message: string }[] = [];
    for (const f of e.fields) {
      const v = fields[f.name];
      if (f.type !== "ref" || v === null || v === undefined || !f.ref) continue;
      const target = f.ref.entity;
      let found = false;
      if (target === "users") {
        await ensure(t, "system");
        found = (await exec(t, from("users").select("id").where("id", "=", v))).length > 0;
      } else {
        const te = entities.get(target);
        if (te) {
          const tp = policyFor(t, who, te);
          found = tp.allows("read") && (await getRow(t, who, te, tp, String(v))) !== null;
        }
      }
      if (!found)
        issues.push({ field: f.name, code: "REF_NOT_FOUND", message: "Связанная запись не найдена" });
    }
    if (issues.length) throw fieldsError("VALIDATION_FAILED", issues);
  }

  /** Current values of the entity's file fields in row `id` (system context; {} when there are none). */
  async function fileValues(t: Tx, e: Entity, id: string): Promise<Record<string, string | null>> {
    const cols = e.fields.filter((f) => isFileFieldType(f.type)).map((f) => f.name);
    if (cols.length === 0 || !o.files || !UUID_RE.test(id)) return {};
    await ensure(t, "system");
    const row = (await exec(t, from(e.name).select(cols).where("id", "=", id)))[0];
    const out: Record<string, string | null> = {};
    for (const c of cols) out[c] = typeof row?.[c] === "string" ? (row[c] as string) : null;
    return out;
  }

  /**
   * runtime.yaml#files: a file value is the fileId of an upload for this entity.field by the writer (system context:
   * any upload of the field), not held by another row. Unchanged values are not re-checked; replaced ones are released.
   */
  async function checkFiles(
    t: Tx,
    who: Who,
    e: Entity,
    fields: Record<string, unknown>,
    id: string,
    old: Record<string, string | null>,
  ): Promise<void> {
    const guard = o.files;
    if (!guard) return;
    const issues: { field: string; code: string; message: string }[] = [];
    const detached: string[] = [];
    for (const f of e.fields) {
      if (!isFileFieldType(f.type) || !Object.hasOwn(fields, f.name)) continue;
      const v = fields[f.name];
      const prev = old[f.name] ?? null;
      if (v === prev) continue;
      if (prev) detached.push(prev);
      if (v === null || v === undefined) continue;
      const bad = (message = FILE_NOT_FOUND_RU) =>
        issues.push({ field: f.name, code: "FILE_NOT_FOUND", message });
      if (typeof v !== "string" || !FILE_ID_RE.test(v)) {
        bad();
        continue;
      }
      const s = who === "system" ? SYSTEM_SUBJECT : t.subject;
      const problem = await guard.check({
        entity: e.name,
        field: f.name,
        fileId: v,
        uploader: s.id,
        system: s.role === SYSTEM_ROLE,
      });
      if (problem) {
        bad(problem);
        continue;
      }
      await ensure(t, "system");
      const taken = await exec(
        t,
        from(e.name).select("id").where(f.name, "=", v).where("id", "<>", id).limit(1),
      );
      if (taken.length > 0) bad();
    }
    if (issues.length) throw fieldsError("VALIDATION_FAILED", issues);
    t.released.push(...detached);
  }

  async function audit(t: Tx, e: Entity, op: DataOp, id: string, fields: string[]): Promise<void> {
    await ensure(t, "system");
    const s = t.subject;
    const list: RawBuilder<unknown> = fields.length
      ? sql`ARRAY[${sql.join(fields)}]::text[]`
      : sql`'{}'::text[]`;
    await exec(
      t,
      qb
        .withSchema(schema)
        .insertInto("_w_audit")
        .values({ actor_user_id: s.id, role: s.role, entity: e.name, record_id: id, op, fields: list }),
    );
  }

  function values(e: Entity, fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      out[k] = toDb(columnType(e, k) ?? "text", v);
    }
    return out;
  }

  async function insertRow(
    t: Tx,
    who: Who,
    e: Entity,
    body: unknown,
    consent: ConsentCheck,
  ): Promise<string> {
    const p = policyFor(t, who, e);
    require(p, "create");
    const { fields, consent: bodyConsent } = splitBody(body);
    checkWritableKeys(e, p, fields);
    checkAllowedValues(p, fields);
    applyCreateConstraint(p, fields);
    checkValues(e, fields, "create");
    const journal =
      consent.check &&
      checkConsent(who === "system" ? SYSTEM_SUBJECT : t.subject, e, consent.value ?? bodyConsent);
    await checkRefs(t, who, e, fields);
    const id = randomUUID();
    await checkFiles(t, who, e, fields, id, {});
    for (const f of e.fields) {
      if (f.type === "qr_token")
        fields[f.name] = (await o.qrToken?.(e.name, f.name, id)) ?? randomBytes(24).toString("base64url");
    }
    await ensure(t, who);
    await exec(
      t,
      qb
        .withSchema(schema)
        .insertInto(e.name)
        .values({ ...values(e, fields), id }),
    );
    await audit(t, e, "create", id, Object.keys(fields));
    if (journal) await journalConsent(t, e, id, consent.ipHmac);
    t.pending.push({ entity: e.name, id, op: "insert" });
    return id;
  }

  async function patchRow(
    t: Tx,
    who: Who,
    e: Entity,
    id: string,
    body: unknown,
    consent: ConsentCheck,
  ): Promise<void> {
    const p = policyFor(t, who, e);
    require(p, "update");
    const { fields, consent: bodyConsent } = splitBody(body);
    checkWritableKeys(e, p, fields);
    checkUpdateConstraint(p, fields);
    checkValues(e, fields, "update");
    const journal =
      consent.check &&
      checkConsent(who === "system" ? SYSTEM_SUBJECT : t.subject, e, consent.value ?? bodyConsent, fields);
    if (!UUID_RE.test(id)) throw new WizardError("NOT_FOUND");
    const c = p.rowConstraint("update");
    if (c === false) throw new WizardError("NOT_FOUND");
    await checkRefs(t, who, e, fields);
    await checkFiles(t, who, e, fields, id, await fileValues(t, e, id));
    await ensure(t, who);
    const set = values(e, fields);
    const res = await exec(
      t,
      qb
        .withSchema(schema)
        .updateTable(e.name)
        .set(Object.keys(set).length ? set : { id: sql.ref("id") })
        .where(() => and([sql<SqlBool>`${sql.ref("id")} = ${id}`, ...constraintConds(c)])),
    );
    if (res.count === 0) throw new WizardError("NOT_FOUND");
    // After the row is found (a foreign row stays 404); the throw rolls the transaction back.
    checkAllowedValues(p, fields);
    await audit(t, e, "update", id, Object.keys(fields));
    if (journal) await journalConsent(t, e, id, consent.ipHmac);
    t.pending.push({ entity: e.name, id, op: "update" });
  }

  async function deleteRow(t: Tx, who: Who, e: Entity, id: string): Promise<void> {
    const p = policyFor(t, who, e);
    require(p, "delete");
    const c = p.rowConstraint("delete");
    if (!UUID_RE.test(id) || c === false) throw new WizardError("NOT_FOUND");
    const files = Object.values(await fileValues(t, e, id)).filter((v): v is string => v !== null);
    await ensure(t, who);
    const res = await exec(
      t,
      qb
        .withSchema(schema)
        .deleteFrom(e.name)
        .where(() => and([sql<SqlBool>`${sql.ref("id")} = ${id}`, ...constraintConds(c)])),
    );
    if (res.count === 0) throw new WizardError("NOT_FOUND");
    t.released.push(...files);
    await audit(t, e, "delete", id, []);
    t.pending.push({ entity: e.name, id, op: "delete" });
  }

  /** Document after a write: visible version for the writer, or just {id} without read access. */
  async function readBack(t: Tx, who: Who, e: Entity, id: string): Promise<Doc> {
    const p = policyFor(t, who, e);
    if (!p.allows("read")) return { id };
    const row = await getRow(t, who, e, p, id);
    return row ? shape(e, row, p.hidden) : { id };
  }

  // ---------- ctx.db / ctx.systemDb ----------

  function orderFor(e: Entity, where: RawWhere | undefined, dir: "asc" | "desc") {
    const keys = Object.keys(where ?? {}).filter((k) => where?.[k] !== undefined);
    const idx = resolveIndex(e, keys) ?? [];
    const fields = [...idx.filter((f) => f !== "created_at" && f !== "id"), "created_at", "id"];
    return fields.map((field) => ({ field, dir }));
  }

  function adapter(t: Tx, who: Who): DbAdapter {
    const run = <T>(fn: () => Promise<T>) => t.exclusive(fn);
    const read = (name: string) => {
      const e = entity(name);
      const p = policyFor(t, who, e);
      require(p, "read");
      return { e, p };
    };
    return {
      get: (name, id) =>
        run(async () => {
          const { e, p } = read(name);
          const row = await getRow(t, who, e, p, id);
          return row ? shape(e, row, p.hidden) : null;
        }),
      getBy: (name, field, value) =>
        run(async () => {
          const { e, p } = read(name);
          const conds = [
            ...whereConds(e, p, { [field]: value }),
            ...constraintConds(p.rowConstraint("read")),
          ];
          const row = (await selectDocs(t, who, e, conds, [], 1))[0];
          return row ? shape(e, row, p.hidden) : null;
        }),
      list: (name, q) =>
        run(async () => {
          const { e, p } = read(name);
          const conds = [...whereConds(e, p, q.where), ...constraintConds(p.rowConstraint("read"))];
          const rows = await selectDocs(t, who, e, conds, orderFor(e, q.where, q.order), q.limit);
          return rows.map((r) => shape(e, r, p.hidden));
        }),
      count: (name, where) =>
        run(async () => {
          const { e, p } = read(name);
          const conds = [...whereConds(e, p, where), ...constraintConds(p.rowConstraint("read"))];
          return countRows(t, who, e, conds, 1_000_000);
        }),
      paginate: (name, q, page) =>
        run(async () => {
          const { e, p } = read(name);
          const offset = page.cursor ? Number(Buffer.from(page.cursor, "base64url").toString()) : 0;
          if (!Number.isSafeInteger(offset) || offset < 0)
            throw new WizardError("VALIDATION_FAILED", { message: "Неверный курсор" });
          const conds = [...whereConds(e, p, q.where), ...constraintConds(p.rowConstraint("read"))];
          const rows = await selectDocs(
            t,
            who,
            e,
            conds,
            orderFor(e, q.where, q.order),
            page.numItems + 1,
            offset,
          );
          const isDone = rows.length <= page.numItems;
          const items = rows.slice(0, page.numItems).map((r) => shape(e, r, p.hidden));
          const next = Buffer.from(String(offset + items.length)).toString("base64url");
          return { items: items as RawDoc[], continueCursor: isDone ? null : next, isDone };
        }),
      insert: (name, doc) => run(() => insertRow(t, who, entity(name), doc, { check: false })),
      patch: (name, id, patch) => run(() => patchRow(t, who, entity(name), id, patch, { check: false })),
      delete: (name, id) => run(() => deleteRow(t, who, entity(name), id)),
    };
  }

  function scheduler(t: Tx): SchedulerAdapter {
    return {
      enqueue: (job) =>
        t.exclusive(async () => {
          await ensure(t, "system");
          const id = randomUUID();
          const payload = jsonb({ name: job.name, args: job.args ?? null });
          await exec(
            t,
            qb
              .withSchema(schema)
              .insertInto("_w_jobs")
              .values({ id, kind: "function", payload, run_at: job.runAt }),
          );
          return id;
        }),
      cancel: (jobId) =>
        t.exclusive(async () => {
          if (!UUID_RE.test(jobId)) return;
          await ensure(t, "system");
          await exec(
            t,
            qb
              .withSchema(schema)
              .deleteFrom("_w_jobs")
              .where("id", "=", jobId)
              .where("locked_until", "is", null),
          );
        }),
    };
  }

  function dataTx(t: Tx): DataTx {
    return {
      get subject() {
        return t.subject;
      },
      now: t.now,
      data: adapter(t, "subject"),
      system: adapter(t, "system"),
      scheduler: scheduler(t),
      sql: t.sql,
      invalidate: (ev) => {
        t.pending.push(ev);
      },
    };
  }

  // ---------- data API ----------

  const api: DataAccess = {
    spec,
    schema,
    events,
    subjectFor,
    publicSubject,

    list: (subject, name, q: ListQuery) =>
      withTx("default", subject, async (t): Promise<ListResult> => {
        const e = entity(name);
        const p = policyFor(t, "subject", e);
        require(p, "read");
        const filters = checkFilters(e, p, q.filter);
        const sort = q.sort.length ? q.sort : [{ field: "created_at", dir: "desc" as const }];
        for (const s of sort) checkVisibleColumn(e, p, s.field);
        const order = [
          ...sort,
          ...(sort.some((s) => s.field === "id") ? [] : [{ field: "id", dir: "asc" as const }]),
        ];
        const conds = [...constraintConds(p.rowConstraint("read")), ...filterConds(filters)];
        if (q.search) conds.push(searchCond(searchColumns(e, p), q.search));
        const rows = await selectDocs(t, "subject", e, conds, order, q.limit, (q.page - 1) * q.limit);
        const n = await countRows(t, "subject", e, conds, MAX_TOTAL + 1);
        return {
          items: rows.map((r) => shape(e, r, p.hidden)),
          page: q.page,
          limit: q.limit,
          total: Math.min(n, MAX_TOTAL),
          hasMore: q.page * q.limit < n,
          ...(n > MAX_TOTAL ? { totalCapped: true as const } : {}),
        };
      }),

    get: (subject, name, id) =>
      withTx("default", subject, async (t) => {
        const e = entity(name);
        const p = policyFor(t, "subject", e);
        require(p, "read");
        const row = await getRow(t, "subject", e, p, id);
        if (!row) throw new WizardError("NOT_FOUND");
        return shape(e, row, p.hidden);
      }),

    create: (subject, name, body, w?: WriteOptions) =>
      withTx("default", subject, async (t) => {
        const e = entity(name);
        const id = await insertRow(t, "subject", e, body, {
          check: true,
          value: w?.consent,
          ipHmac: w?.ipHmac,
        });
        return readBack(t, "subject", e, id);
      }),

    update: (subject, name, id, body, w?: WriteOptions) =>
      withTx("default", subject, async (t) => {
        const e = entity(name);
        await patchRow(t, "subject", e, id, body, {
          check: true,
          value: w?.consent,
          ipHmac: w?.ipHmac,
        });
        return readBack(t, "subject", e, id);
      }),

    remove: (subject, name, id) =>
      withTx("default", subject, async (t) => {
        await deleteRow(t, "subject", entity(name), id);
      }),

    transaction: (mode, subject, fn) => withTx(mode, subject, (t) => fn(dataTx(t))),

    runner(): TransactionRunner {
      return {
        run: (mode, user, fn) => {
          const subject: Subject =
            user.role === SYSTEM_ROLE
              ? SYSTEM_SUBJECT
              : { id: user.id, role: user.role, isAdmin: user.isAdmin, record: {} };
          return withTx(
            mode,
            subject,
            (t) => {
              const d = dataTx(t);
              return fn({ db: d.data, systemDb: d.system, scheduler: d.scheduler, now: d.now });
            },
            subject.id,
          );
        },
      };
    },
  };
  return api;
}
