// Subject requests of a system admin (security/compliance.yaml#system_package.subject_requests): find the rows of
// a data subject by email or phone → export them or erase them (pii → NULL, journal mode subject_request).
import { type Entity, quoteIdent, SYSTEM_ROLE } from "@wizard/appspec";
import type postgres from "postgres";
import { SYSTEM_SUBJECT } from "../data/access.js";
import { fieldsError } from "../data/validate.js";
import type { LoadedSystem } from "../system.js";
import { anonymizeRows, anonymizeUsers, type DeletionEntry, logDeletions } from "./erasure.js";

type Tx = postgres.TransactionSql;
type Row = Record<string, unknown>;

export interface SubjectQuery {
  email: string | null;
  /** Digits only, Russian 8XXXXXXXXXX normalized to 7XXXXXXXXXX. */
  phone: string | null;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** {email?, phone?} of a request body; at least one, validated. */
export function parseSubjectQuery(body: Record<string, unknown>): SubjectQuery {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  let phone = typeof body.phone === "string" ? body.phone.replace(/\D/g, "") : "";
  if (phone.length === 11 && phone.startsWith("8")) phone = `7${phone.slice(1)}`;
  const issues: { field: string; code: string; message: string }[] = [];
  if (email && !EMAIL_RE.test(email))
    issues.push({ field: "email", code: "INVALID_FORMAT", message: "Неверный email" });
  if (phone && (phone.length < 10 || phone.length > 15))
    issues.push({ field: "phone", code: "INVALID_FORMAT", message: "Неверный телефон" });
  if (!email && !phone)
    issues.push({ field: "email", code: "REQUIRED", message: "Укажите email или телефон субъекта" });
  if (issues.length) throw fieldsError("VALIDATION_FAILED", issues);
  return { email: email || null, phone: phone || null };
}

const T = (schema: string, table: string) => `${quoteIdent(schema)}.${quoteIdent(table)}`;
const digits = (col: string) => `regexp_replace(${col}, '\\D', '', 'g')`;

/** WHERE of the subject's rows with its own parameter list (only the parameters it references). */
interface Where {
  sql: string;
  params: never[];
}

/** Contact columns equal to the subject's email/phone, or the ownerField among the subject's users. */
function subjectWhere(
  emailCols: string[],
  phoneCols: string[],
  ownerField: string | undefined,
  q: SubjectQuery,
  users: readonly string[],
): Where | null {
  const params: unknown[] = [];
  const conds: string[] = [];
  if (q.email && emailCols.length) {
    params.push(q.email);
    conds.push(...emailCols.map((c) => `lower(${quoteIdent(c)}) = $${params.length}::text`));
  }
  if (q.phone && phoneCols.length) {
    params.push(q.phone);
    conds.push(...phoneCols.map((c) => `${digits(quoteIdent(c))} = $${params.length}::text`));
  }
  if (ownerField && users.length) {
    params.push(users);
    conds.push(`${quoteIdent(ownerField)} = any($${params.length}::uuid[])`);
  }
  return conds.length ? { sql: conds.join(" or "), params: params as never[] } : null;
}

const entityWhere = (e: Entity, q: SubjectQuery, users: readonly string[]) =>
  subjectWhere(
    e.fields.filter((f) => f.type === "email").map((f) => f.name),
    e.fields.filter((f) => f.type === "phone").map((f) => f.name),
    e.ownerField,
    q,
    users,
  );

async function matchUsers(tx: Tx, schema: string, q: SubjectQuery): Promise<string[]> {
  const w = subjectWhere(["email"], ["phone"], undefined, q, []);
  if (!w) return [];
  const rows = await tx.unsafe(`select id::text as id from ${T(schema, "users")} where ${w.sql}`, w.params);
  return rows.map((r) => String(r.id));
}

export interface SubjectSummary {
  users: number;
  entities: { entity: string; label: string; rows: number }[];
}

/** Counts only (the admin page shows them before export or erase). */
export async function findSubject(sys: LoadedSystem, q: SubjectQuery): Promise<SubjectSummary> {
  return sys.data.transaction("default", SYSTEM_SUBJECT, async (d) => {
    const users = await matchUsers(d.sql, sys.schema, q);
    const out: SubjectSummary = { users: users.length, entities: [] };
    for (const e of sys.spec.entities) {
      const w = entityWhere(e, q, users);
      if (!w) continue;
      const [r] = await d.sql.unsafe(
        `select count(*)::int as n from ${T(sys.schema, e.name)} where ${w.sql}`,
        w.params,
      );
      const n = Number(r?.n ?? 0);
      if (n > 0) out.entities.push({ entity: e.name, label: e.label, rows: n });
    }
    return out;
  });
}

function jsonValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return null;
  return v;
}

