// Server Name Indication from the first TLS record of a connection (RFC 8446 §4.1.2, RFC 6066 §3). The egress
// proxy peeks it before forwarding a byte (security/isolation.yaml#M2.network, L3-24): SNI MUST equal the CONNECT host.

export type HelloPeek =
  /** More bytes are needed to see the whole first record. */
  | { done: false }
  /** The first record is a ClientHello; `sni` is null when it has no host_name. */
  | { done: true; ok: true; sni: string | null }
  | { done: true; ok: false; reason: "not_tls" | "not_client_hello" | "malformed" | "too_large" };

/** TLS plaintext record limit (2^14) + header. */
export const MAX_HELLO_RECORD = 16_384 + 5;

class Reader {
  constructor(
    private readonly b: Uint8Array,
    public pos: number,
    private readonly end: number,
  ) {}
  need(n: number): void {
    if (this.pos + n > this.end) throw new RangeError("short");
  }
  u8(): number {
    this.need(1);
    return this.b[this.pos++] as number;
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u24(): number {
    return (this.u8() << 16) | this.u16();
  }
  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** Parses the first TLS record of `buf` (all bytes received so far from the client). */
export function peekClientHello(buf: Uint8Array): HelloPeek {
  if (buf.length < 5) return buf.length > 0 && buf[0] !== 0x16 ? bad("not_tls") : { done: false };
  if (buf[0] !== 0x16 || buf[1] !== 0x03) return bad("not_tls");
  const recordLen = ((buf[3] as number) << 8) | (buf[4] as number);
  if (recordLen + 5 > MAX_HELLO_RECORD) return bad("too_large");
  if (buf.length < recordLen + 5) return { done: false };
  try {
    const r = new Reader(buf, 5, 5 + recordLen);
    if (r.u8() !== 0x01) return bad("not_client_hello");
    const helloLen = r.u24();
    // A ClientHello fragmented over several records is not accepted (they fit one record in practice).
    if (helloLen + 4 > recordLen) return bad("malformed");
    r.skip(2 + 32); // legacy_version, random
    r.skip(r.u8()); // legacy_session_id
    r.skip(r.u16()); // cipher_suites
    r.skip(r.u8()); // legacy_compression_methods
    if (r.pos === 9 + helloLen) return { done: true, ok: true, sni: null };
    const extEnd = r.u16() + r.pos;
    if (extEnd > 9 + helloLen) return bad("malformed");
    let sni: string | null = null;
    const seen = new Set<number>();
    while (r.pos < extEnd) {
      const type = r.u16();
      const len = r.u16();
      if (seen.has(type)) return bad("malformed");
      seen.add(type);
      if (type !== 0) {
        r.skip(len);
        continue;
      }
      const e = new Reader(r.bytes(len), 0, len);
      const listEnd = e.u16() + 2;
      if (listEnd !== len) return bad("malformed");
      while (e.pos < listEnd) {
        const nameType = e.u8();
        const name = e.bytes(e.u16());
        if (nameType !== 0) continue;
        if (sni !== null) return bad("malformed"); // RFC 6066: at most one host_name
        if (!name.every((c) => c > 0x20 && c < 0x7f)) return bad("malformed");
        sni = Buffer.from(name).toString("ascii").toLowerCase().replace(/\.$/, "");
      }
    }
    if (r.pos !== extEnd) return bad("malformed");
    return { done: true, ok: true, sni };
  } catch {
    return bad("malformed");
  }
}

function bad(reason: "not_tls" | "not_client_hello" | "malformed" | "too_large"): HelloPeek {
  return { done: true, ok: false, reason };
}
