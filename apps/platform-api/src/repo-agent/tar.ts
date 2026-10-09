// A minimal tar writer (POSIX ustar, PAX records for long or non-ASCII names) for the repository sandbox's pods (V3-32):
// the platform packs the files of the snapshot it fetched itself and the agent's changes; GNU tar unpacks them in the
// pod's restore step. Regular files and symlinks only; parent directories are created by tar.
import { promisify } from "node:util";
import { gzip } from "node:zlib";

export interface TarEntry {
  path: string;
  /** Regular file: its bytes; symlink: its target in `link`. */
  data?: Uint8Array;
  link?: string;
  /** Executable regular file (git mode 100755). */
  exec?: boolean;
}

const BLOCK = 512;
const enc = new TextEncoder();
const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);

function octal(buf: Buffer, offset: number, width: number, value: number): void {
  buf.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
}

function header(name: string, type: "0" | "2" | "x", size: number, mode: number, mtime: number, link = "") {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  octal(h, 100, 8, mode);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, mtime);
  h.write("        ", 148, 8, "ascii");
  h.write(type, 156, 1, "ascii");
  h.write(link, 157, 100, "utf8");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

/** One PAX record: "<length> <key>=<value>\n", the length counting itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bytes = enc.encode(body).byteLength;
  let len = bytes + 1;
  while (len !== bytes + String(len).length) len = bytes + String(len).length;
  return `${len}${body}`;
}

const pad = (n: number) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);

/** The tar archive of `entries` (in order). */
export function tar(entries: Iterable<TarEntry>, mtime = Math.floor(Date.now() / 1000)): Buffer {
  const out: Buffer[] = [];
  for (const e of entries) {
    const isLink = e.link !== undefined;
    const data = isLink ? Buffer.alloc(0) : Buffer.from(e.data ?? new Uint8Array());
    const link = e.link ?? "";
    const longName = enc.encode(e.path).byteLength > 100 || !ascii(e.path);
    const longLink = enc.encode(link).byteLength > 100 || !ascii(link);
    if (longName || longLink) {
      const records = Buffer.from(
        (longName ? paxRecord("path", e.path) : "") + (longLink ? paxRecord("linkpath", link) : ""),
        "utf8",
      );
      out.push(header("././@PaxHeader", "x", records.length, 0o644, mtime), records, pad(records.length));
    }
    const name = longName ? "././@LongName" : e.path;
    out.push(
      header(
        name,
        isLink ? "2" : "0",
        data.length,
        isLink ? 0o777 : e.exec ? 0o755 : 0o644,
        mtime,
        longLink ? "" : link,
      ),
    );
    if (data.length) out.push(data, pad(data.length));
  }
  out.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(out);
}

const gz = promisify(gzip);

/** tar | gzip (compressed off the event loop). */
export const tarGz = (entries: Iterable<TarEntry>, mtime?: number): Promise<Buffer> =>
  gz(tar(entries, mtime));
