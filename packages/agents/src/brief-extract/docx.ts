// docx → markdown-like text: headings «# …» (paragraph outline level or a heading style, also Russian «Заголовок N»),
// list items «- …», table rows «| … | … |», paragraphs. Only the main document part is read; deleted and moved-away
// text, field codes and the fallback copies of text boxes are skipped. No XML library: a small tag scanner is enough for
// WordprocessingML and keeps the dependency list as is (fflate is already in the tree).
import { badFile, unsupported } from "./types.js";
import { type Budget, readPart, readZipEntries, type ZipEntry } from "./zip.js";

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** XML character references and the five predefined entities. */
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITY[e] ?? m;
  });
}

const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) out[m[1] as string] = decodeXml(m[2] ?? m[3] ?? "");
  return out;
}

type StyleKind = { heading: number } | { list: true } | null;

/** Paragraph styles → heading level (outline level, «heading N», «Заголовок N», Title) or a list style. */
export function readStyles(xml: string): Map<string, StyleKind> {
  const raw = new Map<string, { kind: StyleKind; basedOn?: string }>();
  for (const m of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const a = attrs(m[1] as string);
    if (a["w:type"] !== "paragraph" || !a["w:styleId"]) continue;
    const body = m[2] as string;
    const name = (/<w:name\b[^>]*w:val="([^"]*)"/.exec(body)?.[1] ?? "").toLowerCase();
    const outline = /<w:outlineLvl\b[^>]*w:val="(\d+)"/.exec(body)?.[1];
    const basedOn = /<w:basedOn\b[^>]*w:val="([^"]*)"/.exec(body)?.[1];
    let kind: StyleKind = null;
    const byName = /^(?:heading|заголовок)\s*(\d)$/.exec(name)?.[1];
    if (outline !== undefined && Number(outline) <= 5) kind = { heading: Number(outline) + 1 };
    else if (byName) kind = { heading: Number(byName) };
    else if (name === "title" || name === "название") kind = { heading: 1 };
    else if (name === "subtitle" || name === "подзаголовок") kind = { heading: 2 };
    else if (/list|спис|маркир|нумер/.test(name) || /<w:numPr\b/.test(body)) kind = { list: true };
    raw.set(a["w:styleId"], { kind, ...(basedOn ? { basedOn } : {}) });
  }
  const out = new Map<string, StyleKind>();
  for (const id of raw.keys()) {
    let cur: string | undefined = id;
    let kind: StyleKind = null;
    for (let depth = 0; cur && depth < 10 && !kind; depth++) {
      const s = raw.get(cur);
      kind = s?.kind ?? null;
      cur = s?.basedOn;
    }
    out.set(id, kind);
  }
  return out;
}

interface Para {
  text: string;
  style: string | null;
  numbered: boolean;
  ilvl: number;
  outline: number | null;
}

type Line = { kind: "heading" | "para" | "list" | "row"; text: string };

const TOKEN_RE =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g;
/** Containers whose text is not part of the visible document. */
const SKIP = new Set(["w:moveFrom", "mc:Fallback", "w:del", "w:instrText", "w:delText"]);

