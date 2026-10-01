// AWS Signature Version 4 for an S3-compatible store (Cloud.ru Object Storage): header-signed requests and presigned
// URLs on node:crypto only — no SDK dependency (architecture.yaml#stack has none; docs/reviews/impl-notes/M2-14.md).
import { createHash, createHmac } from "node:crypto";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SignInput {
  method: string;
  url: URL;
  /** Lowercase names; host is taken from the URL. */
  headers: Record<string, string>;
  /** Hex sha256 of the body or "UNSIGNED-PAYLOAD". */
  payloadHash: string;
  region: string;
  service?: string;
  credentials: S3Credentials;
  date: Date;
}

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 encoding of SigV4: everything except A-Z a-z 0-9 - _ . ~ ("/" kept in paths). */
export function uriEncode(s: string, keepSlash = false): string {
  let out = "";
  for (const byte of Buffer.from(s, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === "/")) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export const amzDate = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

function canonicalQuery(url: URL): string {
  const pairs = [...url.searchParams].map(([k, v]) => [uriEncode(k), uriEncode(v)] as const);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function canonicalPath(url: URL): string {
  // URL keeps the path percent-encoded; S3 signs each segment encoded exactly once.
  return uriEncode(decodeURIComponent(url.pathname || "/"), true);
}

function signingKey(secret: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), "aws4_request");
}

function signature(i: SignInput, headers: Record<string, string>, query: string) {
  const service = i.service ?? "s3";
  const stamp = amzDate(i.date);
  const day = stamp.slice(0, 8);
  const scope = `${day}/${i.region}/${service}/aws4_request`;
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names
    .map((n) => `${n}:${String(lower[n]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const request = [
    i.method.toUpperCase(),
    canonicalPath(i.url),
    query,
    canonicalHeaders,
    signedHeaders,
    i.payloadHash,
  ].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(request)].join("\n");
  const sig = createHmac("sha256", signingKey(i.credentials.secretAccessKey, day, i.region, service))
    .update(toSign, "utf8")
    .digest("hex");
  return { sig, scope, signedHeaders, stamp };
}

/** Headers of a signed request: the given ones + host, x-amz-date, x-amz-content-sha256, authorization. */
export function signRequest(i: SignInput): Record<string, string> {
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), v])),
    host: i.url.host,
    "x-amz-date": amzDate(i.date),
    "x-amz-content-sha256": i.payloadHash,
  };
  const { sig, scope, signedHeaders } = signature(i, headers, canonicalQuery(i.url));
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${i.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
  };
}

/** Presigned URL (query authentication, UNSIGNED-PAYLOAD, signed header host only); expires ≤ 7 days. */
export function presignUrl(i: Omit<SignInput, "headers" | "payloadHash"> & { expiresSec: number }): string {
  const service = i.service ?? "s3";
  const url = new URL(i.url);
  const stamp = amzDate(i.date);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set(
    "X-Amz-Credential",
    `${i.credentials.accessKeyId}/${stamp.slice(0, 8)}/${i.region}/${service}/aws4_request`,
  );
  url.searchParams.set("X-Amz-Date", stamp);
  url.searchParams.set("X-Amz-Expires", String(Math.max(1, Math.min(604_800, Math.floor(i.expiresSec)))));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  const { sig } = signature(
    { ...i, url, headers: {}, payloadHash: "UNSIGNED-PAYLOAD" },
    { host: url.host },
    canonicalQuery(url),
  );
  return `${url.origin}${url.pathname}?${canonicalQuery(url)}&X-Amz-Signature=${sig}`;
}
