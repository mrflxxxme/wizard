// RFC 5322/2045/2047 message building for the email connector (email.yaml#actions.sendTemplate.rules).
import { randomBytes } from "node:crypto";

/** CR, LF and NUL are removed from every header value (L3-29). */
export function headerSafe(s: string): string {
  return s.replace(/[\r\n\0]/g, "");
}

/** Display name: header-safe, without @ < > " \, at most `max` code points. */
export function displayName(s: string, max = 60): string {
  return [
    ...headerSafe(s)
      .replace(/[@<>"\\]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, max)
    .join("")
    .trim();
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
// Encoded word ≤ 75 chars: "=?UTF-8?B?" + base64(≤ 45 bytes = 60 chars) + "?=".
const WORD_BYTES = 45;

/** RFC 2047 B-encoding of non-ASCII text, split on code point boundaries; ASCII is returned as is. */
export function encodeWords(value: string): string[] {
  const clean = headerSafe(value);
  if (ASCII_PRINTABLE.test(clean)) return [clean];
  const words: string[] = [];
  let chunk = "";
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch) > WORD_BYTES) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`);
}

/** `Name: value` with folding: every encoded word goes on its own continuation line. */
export function headerLine(name: string, value: string): string {
  return `${name}: ${encodeWords(value).join("\r\n ")}`;
}

const ADDR_RE = /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$/;

export function isPlainAddress(a: string): boolean {
  return ADDR_RE.test(a) && a.length <= 254;
}

/** `"Name" <addr>` / `=?UTF-8?B?…?= <addr>`; an invalid address throws. */
export function formatAddress(address: string, name?: string): string {
  const addr = headerSafe(address).trim();
  if (!isPlainAddress(addr)) throw new Error("invalid email address");
  const n = name ? displayName(name) : "";
  if (!n) return `<${addr}>`;
  const shown = ASCII_PRINTABLE.test(n) ? `"${n}"` : encodeWords(n).join(" ");
  return `${shown} <${addr}>`;
}

function base64Lines(data: Buffer): string {
  return (data.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

export interface InlineImage {
  cid: string;
  filename: string;
  contentType: "image/png";
  data: Buffer;
}

export interface MailParts {
  /** Already header-safe structured headers (From, To, Subject, …), in order; values are encoded here. */
  headers: [string, string][];
  /** Address headers are passed pre-formatted (formatAddress) and are not re-encoded. */
  addressHeaders: [string, string][];
  text: string;
  html: string;
  inline?: InlineImage[];
}

const boundary = () => `wz_${randomBytes(12).toString("hex")}`;

function textPart(type: "text/plain" | "text/html", body: string): string {
  return [
    `Content-Type: ${type}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(body, "utf8")),
  ].join("\r\n");
}

/** Full message (CRLF line endings): multipart/alternative, wrapped in multipart/related for inline images. */
export function buildMessage(p: MailParts): string {
  const head = [
    ...p.addressHeaders.map(([k, v]) => `${k}: ${headerSafe(v)}`),
    ...p.headers.map(([k, v]) => headerLine(k, v)),
    "MIME-Version: 1.0",
  ];
  const alt = boundary();
  const alternative = [
    `--${alt}`,
    textPart("text/plain", p.text),
    `--${alt}`,
    textPart("text/html", p.html),
    `--${alt}--`,
  ].join("\r\n");
  if (!p.inline?.length) {
    return [...head, `Content-Type: multipart/alternative; boundary="${alt}"`, "", alternative, ""].join(
      "\r\n",
    );
  }
  const rel = boundary();
  const parts = [`--${rel}`, `Content-Type: multipart/alternative; boundary="${alt}"`, "", alternative];
  for (const img of p.inline) {
    parts.push(
      `--${rel}`,
      `Content-Type: ${img.contentType}; name="${img.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-ID: <${img.cid}>`,
      `Content-Disposition: inline; filename="${img.filename}"`,
      "",
      base64Lines(img.data),
    );
  }
  parts.push(`--${rel}--`);
  return [
    ...head,
    `Content-Type: multipart/related; boundary="${rel}"; type="multipart/alternative"`,
    "",
    ...parts,
    "",
  ].join("\r\n");
}

/** Unfolded top-level headers of a message (tests, dev tooling). */
export function parseHeaders(raw: string): [string, string][] {
  const head = raw.split("\r\n\r\n")[0] ?? "";
  return head
    .replace(/\r\n[ \t]+/g, " ")
    .split("\r\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i), line.slice(i + 1).trim()] as [string, string];
    });
}

/** Decodes RFC 2047 encoded words (B and Q) of a header value. */
export function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_, enc: string, text: string) =>
      enc.toUpperCase() === "B"
        ? Buffer.from(text, "base64").toString("utf8")
        : Buffer.from(
            text
              .replace(/_/g, " ")
              .replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16))),
            "latin1",
          ).toString("utf8"),
    );
}
