// Minimal xlsx writer for fixtures and tests (inline strings, numbers, booleans, formulas with cached values).
import { zipSync } from "fflate";
import type { Cell } from "./types.js";

/** A formula cell: `f` is written as is; `v` is the cached value a reader must use. */
export interface FormulaCell {
  f: string;
  v?: Cell;
}

export interface XlsxSheetInput {
  name: string;
  rows: ReadonlyArray<ReadonlyArray<Cell | FormulaCell>>;
}

export interface WriteXlsxOptions {
  /** Extra package parts (path → XML), e.g. xl/externalLinks/externalLink1.xml. */
  extraParts?: Record<string, string>;
  /** Extra <Relationship …/> elements for xl/_rels/workbook.xml.rels. */
  extraWorkbookRels?: string[];
  /** Deflate level (0 = store). */
  level?: 0 | 1 | 6 | 9;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function cellXml(ref: string, c: Cell | FormulaCell): string {
  if (c === null) return "";
  if (typeof c === "object") {
    const v = c.v;
    const f = `<f>${esc(c.f)}</f>`;
    if (v === undefined || v === null) return `<c r="${ref}">${f}</c>`;
    if (typeof v === "number") return `<c r="${ref}">${f}<v>${v}</v></c>`;
    if (typeof v === "boolean") return `<c r="${ref}" t="b">${f}<v>${v ? 1 : 0}</v></c>`;
    return `<c r="${ref}" t="str">${f}<v>${esc(v)}</v></c>`;
  }
  if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
  if (typeof c === "boolean") return `<c r="${ref}" t="b"><v>${c ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(c)}</t></is></c>`;
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export function writeXlsx(sheets: readonly XlsxSheetInput[], opts: WriteXlsxOptions = {}): Uint8Array {
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, xml: string) => {
    files[path] = enc.encode(xml);
  };
  put(
    "[Content_Types].xml",
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("")}</Types>`,
  );
  put(
    "_rels/.rels",
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  put(
    "xl/workbook.xml",
    `${XML}<workbook ${NS} xmlns:r="${REL}"><sheets>${sheets
      .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("")}</sheets></workbook>`,
  );
  put(
    "xl/_rels/workbook.xml.rels",
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("")}${(opts.extraWorkbookRels ?? []).join("")}</Relationships>`,
  );
  sheets.forEach((s, i) => {
    const rows = s.rows
      .map(
        (r, ri) =>
          `<row r="${ri + 1}">${r.map((c, ci) => cellXml(`${colName(ci)}${ri + 1}`, c)).join("")}</row>`,
      )
      .join("");
    put(
      `xl/worksheets/sheet${i + 1}.xml`,
      `${XML}<worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`,
    );
  });
  for (const [path, xml] of Object.entries(opts.extraParts ?? {})) put(path, xml);
  return zipSync(files, { level: opts.level ?? 6 });
}