/** WordprocessingML body → lines. */
export function documentLines(xml: string, styles: Map<string, StyleKind>): Line[] {
  const lines: Line[] = [];
  const paras: Para[] = [];
  // Tables: rows of cells; a cell collects the text of its paragraphs.
  const tables: { row: string[] | null; cell: string[] | null }[] = [];
  let skip = 0;
  let inText = false;
  let inPPr = 0;
  const cur = () => paras[paras.length - 1];
  const put = (s: string) => {
    const p = cur();
    if (p && skip === 0) p.text += s;
  };
  for (const m of xml.matchAll(TOKEN_RE)) {
    const [, cdata, close, tag, rest, selfClose, text] = m;
    if (text !== undefined || cdata !== undefined) {
      if (inText) put(cdata ?? decodeXml(text as string));
      continue;
    }
    if (!tag) continue;
    if (SKIP.has(tag)) {
      if (!selfClose) skip += close ? -1 : 1;
      if (skip < 0) skip = 0;
      continue;
    }
    if (close) {
      if (tag === "w:t") inText = false;
      else if (tag === "w:pPr") inPPr = Math.max(0, inPPr - 1);
      else if (tag === "w:p") {
        const p = paras.pop();
        if (!p) continue;
        const t = p.text.replace(/[ \t]+/g, " ").trim();
        const table = tables[tables.length - 1];
        if (table?.cell) {
          if (t) table.cell.push(t);
          continue;
        }
        if (!t) continue;
        const style = p.style ? styles.get(p.style) : null;
        const level =
          p.outline !== null && p.outline <= 5
            ? p.outline + 1
            : style && "heading" in style
              ? style.heading
              : 0;
        if (level > 0) lines.push({ kind: "heading", text: `${"#".repeat(Math.min(level, 6))} ${t}` });
        else if (p.numbered || (style && "list" in style))
          lines.push({ kind: "list", text: `${"  ".repeat(Math.min(p.ilvl, 4))}- ${t}` });
        else lines.push({ kind: "para", text: t });
      } else if (tag === "w:tc") {
        const table = tables[tables.length - 1];
        if (table?.cell && table.row) table.row.push(table.cell.join(" "));
        if (table) table.cell = null;
      } else if (tag === "w:tr") {
        const table = tables[tables.length - 1];
        const cells = table?.row?.filter((c) => c) ?? [];
        if (table) table.row = null;
        const parent = tables[tables.length - 2];
        if (cells.length === 0) continue;
        // A nested table lands in the outer cell as text.
        if (parent?.cell) parent.cell.push(cells.join("; "));
        else lines.push({ kind: "row", text: `| ${cells.join(" | ")} |` });
      } else if (tag === "w:tbl") tables.pop();
      continue;
    }
    switch (tag) {
      case "w:p":
        if (!selfClose) paras.push({ text: "", style: null, numbered: false, ilvl: 0, outline: null });
        break;
      case "w:pPr":
        if (!selfClose) inPPr++;
        break;
      case "w:pStyle":
        if (inPPr && cur()) (cur() as Para).style = attrs(rest as string)["w:val"] ?? null;
        break;
      case "w:numPr":
        if (inPPr && cur()) (cur() as Para).numbered = true;
        break;
      case "w:ilvl":
        if (inPPr && cur()) (cur() as Para).ilvl = Number(attrs(rest as string)["w:val"] ?? 0) || 0;
        break;
      case "w:outlineLvl":
        if (inPPr && cur()) (cur() as Para).outline = Number(attrs(rest as string)["w:val"] ?? 9);
        break;
      case "w:t":
        if (!selfClose) inText = true;
        break;
      case "w:tab":
        if (!inPPr) put("\t");
        break;
      case "w:br":
      case "w:cr":
        put(" ");
        break;
      case "w:noBreakHyphen":
        put("-");
        break;
      case "w:tbl":
        if (!selfClose) tables.push({ row: null, cell: null });
        break;
      case "w:tr": {
        const table = tables[tables.length - 1];
        if (table && !selfClose) table.row = [];
        break;
      }
      case "w:tc": {
        const table = tables[tables.length - 1];
        if (table && !selfClose) table.cell = [];
        break;
      }
    }
  }
  return lines;
}

/** Lines → text: consecutive list items and table rows stay together, other blocks are separated by a blank line. */
export function joinLines(lines: readonly Line[]): string {
  let out = "";
  let prev: Line["kind"] | null = null;
  for (const l of lines) {
    if (prev !== null) out += prev === l.kind && (l.kind === "list" || l.kind === "row") ? "\n" : "\n\n";
    out += l.text;
    prev = l.kind;
  }
  return out;
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");

/** The main document part named by _rels/.rels (officeDocument), else word/document.xml. */
function mainPart(b: Uint8Array, entries: Map<string, ZipEntry>, budget: Budget): string | null {
  const rels = readPart(b, entries, "_rels/.rels", budget);
  if (rels) {
    for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const a = attrs(m[1] as string);
      if (a.Type?.endsWith("/officeDocument") && a.Target) {
        const target = a.Target.replace(/^\/+/, "");
        if (entries.has(target)) return target;
      }
    }
  }
  return entries.has("word/document.xml") ? "word/document.xml" : null;
}

/** Text of a docx file; other zip documents (xlsx, pptx, odt) are refused with a hint. */
export function readDocx(b: Uint8Array, budget: Budget): string {
  const entries = readZipEntries(b);
  const main = mainPart(b, entries, budget);
  if (!main) {
    if (entries.has("content.xml") || entries.has("mimetype"))
      throw unsupported("Документ OpenDocument (.odt) сохраните как .docx или PDF.");
    if (entries.has("xl/workbook.xml"))
      throw unsupported("Таблицы загружаются через импорт, а ТЗ — документом.");
    if (entries.has("ppt/presentation.xml")) throw unsupported("Презентацию сохраните как PDF.");
    throw unsupported();
  }
  const xml = readPart(b, entries, main, budget);
  if (xml === null || !/<w:body\b/.test(xml)) throw badFile();
  const stylesXml = readPart(b, entries, `${dirOf(main)}styles.xml`, budget);
  return joinLines(documentLines(xml, stylesXml ? readStyles(stylesXml) : new Map()));
}
