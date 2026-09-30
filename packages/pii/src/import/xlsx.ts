// xlsx reader (L3-37): cached values only — formulas are never evaluated; external links, macros, connections and
// every other part are never read. Decompressed bytes and non-empty cells are capped (ImportLimits).

import { badFile, type Cell, type ImportLimits, type Sheet, tooManyCells } from "./types.js";
import { type Budget, inflateEntry, readZipEntries, unpackedTooLarge, type ZipEntry } from "./zip.js";

const utf8 = new TextDecoder("utf-8");

const ENTITY_RE = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));/g;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(
    ENTITY_RE,
    (_, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
      if (name) return NAMED[name] ?? "";
      const cp = hex ? Number.parseInt(hex, 16) : Number(dec);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    },
  );
}

/** Excel escapes control characters in strings as _xHHHH_. */
const unescapeOoxml = (s: string) =>
  s.includes("_x")
    ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    : s;

function attrs(s: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const key = (m[1] ?? "").replace(/^\w+:(?=id$)/, "r:");
    out.set(key, unescapeXml(m[2] ?? m[3] ?? ""));
  }
  return out;
}

const T_RE = /<(?:\w+:)?t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g;

/** Text of a rich/inline string: all <t> runs, phonetic hints (<rPh>) dropped. */
function runText(inner: string): string {
  const body = inner.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "");
  let out = "";
  for (const m of body.matchAll(T_RE)) out += m[1] ?? "";
  return unescapeOoxml(unescapeXml(out));
}

interface Rel {
  type: string;
  target: string;
  external: boolean;
}

function readRels(xml: string, baseDir: string): Map<string, Rel> {
  const out = new Map<string, Rel>();
  for (const m of xml.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1] ?? "");
    const target = a.get("Target") ?? "";
    out.set(a.get("Id") ?? "", {
      type: a.get("Type") ?? "",
      target: resolvePath(baseDir, target),
      external: a.get("TargetMode") === "External",
    });
  }
  return out;
}

