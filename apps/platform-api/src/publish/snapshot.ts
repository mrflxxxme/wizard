// draft_snapshot (workflows.yaml#workflows.build.steps.draft_snapshot, L4-11): rows of app_<key>_prod → app_<key>_draft
// (≤ 1000 per entity), every value of a field with pii ≠ none replaced by synthetic data deterministically by row id.
import { createHash, randomBytes } from "node:crypto";
import {
  type AppSpec,
  DEFAULT_MAX_LENGTH,
  type Field,
  quoteIdent,
  systemRoleName,
  textLiteral,
} from "@wizard/appspec";
import { SYNTHETIC_NAMES } from "@wizard/gates";
import { schemaName } from "@wizard/runtime";
import type postgres from "postgres";
import { MIGRATOR_ROLE } from "../agents/draft.js";

export const SNAPSHOT_LIMIT = 1000;
const MARKER_PREFIX = "wz_snapshot:";
const USERS = "users";
const INSERT_CHUNK = 200;

/** Columns of the system users table that hold personal data (runtime.yaml#postgres.system_tables). */
const USER_PII: Record<string, Field["type"] | "name" | "drop"> = {
  display_name: "name",
  email: "email",
  phone: "phone",
  telegram_id: "drop",
  telegram_chat_id: "drop",
  attrs: "drop",
};

export interface SnapshotInput {
  systemKey: string;
  /** Specs that describe prod columns: prod revision, schema high-water mark, draft (first match wins per field). */
  specs: AppSpec[];
  /** Identity of the prod state (live publication id): a draft already copied from it is not copied again. */
  marker: string;
  migratorRole?: string;
  limit?: number;
}

export interface SnapshotResult {
  skipped: boolean;
  rows: Record<string, number>;
  users: number;
}

type Row = Record<string, unknown>;
type Col = { nullable: boolean };

/** Field of an entity column (union over specs); system columns have none. */
function fieldIndex(specs: AppSpec[]): Map<string, Map<string, Field>> {
  const out = new Map<string, Map<string, Field>>();
  for (const s of specs)
    for (const e of s.entities) {
      const m = out.get(e.name) ?? new Map<string, Field>();
      for (const f of e.fields) if (!m.has(f.name)) m.set(f.name, f);
      out.set(e.name, m);
    }
  return out;
}

const isPii = (f: Field): boolean =>
  (f.pii ?? (f.type === "file" ? "basic" : "none")) !== "none" || f.type === "email" || f.type === "phone";

type Shape = "name" | "email" | "phone" | "address" | "text";

function shapeOf(f: Field): Shape {
  if (f.type === "email") return "email";
  if (f.type === "phone") return "phone";
  const k = f.piiKind;
  if (k === "fio") return "name";
  if (k === "email" || k === "phone" || k === "address") return k;
  const n = `${f.name} ${f.label}`.toLowerCase();
  if (/(^|_|\s)(name|fio|фио|имя|фамилия)/.test(n) || n.includes("full_name")) return "name";
  if (/mail|почт/.test(n)) return "email";
  if (/phone|tel|телефон/.test(n)) return "phone";
  if (/addr|адрес/.test(n)) return "address";
  return "text";
}

/** Same shapes as the G1 seed (gates isSyntheticValue recognizes every one of them). */
function synthetic(shape: Shape, n: number): string {
  switch (shape) {
    case "name": {
      const female = n % 2 === 1;
      const first = (female ? SYNTHETIC_NAMES.female : SYNTHETIC_NAMES.male)[Math.floor(n / 2) % 6];
      const stem = SYNTHETIC_NAMES.surnames[(n * 5) % 6];
      return `${first} ${female ? `${stem}а` : stem}`;
    }
    case "email":
      return `user${n}@example.test`;
    case "phone":
      return `+7999000${String(n % 10_000).padStart(4, "0")}`;
    case "address":
      return `ул. Тестовая, д. ${n}`;
    default:
      return `Тестовый текст ${n}`;
  }
}

function numberFor(id: string, col: string, bump: number): number {
  const h = createHash("sha256").update(`${id}\u0000${col}\u0000${bump}`).digest();
  return 1_000_000 + (h.readUInt32BE(0) % 900_000_000);
}

const clip = (s: string, max: number | undefined) =>
  max !== undefined && s.length > max ? s.slice(0, max) : s;

class Masker {
  /** Values already taken per table.column (unique constraints must survive masking). */
  readonly used = new Map<string, Set<string>>();

  reserve(key: string, values: Iterable<unknown>): void {
    const set = this.used.get(key) ?? new Set<string>();
    for (const v of values) if (v !== null && v !== undefined) set.add(String(v));
    this.used.set(key, set);
  }

