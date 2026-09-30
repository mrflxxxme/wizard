// Minimal ZIP reader for xlsx: central directory + bounded streaming inflate (zip-bomb safe, L3-37).
import { Inflate } from "fflate";
import { badFile, ImportError } from "./types.js";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const u16 = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, i: number) => (u16(b, i) | (u16(b, i + 2) << 16)) >>> 0;
const utf8 = new TextDecoder("utf-8");

export function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && u32(b, 0) === 0x04034b50;
}

/** Entries from the central directory. ZIP64 is rejected: an xlsx within the upload limit never needs it. */
export function readZipEntries(b: Uint8Array): Map<string, ZipEntry> {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw badFile();
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const out = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw badFile();
    const nameLen = u16(b, p + 28);
    const entry: ZipEntry = {
      name: utf8.decode(b.subarray(p + 46, p + 46 + nameLen)),
      method: u16(b, p + 10),
      compressedSize: u32(b, p + 20),
      size: u32(b, p + 24),
      offset: u32(b, p + 42),
    };
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff)
      throw badFile();
    out.set(entry.name.replace(/^\/+/, ""), entry);
    p += 46 + nameLen + u16(b, p + 30) + u16(b, p + 32);
  }
  return out;
}

/** Shared decompression budget across all parts of one file. */
export interface Budget {
  left: number;
}

export const unpackedTooLarge = (): ImportError =>
  new ImportError("UNPACKED_TOO_LARGE", "Файл слишком большой после распаковки (больше 100 МБ).");

// Small input chunks bound what one push can inflate to (deflate expands at most ~1032×).
const CHUNK = 4096;

/** Inflates one entry, counting the real output against the budget (declared sizes are not trusted). */
export function inflateEntry(b: Uint8Array, e: ZipEntry, budget: Budget): Uint8Array {
  const lh = e.offset;
  if (lh + 30 > b.length || u32(b, lh) !== 0x04034b50) throw badFile();
  const start = lh + 30 + u16(b, lh + 26) + u16(b, lh + 28);
  const data = b.subarray(start, start + e.compressedSize);
  if (data.length !== e.compressedSize) throw badFile();
  if (e.method === 0) {
    if (data.length > budget.left) throw unpackedTooLarge();
    budget.left -= data.length;
    return data;
  }
  if (e.method !== 8) throw badFile();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflate = new Inflate((chunk) => {
    total += chunk.length;
    if (total > budget.left) throw unpackedTooLarge();
    chunks.push(chunk.slice());
  });
  try {
    for (let i = 0; i < data.length; i += CHUNK) {
      inflate.push(data.subarray(i, i + CHUNK), i + CHUNK >= data.length);
    }
    if (data.length === 0) inflate.push(new Uint8Array(0), true);
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw badFile();
  }
  budget.left -= total;
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
