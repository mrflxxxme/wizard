// pkt-line framing of the git wire protocol (V3-31; git-scm.com/docs/protocol-common, gitprotocol-v2): a 4-hex-digit
// length that counts itself, then the payload; 0000 flush, 0001 delimiter, 0002 response end. Plain TypeScript.

export const FLUSH = Buffer.from("0000", "latin1");
export const DELIM = Buffer.from("0001", "latin1");
export const RESPONSE_END = Buffer.from("0002", "latin1");

/** Largest pkt-line git sends or accepts: 65520 bytes with the header (LARGE_PACKET_MAX). */
export const PKT_MAX = 65520;

/** One data pkt-line; text gets no implicit newline. */
export function pkt(data: string | Uint8Array): Buffer {
  const body = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  if (body.byteLength + 4 > PKT_MAX) throw new Error("pkt-line: payload too long");
  return Buffer.concat([Buffer.from((body.byteLength + 4).toString(16).padStart(4, "0"), "latin1"), body]);
}

export type PktLine =
  | { kind: "data"; data: Buffer }
  | { kind: "flush" }
  | { kind: "delim" }
  | { kind: "end" };

/** Reader over a whole response body. */
export class PktReader {
  #pos = 0;
  constructor(private readonly buf: Buffer) {}

  get done(): boolean {
    return this.#pos >= this.buf.byteLength;
  }

  /** The bytes not read yet (a v0 push response without side-band carries nothing after its flush). */
  rest(): Buffer {
    return this.buf.subarray(this.#pos);
  }

  /** Next pkt-line, or null at the end of the body. Throws on a malformed length. */
  next(): PktLine | null {
    if (this.#pos >= this.buf.byteLength) return null;
    if (this.#pos + 4 > this.buf.byteLength) throw new Error("pkt-line: truncated length");
    const hex = this.buf.subarray(this.#pos, this.#pos + 4).toString("latin1");
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error("pkt-line: bad length");
    const len = Number.parseInt(hex, 16);
    this.#pos += 4;
    if (len === 0) return { kind: "flush" };
    if (len === 1) return { kind: "delim" };
    if (len === 2) return { kind: "end" };
    if (len < 4 || this.#pos + len - 4 > this.buf.byteLength) throw new Error("pkt-line: truncated payload");
    const data = this.buf.subarray(this.#pos, this.#pos + len - 4);
    this.#pos += len - 4;
    return { kind: "data", data };
  }
}

/** Text of a data line without its trailing newline. */
export const lineText = (data: Buffer): string => data.toString("utf8").replace(/\n$/, "");

/**
 * Demultiplexes side-band-64k (band 1 — data, 2 — progress, 3 — fatal error) until a flush. Returns the band-1 bytes;
 * a band-3 message is thrown as `remote: <text>` (the text comes from the git server, never from our credentials).
 */
export function readSideband(r: PktReader): Buffer {
  const parts: Buffer[] = [];
  for (;;) {
    const line = r.next();
    if (!line || line.kind === "flush" || line.kind === "end") break;
    if (line.kind !== "data" || line.data.byteLength === 0) continue;
    const band = line.data[0];
    if (band === 1) parts.push(line.data.subarray(1));
    else if (band === 3)
      throw new Error(`remote: ${line.data.subarray(1).toString("utf8").trim().slice(0, 300)}`);
  }
  return Buffer.concat(parts);
}