/** Fields of an exported row: no qr_token (a credential); file → its name only (runtime.yaml#files). */
function exportRow(e: Entity, r: Row): Row {
  const out: Row = { id: r.id, created_at: jsonValue(r.created_at) };
  for (const f of e.fields) {
    if (f.type === "qr_token") continue;
    const v = r[f.name];
    out[f.name] = f.type === "file" && typeof v === "string" ? (v.split("/").pop() ?? v) : jsonValue(v);
  }
  return out;
}

const USER_COLS = [
  "id",
  "role",
  "display_name",
  "email",
  "phone",
  "telegram_id",
  "created_at",
  "last_login_at",
];

export interface SubjectExport {
  generatedAt: string;
  system: string;
  subject: { email: string | null; phone: string | null };
  users: Row[];
  entities: { entity: string; label: string; rows: Row[] }[];
  consents: { entity: string; rowId: string; policyVersion: string; givenAt: string }[];
}

async function auditAdmin(tx: Tx, schema: string, admin: string, op: string, fields: string[]) {
  await tx.unsafe(
    `insert into ${T(schema, "_w_audit")} (actor_user_id, role, entity, op, fields)
     values ($1, $2, 'users', $3, $4::text[])`,
    [admin, SYSTEM_ROLE, op, fields as never],
  );
}

/** Everything the system holds about the subject (ст. 14), as JSON for the admin to hand over. */
export async function exportSubject(
  sys: LoadedSystem,
  q: SubjectQuery,
  adminId: string,
  now: Date,
): Promise<SubjectExport> {
  return sys.data.transaction("default", SYSTEM_SUBJECT, async (d) => {
    const tx = d.sql;
    const users = await matchUsers(tx, sys.schema, q);
    const out: SubjectExport = {
      generatedAt: now.toISOString(),
      system: sys.spec.app.name,
      subject: { email: q.email, phone: q.phone },
      users: [],
      entities: [],
      consents: [],
    };
    if (users.length) {
      const rows = await tx.unsafe(`select * from ${T(sys.schema, "users")} where id = any($1::uuid[])`, [
        users as never,
      ]);
      out.users = rows.map((r) =>
        Object.fromEntries(USER_COLS.filter((c) => c in r).map((c) => [c, jsonValue(r[c])])),
      );
    }
    const rowIds: string[] = [...users];
    for (const e of sys.spec.entities) {
      const w = entityWhere(e, q, users);
      if (!w) continue;
      const rows = await tx.unsafe(
        `select * from ${T(sys.schema, e.name)} where ${w.sql} order by created_at, id limit 10000`,
        w.params,
      );
      if (!rows.length) continue;
      out.entities.push({ entity: e.name, label: e.label, rows: rows.map((r) => exportRow(e, r)) });
      rowIds.push(...rows.map((r) => String(r.id)));
    }
    if (rowIds.length) {
      const rows = await tx.unsafe(
        `select entity, row_id::text as row_id, policy_version, given_at from ${T(sys.schema, "_w_consents")}
         where row_id = any($1::uuid[]) order by given_at`,
        [rowIds as never],
      );
      out.consents = rows.map((r) => ({
        entity: String(r.entity),
        rowId: String(r.row_id),
        policyVersion: String(r.policy_version),
        givenAt: String(jsonValue(r.given_at)),
      }));
    }
    await auditAdmin(
      tx,
      sys.schema,
      adminId,
      "subject_export",
      out.entities.map((x) => x.entity),
    );
    return out;
  });
}

/**
 * Erasure on a subject request: matching users are anonymized and blocked, pii fields of matching rows → NULL
 * (business records stay for reports, like retention anonymize). Journal mode subject_request.
 */
export async function eraseSubject(
  sys: LoadedSystem,
  q: SubjectQuery,
  adminId: string,
): Promise<{ entries: DeletionEntry[]; pending: string[] }> {
  return sys.data.transaction("default", SYSTEM_SUBJECT, async (d) => {
    const tx = d.sql;
    const users = await matchUsers(tx, sys.schema, q);
    const entries: DeletionEntry[] = [];
    const pending: string[] = [];
    for (const e of sys.spec.entities) {
      const w = entityWhere(e, q, users);
      if (!w) continue;
      const r = await anonymizeRows(tx, sys.schema, e, w.sql, w.params);
      if (r === null) pending.push(e.name);
      else entries.push({ entity: e.name, mode: "subject_request", rows: r.rows, fields: r.fields });
    }
    // Users last: rows above are matched by the users' contacts and ids.
    entries.push({
      entity: "users",
      mode: "subject_request",
      rows: await anonymizeUsers(tx, sys.schema, users, true),
      fields: ["email", "phone", "telegram_id", "telegram_chat_id", "display_name"],
    });
    await logDeletions(tx, sys.schema, entries);
    await auditAdmin(
      tx,
      sys.schema,
      adminId,
      pending.length ? "subject_erase_pending" : "subject_erase",
      entries.filter((x) => x.rows > 0).map((x) => x.entity),
    );
    return { entries: entries.filter((x) => x.rows > 0), pending };
  });
}
