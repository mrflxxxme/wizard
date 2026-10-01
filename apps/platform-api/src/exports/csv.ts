// CSV of a data export (workflows.yaml#workflows.export_data): UTF-8 with BOM, ';' separator, RFC 4180 quoting,
// CRLF rows; formula injection is neutralized (L3-37). Column choice: qr_token, fields hidden from every role and
// (without the owner's explicit consent) personal data are left out.
import { type AppSpec, type Field, SYSTEM_FIELDS, USERS_ENTITY } from "@wizard/appspec";

export const CSV_BOM = "﻿";
export const CSV_SEPARATOR = ";";

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const NEEDS_QUOTES = /[;,"\r\n]|^\s|\s$/;
const NUMERIC: ReadonlySet<string> = new Set(["int", "decimal", "money"]);

/** A cell starting with = + - @ TAB or CR gets a leading apostrophe; a plain number of a numeric column is kept. */
export function neutralizeFormula(value: string, numeric = false): string {
  if (numeric && PLAIN_NUMBER.test(value)) return value;
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** One CSV cell: null → empty; formula neutralized, then RFC 4180 quoting (quotes doubled). */
export function csvCell(value: string | null | undefined, numeric = false): string {
  if (value === null || value === undefined) return "";
  const v = neutralizeFormula(value, numeric);
  return NEEDS_QUOTES.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** One CSV record terminated by CRLF. */
export function csvRow(cells: readonly string[]): string {
  return `${cells.join(CSV_SEPARATOR)}\r\n`;
}

export interface ExportColumn {
  name: string;
  numeric: boolean;
  pii: boolean;
}

export interface TablePlan {
  /** Table of app_<key>_<env> and the CSV name (<table>.csv). */
  table: string;
  columns: ExportColumn[];
}

export interface ExportPlan {
  tables: TablePlan[];
  /** Personal-data columns left out (includePii = false). */
  omittedPii: number;
}

/** Personal data as draft_snapshot treats it: pii ≠ none (file without pii — basic), and every email/phone. */
export function isPiiField(f: Field): boolean {
  return (
    (f.pii ?? (f.type === "file" ? "basic" : "none")) !== "none" || f.type === "email" || f.type === "phone"
  );
}

/** A field that every role reading the entity has in hiddenFields (workflows.yaml export_data: not exported). */
export function hiddenForAll(spec: AppSpec, entity: string, field: string): boolean {
  const readers = (spec.permissions ?? []).filter((p) => p.entity === entity && p.ops.includes("read"));
  return readers.length > 0 && readers.every((p) => (p.hiddenFields ?? []).includes(field));
}

/** Columns of the system users table (runtime.yaml#postgres.system_tables) that go to users.csv. */
const USER_COLUMNS: ExportColumn[] = [
  { name: "id", numeric: false, pii: false },
  { name: "role", numeric: false, pii: false },
  { name: "display_name", numeric: false, pii: true },
  { name: "email", numeric: false, pii: true },
  { name: "phone", numeric: false, pii: true },
  { name: "telegram_id", numeric: true, pii: true },
  { name: "invited_by", numeric: false, pii: false },
  { name: "created_at", numeric: false, pii: false },
  { name: "last_login_at", numeric: false, pii: false },
  { name: "blocked_at", numeric: false, pii: false },
];

function fieldColumns(spec: AppSpec, entity: string, fields: readonly Field[]): ExportColumn[] {
  return fields
    .filter((f) => f.type !== "qr_token" && !hiddenForAll(spec, entity, f.name))
    .map((f) => ({ name: f.name, numeric: NUMERIC.has(f.type), pii: isPiiField(f) }));
}

/** Tables and columns of an export of `spec`: users first, then the entities in spec order. */
export function planExport(spec: AppSpec, o: { includePii: boolean }): ExportPlan {
  const tables: TablePlan[] = [];
  const usersEntity = spec.entities.find((e) => e.name === USERS_ENTITY);
  const userCols = [...USER_COLUMNS];
  for (const c of usersEntity ? fieldColumns(spec, USERS_ENTITY, usersEntity.fields) : [])
    if (!userCols.some((u) => u.name === c.name)) userCols.push(c);
  tables.push({ table: USERS_ENTITY, columns: userCols });
  for (const e of spec.entities) {
    if (e.name === USERS_ENTITY) continue;
    const system = SYSTEM_FIELDS.map((name) => ({ name, numeric: false, pii: false }));
    const own = fieldColumns(spec, e.name, e.fields).filter(
      (c) => !(SYSTEM_FIELDS as readonly string[]).includes(c.name),
    );
    tables.push({ table: e.name, columns: [...system, ...own] });
  }
  let omittedPii = 0;
  if (!o.includePii)
    for (const t of tables) {
      omittedPii += t.columns.filter((c) => c.pii).length;
      t.columns = t.columns.filter((c) => !c.pii);
    }
  return { tables, omittedPii };
}
