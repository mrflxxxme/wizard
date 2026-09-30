// CSV reader: RFC 4180 quoting, delimiter , ; or tab (by the first line), UTF-8 with BOM or Windows-1251.

import { type Cell, type ImportLimits, type Sheet, tooManyCells } from "./types.js";
import { gridToSheet } from "./xlsx.js";

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/)).replace(/"[^"]*"/g, "");
  let best = ",";
  let max = -1;
  for (const d of [",", ";", "\t"]) {
    const n = firstLine.split(d).length - 1;
    if (n > max) {
      best = d;
      max = n;
    }
  }
  return best;
}

export function readCsv(bytes: Uint8Array, limits: ImportLimits, name = "Лист1"): Sheet[] {
  const text = decode(bytes);
  const delim = sniffDelimiter(text);
  const grid: Cell[][] = [];
  let row: Cell[] = [];
  let field = "";
  let quoted = false;
  let cells = 0;
  const push = () => {
    if (field !== "" && ++cells > limits.maxCells) throw tooManyCells(limits.maxCells);
    row.push(field === "" ? null : field);
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) push();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      push();
      grid.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    push();
    grid.push(row);
  }
  const sheet = gridToSheet(name, grid);
  return sheet ? [sheet] : [];
}