  text(key: string, id: string, col: string, shape: Shape, max?: number): string {
    const set = this.used.get(key) ?? new Set<string>();
    this.used.set(key, set);
    for (let bump = 0; ; bump++) {
      const v = clip(synthetic(shape, numberFor(id, col, bump)), max);
      if (!set.has(v) || bump > 50) {
        set.add(v);
        return v;
      }
    }
  }

  /** Synthetic value of a PII field; undefined → NULL (when the column allows it). */
  field(table: string, id: string, f: Field): unknown {
    const n = numberFor(id, f.name, 0);
    switch (f.type) {
      case "string":
      case "text":
      case "email":
      case "phone":
      case "url":
        if (f.type === "url") return `https://example.test/${table}/${n}`;
        return this.text(
          `${table}.${f.name}`,
          id,
          f.name,
          shapeOf(f),
          f.maxLength ?? DEFAULT_MAX_LENGTH[f.type],
        );
      case "int":
        return Math.max(f.min ?? 0, Math.min(f.max ?? n, n));
      case "decimal":
      case "money":
        return f.min ?? 0;
      case "bool":
        return false;
      case "date":
        return "2000-01-01";
      case "datetime":
        return "2000-01-01T00:00:00.000Z";
      case "enum":
        return f.enum?.[0]?.value ?? null;
      case "json":
        return {};
      default:
        return undefined; // file keys, refs, tokens: never copied as personal data
    }
  }
}

/** Entities ordered so that required refs point to earlier ones; cycles keep the given order. */
function orderTables(tables: string[], fields: Map<string, Map<string, Field>>): string[] {
  const out: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (t: string) => {
    if (done.has(t) || visiting.has(t)) return;
    visiting.add(t);
    for (const f of fields.get(t)?.values() ?? []) {
      const target = f.type === "ref" ? f.ref?.entity : undefined;
      if (target && target !== t && tables.includes(target)) visit(target);
    }
    visiting.delete(t);
    done.add(t);
    out.push(t);
  };
  for (const t of tables) visit(t);
  return out;
}

async function insertRows(
  tx: postgres.TransactionSql,
  schema: string,
  table: string,
  cols: string[],
  rows: unknown[][],
  onConflict: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((r) => {
      const ph = r.map((v) => {
        params.push(v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v);
        return `$${params.length}`;
      });
      return `(${ph.join(", ")})`;
    });
    const res = await tx.unsafe(
      `insert into ${quoteIdent(schema)}.${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")}) values ${tuples.join(", ")} ${onConflict} returning ${quoteIdent("id")}`,
      params as never[],
    );
    for (const r of res) ids.push(String(r.id));
  }
  return ids;
}

/**
 * Copies prod into draft once per prod state. Entity tables of the draft are emptied first; draft users (seed and
 * dev-<role>) stay, prod users are added with masked contacts. Refs to rows that were not copied become NULL, or
 * the row is skipped when the column is NOT NULL. Runs as the migrator role (owner of both schemas).
 */
