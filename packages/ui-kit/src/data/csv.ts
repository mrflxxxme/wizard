// CSV export of a list (V3-18, DataTable «Выгрузить CSV»): UTF-8 with BOM and «;» separators so Excel in the Russian
// locale opens it in columns; enum labels, «Да»/«Нет», decimal commas; cells that start a formula are neutralised.
import type { Field } from "@wizard/appspec";
import { ru } from "../i18n/ru.js";
import type { ListQuery, Rec } from "./types.js";

/** Field types left out of an export: tokens, files (ids say nothing outside the system) and raw JSON. */
const SKIP = new Set(["qr_token", "json", "file", "image"]);
/** Most rows one export reads (the runtime counts totals up to 10 000). */
export const CSV_MAX_ROWS = 10_000;

/** Fields of an export: the role's visible fields (RoleSpec has the hidden ones removed) without SKIP types. */
export function csvFields(fields: readonly Field[]): Field[] {
  return fields.filter((f) => !SKIP.has(f.type));
}

function dateRu(v: string, withTime: boolean): string {
  const d = new Date(withTime ? v : `${v}T00:00:00`);
  if (Number.isNaN(d.getTime())) return v;
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day;
}

/** Text of one value as the owner reads it. */
export function csvValue(f: Field, v: unknown): string {
  if (v === null || v === undefined) return "";
  switch (f.type) {
    case "enum":
      return f.enum?.find((o) => o.value === v)?.label ?? String(v);
    case "bool":
      return v ? ru.field.yes : ru.field.no;
    case "int":
    case "decimal":
    case "money":
      return String(v).replace(".", ",");
    case "date":
      return dateRu(String(v), false);
    case "datetime":
      return dateRu(String(v), true);
    default:
      return typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}

/** One cell: a formula start (=, @, +/- before anything but a number or phone) gets «'»; quoted when needed. */
export function csvCell(s: string): string {
  const risky = /^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-][\d\s().,-]*$/.test(s));
  const t = risky ? `'${s}` : s;
  return /[";\r\n]|^\s|\s$/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** The CSV text with the BOM: a header of labels, then a line per row. */
export function toCsv(fields: readonly Field[], rows: readonly Rec[]): string {
  const lines = [fields.map((f) => csvCell(f.label)).join(";")];
  for (const r of rows) lines.push(fields.map((f) => csvCell(csvValue(f, r[f.name]))).join(";"));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Reads every page of the list under the current filter, search and sort (100 per page, ≤ CSV_MAX_ROWS). */
export async function fetchAllRows(
  fetchPage: (q: ListQuery) => Promise<{ items: Rec[]; total: number }>,
  q: ListQuery,
): Promise<Rec[]> {
  const out: Rec[] = [];
  for (let page = 1; out.length < CSV_MAX_ROWS; page++) {
    const r = await fetchPage({ ...q, page, pageSize: 100 });
    out.push(...r.items);
    if (r.items.length < 100 || out.length >= r.total) break;
  }
  return out.slice(0, CSV_MAX_ROWS);
}

/** Saves the text as a file in the browser. */
export function downloadCsv(name: string, text: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
