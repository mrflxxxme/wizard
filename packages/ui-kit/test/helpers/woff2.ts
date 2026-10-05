// Minimal WOFF2 reader for the font catalog check: header, table directory, brotli stream, cmap (formats 4 and 12).
import { brotliDecompressSync } from "node:zlib";

const KNOWN_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
  "CFF ",
  "VORG",
  "EBDT",
  "EBLC",
  "gasp",
  "hdmx",
  "kern",
  "LTSH",
  "PCLT",
  "VDMX",
  "vhea",
  "vmtx",
  "BASE",
  "GDEF",
  "GPOS",
  "GSUB",
  "EBSC",
  "JSTF",
  "MATH",
  "CBDT",
  "CBLC",
  "COLR",
  "CPAL",
  "SVG ",
  "sbix",
  "acnt",
  "avar",
  "bdat",
  "bloc",
  "bsln",
  "cvar",
  "fdsc",
  "feat",
  "fmtx",
  "fvar",
  "gvar",
  "hsty",
  "just",
  "lcar",
  "mort",
  "morx",
  "opbd",
  "prop",
  "trak",
  "Zapf",
  "Silf",
  "Glat",
  "Gloc",
  "Feat",
  "Sill",
]; // WOFF2 known-tag table, spec order

function base128(b: Uint8Array, at: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    const x = b[at + i] as number;
    v = v * 128 + (x & 0x7f);
    if (!(x & 0x80)) return [v, at + i + 1];
  }
  throw new Error("bad UIntBase128");
}

/** Tables of a WOFF2 font (untransformed ones are byte-exact). */
export function woff2Tables(file: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (String.fromCharCode(...file.subarray(0, 4)) !== "wOF2") throw new Error("not a WOFF2 file");
  const numTables = dv.getUint16(12);
  const compressed = dv.getUint32(20);
  let at = 48;
  const dir: { tag: string; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = file[at++] as number;
    let tag = KNOWN_TAGS[flags & 0x3f] ?? "";
    if ((flags & 0x3f) === 63) {
      tag = String.fromCharCode(...file.subarray(at, at + 4));
      at += 4;
    }
    const version = flags >> 6;
    let orig: number;
    [orig, at] = base128(file, at);
    let length = orig;
    const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    if (transformed) [length, at] = base128(file, at);
    dir.push({ tag, length });
  }
  const stream = brotliDecompressSync(file.subarray(at, at + compressed));
  const out = new Map<string, Uint8Array>();
  let off = 0;
  for (const t of dir) {
    out.set(t.tag, new Uint8Array(stream.subarray(off, off + t.length)));
    off += t.length;
  }
  return out;
}

/** Code points the font maps to a glyph (cmap 3/10 format 12, else 3/1 or 0/x format 4). */
export function cmapCodepoints(cmap: Uint8Array): Set<number> {
  const dv = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  const n = dv.getUint16(2);
  const subtables: { pid: number; eid: number; off: number }[] = [];
  for (let i = 0; i < n; i++)
    subtables.push({
      pid: dv.getUint16(4 + i * 8),
      eid: dv.getUint16(6 + i * 8),
      off: dv.getUint32(8 + i * 8),
    });
  const out = new Set<number>();
  const f12 = subtables.find((s) => dv.getUint16(s.off) === 12);
  if (f12) {
    const groups = dv.getUint32(f12.off + 12);
    for (let g = 0; g < groups; g++) {
      const p = f12.off + 16 + g * 12;
      const start = dv.getUint32(p);
      const end = dv.getUint32(p + 4);
      for (let c = start; c <= end; c++) out.add(c);
    }
    return out;
  }
  const f4 = subtables.find((s) => dv.getUint16(s.off) === 4);
  if (!f4) throw new Error("no cmap format 4/12");
  const segX2 = dv.getUint16(f4.off + 6);
  const ends = f4.off + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  for (let i = 0; i < segX2 / 2; i++) {
    const end = dv.getUint16(ends + i * 2);
    const start = dv.getUint16(starts + i * 2);
    const delta = dv.getUint16(deltas + i * 2);
    const rangeAt = ranges + i * 2;
    const range = dv.getUint16(rangeAt);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let glyph: number;
      if (range === 0) glyph = (c + delta) & 0xffff;
      else {
        const g = dv.getUint16(rangeAt + range + 2 * (c - start));
        glyph = g === 0 ? 0 : (g + delta) & 0xffff;
      }
      if (glyph !== 0) out.add(c);
    }
  }
  return out;
}