export async function draftSnapshot(pg: postgres.Sql, i: SnapshotInput): Promise<SnapshotResult> {
  const draft = schemaName(i.systemKey, "draft");
  const prod = schemaName(i.systemKey, "prod");
  const limit = i.limit ?? SNAPSHOT_LIMIT;
  const marker = `${MARKER_PREFIX}${i.marker}`;
  const result: SnapshotResult = { skipped: true, rows: {}, users: 0 };
  const fields = fieldIndex(i.specs);
  const masker = new Masker();

  await pg.begin(async (tx) => {
    const ns = await tx<{ nspname: string; note: string | null }[]>`
      select nspname, obj_description(oid, 'pg_namespace') as note
      from pg_catalog.pg_namespace where nspname in (${draft}, ${prod})`;
    const draftNs = ns.find((x) => x.nspname === draft);
    if (!draftNs || !ns.some((x) => x.nspname === prod) || draftNs.note === marker) return;
    // DDL-level work (TRUNCATE, COMMENT) as the schema owner; row reads/writes as each schema's system DB role
    // (FORCE RLS; security/isolation.yaml#db_access, L3-20).
    const migrator = i.migratorRole ?? MIGRATOR_ROLE;
    const as = (role: string) => tx.unsafe(`SET LOCAL ROLE ${quoteIdent(role)}`);
    await as(migrator);

    const colRows = await tx<
      { table_schema: string; table_name: string; column_name: string; is_nullable: string }[]
    >`
      select table_schema, table_name, column_name, is_nullable from information_schema.columns
      where table_schema in (${draft}, ${prod}) order by ordinal_position`;
    const cols = (schema: string) => {
      const m = new Map<string, Map<string, Col>>();
      for (const r of colRows.filter((x) => x.table_schema === schema)) {
        const t = m.get(r.table_name) ?? new Map<string, Col>();
        t.set(r.column_name, { nullable: r.is_nullable === "YES" });
        m.set(r.table_name, t);
      }
      return m;
    };
    const dCols = cols(draft);
    const pCols = cols(prod);
    const isEntity = (t: string) => t !== USERS && !t.startsWith("_w_");
    const draftEntities = [...dCols.keys()].filter(isEntity);
    if (draftEntities.length > 0)
      await tx.unsafe(
        `TRUNCATE ${draftEntities.map((t) => `${quoteIdent(draft)}.${quoteIdent(t)}`).join(", ")} CASCADE`,
      );

    // users: draft ones stay; prod ones are copied with synthetic contacts.
    const ids = new Map<string, Set<string>>();
    await as(systemRoleName(draft));
    const existing = await tx.unsafe(
      `select ${quoteIdent("id")}, ${quoteIdent("email")}, ${quoteIdent("phone")} from ${quoteIdent(draft)}.${quoteIdent(USERS)}`,
    );
    masker.reserve(
      "users.email",
      existing.map((r) => r.email),
    );
    masker.reserve(
      "users.phone",
      existing.map((r) => r.phone),
    );
    const userIds = new Set(existing.map((r) => String(r.id)));
    const uCols = [...(pCols.get(USERS)?.keys() ?? [])].filter(
      (c) => dCols.get(USERS)?.has(c) && USER_PII[c] !== "drop",
    );
    if (uCols.length > 0 && uCols.includes("id")) {
      await as(systemRoleName(prod));
      const prodUsers = await tx.unsafe(
        `select ${uCols.map(quoteIdent).join(", ")} from ${quoteIdent(prod)}.${quoteIdent(USERS)} order by ${quoteIdent("created_at")} desc, ${quoteIdent("id")} limit ${limit}`,
      );
      const rows = prodUsers.map((u) =>
        uCols.map((c) => {
          const kind = USER_PII[c];
          if (!kind || u[c] === null) return u[c];
          const shape: Shape = kind === "name" ? "name" : kind === "email" ? "email" : "phone";
          return masker.text(`users.${c}`, String(u.id), c, shape, c === "phone" ? 16 : 254);
        }),
      );
      await as(systemRoleName(draft));
      const inserted = await insertRows(tx, draft, USERS, uCols, rows, "on conflict do nothing");
      for (const id of inserted) userIds.add(id);
      result.users = inserted.length;
    }
    ids.set(USERS, userIds);

    const tables = orderTables(
      draftEntities.filter((t) => pCols.has(t)),
      fields,
    );
    for (const t of tables) {
      const d = dCols.get(t) as Map<string, Col>;
      const p = pCols.get(t) as Map<string, Col>;
      const f = fields.get(t) ?? new Map<string, Field>();
      // Only system columns and columns some spec describes (unknown columns may hold anything).
      const shared = [...p.keys()].filter(
        (c) => d.has(c) && (["id", "created_at", "updated_at", "created_by"].includes(c) || f.has(c)),
      );
      if (!shared.includes("id")) continue;
      await as(systemRoleName(prod));
      const src = await tx.unsafe(
        `select ${shared.map(quoteIdent).join(", ")} from ${quoteIdent(prod)}.${quoteIdent(t)} order by ${quoteIdent("created_at")} desc, ${quoteIdent("id")} limit ${limit}`,
      );
      const batch = new Set(src.map((r) => String(r.id)));
      const rows: unknown[][] = [];
      for (const r of src as Row[]) {
        const id = String(r.id);
        let keep = true;
        const values = shared.map((c) => {
          const field = f.get(c);
          const v = r[c];
          if (!field || v === null || v === undefined) return v;
          if (field.type === "ref") {
            const target = field.ref?.entity ?? "";
            const known = ids.get(target)?.has(String(v)) || (target === t && batch.has(String(v)));
            if (known) return v;
            if (!d.get(c)?.nullable) keep = false;
            return null;
          }
          if (field.type === "qr_token") return randomBytes(24).toString("base64url");
          if (!isPii(field)) return v;
          const masked = masker.field(t, id, field);
          if (masked === undefined && !d.get(c)?.nullable) keep = false;
          return masked ?? null;
        });
        if (keep) rows.push(values);
      }
      await as(systemRoleName(draft));
      const inserted = await insertRows(tx, draft, t, shared, rows, "");
      ids.set(t, new Set(inserted));
      result.rows[t] = inserted.length;
    }
    await as(migrator);
    await tx.unsafe(`COMMENT ON SCHEMA ${quoteIdent(draft)} IS ${textLiteral(marker)}`);
    result.skipped = false;
  });
  return result;
}