function resolvePath(baseDir: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `${baseDir}${target}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

// Built-in number formats that are dates/times (ECMA-376 §18.8.30 and common locale ids).
const DATE_FORMAT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54,
  55, 56, 57, 58,
]);

function isDateFormat(id: number, code: string | undefined): { date: boolean; time: boolean } {
  if (code === undefined) {
    const date = DATE_FORMAT_IDS.has(id);
    return { date, time: date && ((id >= 18 && id <= 22) || (id >= 45 && id <= 47)) };
  }
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[(?![hms]\])[^\]]*\]/gi, "")
    .toLowerCase();
  if (bare.includes("general")) return { date: false, time: false };
  return { date: /[dymhs]/.test(bare), time: /[hs]/.test(bare) };
}

function readDateStyles(xml: string): Array<{ date: boolean; time: boolean }> {
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<(?:\w+:)?numFmt\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1] ?? "");
    custom.set(Number(a.get("numFmtId")), a.get("formatCode") ?? "");
  }
  const block = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml)?.[1] ?? "";
  const out: Array<{ date: boolean; time: boolean }> = [];
  for (const m of block.matchAll(/<(?:\w+:)?xf\b([^>]*?)\/?>/g)) {
    const id = Number(attrs(m[1] ?? "").get("numFmtId") ?? 0);
    out.push(isDateFormat(id, custom.get(id)));
  }
  return out;
}

const DAY_MS = 86_400_000;

/** Serial date → ISO date (or date-time when the format shows time). */
function serialToIso(serial: number, date1904: boolean, time: boolean): string {
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : serial < 61
      ? Date.UTC(1899, 11, 31)
      : Date.UTC(1899, 11, 30);
  const ms = epoch + Math.round(serial * DAY_MS);
  const iso = new Date(ms).toISOString();
  return time ? iso.slice(0, 19) : iso.slice(0, 10);
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

const ROW_RE = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
const CELL_RE = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
const V_RE = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/;
const IS_RE = /<(?:\w+:)?is(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?is>/;

interface SheetCtx {
  sst: string[];
  styles: Array<{ date: boolean; time: boolean }>;
  date1904: boolean;
  cells: { count: number; limit: number };
}

function cellValue(a: Map<string, string>, inner: string, ctx: SheetCtx): Cell {
  const t = a.get("t") ?? "n";
  if (t === "inlineStr") {
    const is = IS_RE.exec(inner)?.[1];
    return is === undefined ? null : runText(is) || null;
  }
  // <f> (formula) is ignored: only the cached <v> counts; no cached value → empty.
  const raw = V_RE.exec(inner)?.[1];
  if (raw === undefined) return null;
  const v = unescapeXml(raw);
  switch (t) {
    case "s":
      return ctx.sst[Number(v)] || null;
    case "str":
      return unescapeOoxml(v) || null;
    case "b":
      return v === "1" || v === "true";
    case "e":
      return null;
    case "d":
      return v || null;
    default: {
      const num = Number(v);
      if (v.trim() === "" || !Number.isFinite(num)) return v || null;
      const style = ctx.styles[Number(a.get("s") ?? 0)];
      return style?.date ? serialToIso(num, ctx.date1904, style.time) : num;
    }
  }
}

function readSheet(name: string, xml: string, ctx: SheetCtx): Sheet | null {
  const grid: Cell[][] = [];
  const data = /<(?:\w+:)?sheetData\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/.exec(xml)?.[1] ?? "";
  for (const rm of data.matchAll(ROW_RE)) {
    const row: Cell[] = [];
    let next = 0;
    for (const cm of (rm[2] ?? "").matchAll(CELL_RE)) {
      const a = attrs(cm[1] ?? "");
      const ref = a.get("r");
      const idx = ref ? colIndex(ref) : next;
      next = idx + 1;
      const value = cellValue(a, cm[2] ?? "", ctx);
      if (value === null || idx < 0 || idx > 16_383) continue;
      if (++ctx.cells.count > ctx.cells.limit) throw tooManyCells(ctx.cells.limit);
      row[idx] = value;
    }
    grid.push(row);
  }
  return gridToSheet(name, grid);
}

/** First non-empty row → header; empty rows are dropped; trailing columns without header or data are cut. */
export function gridToSheet(name: string, grid: readonly Cell[][]): Sheet | null {
  const nonEmpty = grid.filter((r) => r.some((c) => c !== null && c !== undefined && c !== ""));
  const head = nonEmpty[0];
  if (!head) return null;
  const width = Math.max(...nonEmpty.map((r) => r.length));
  const header = Array.from({ length: width }, (_, i) => {
    const h = head[i];
    return h === null || h === undefined ? "" : String(h).trim();
  });
  const rows = nonEmpty.slice(1).map((r) =>
    Array.from({ length: width }, (_, i) => {
      const c = r[i];
      return c === undefined || c === "" ? null : c;
    }),
  );
  return { name, header, rows };
}

export function readXlsx(bytes: Uint8Array, limits: ImportLimits): Sheet[] {
  const entries = readZipEntries(bytes);
  let declared = 0;
  for (const e of entries.values()) declared += e.size;
  // The declared total already exceeds the limit: refuse without inflating anything.
  if (declared > limits.maxUnpackedBytes) throw unpackedTooLarge();
  const budget: Budget = { left: limits.maxUnpackedBytes };
  const part = (path: string): string | null => {
    const e: ZipEntry | undefined = entries.get(path);
    if (!e) return null;
    return utf8.decode(inflateEntry(bytes, e, budget));
  };

  const rootRels = readRels(part("_rels/.rels") ?? "", "");
  const wbPath =
    [...rootRels.values()].find((r) => r.type.endsWith("/officeDocument") && !r.external)?.target ??
    "xl/workbook.xml";
  const wbXml = part(wbPath);
  if (wbXml === null) throw badFile();
  const wbDir = wbPath.includes("/") ? wbPath.slice(0, wbPath.lastIndexOf("/") + 1) : "";
  const wbName = wbPath.slice(wbDir.length);
  const rels = readRels(part(`${wbDir}_rels/${wbName}.rels`) ?? "", wbDir);
  const relOf = (suffix: string) => [...rels.values()].find((r) => r.type.endsWith(suffix) && !r.external);

  const sstXml = part(relOf("/sharedStrings")?.target ?? `${wbDir}sharedStrings.xml`);
  const sst: string[] = [];
  if (sstXml) {
    for (const m of sstXml.matchAll(/<(?:\w+:)?si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)) {
      sst.push(runText(m[1] ?? ""));
    }
  }
  const stylesXml = part(relOf("/styles")?.target ?? `${wbDir}styles.xml`);
  const pr = /<(?:\w+:)?workbookPr\b([^>]*?)\/?>/.exec(wbXml)?.[1] ?? "";
  const d1904 = attrs(pr).get("date1904");
  const ctx: SheetCtx = {
    sst,
    styles: stylesXml ? readDateStyles(stylesXml) : [],
    date1904: d1904 === "1" || d1904 === "true",
    cells: { count: 0, limit: limits.maxCells },
  };

  const sheets: Sheet[] = [];
  for (const m of wbXml.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1] ?? "");
    const rel = rels.get(a.get("r:id") ?? "");
    // Only worksheets inside the package; chartsheets, dialogsheets and external targets are ignored.
    if (!rel || rel.external || !rel.type.endsWith("/worksheet")) continue;
    const xml = part(rel.target);
    if (xml === null) continue;
    const sheet = readSheet(a.get("name") ?? `Лист${sheets.length + 1}`, xml, ctx);
    if (sheet) sheets.push(sheet);
  }
  return sheets;
}
