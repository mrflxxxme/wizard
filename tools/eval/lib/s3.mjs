// Minimal S3 client for the eval bucket in RF (specs/quality/eval.yaml#briefs.set): path-style PUT/GET signed with
// AWS Signature V4 on node:crypto only — no SDK (architecture.yaml#stack; same approach as apps/runtime/src/files).
import { createHash, createHmac } from "node:crypto";

/** Timeweb Cloud S3 of the pilot (deploy.yaml#cloud: S3 only in ru-1, St. Petersburg). */
export const DEFAULT_ENDPOINT = "https://s3.twcstorage.ru";
export const DEFAULT_REGION = "ru-1";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** RF hosts besides *.ru (Yandex Object Storage lives on .net). */
const RF_HOSTS = new Set(["storage.yandexcloud.net"]);

/** Endpoint is an RF object store (https, *.ru or a known RF host) or a loopback test server. */
export function isRfEndpoint(endpoint) {
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (LOOPBACK.has(u.hostname)) return u.protocol === "http:" || u.protocol === "https:";
  return u.protocol === "https:" && (u.hostname.endsWith(".ru") || RF_HOSTS.has(u.hostname));
}

/**
 * Eval S3 settings from EVAL_S3_* (docs/ops/eval.md); AWS_* keys are accepted as in the eval-live workflow.
 * Returns {config} or {missing: env names} / {error: Russian reason}. Values are never printed.
 */
export function s3Config(env = process.env) {
  const accessKeyId = env.EVAL_S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.EVAL_S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY;
  const missing = [
    ...(env.EVAL_S3_BUCKET ? [] : ["EVAL_S3_BUCKET"]),
    ...(accessKeyId ? [] : ["EVAL_S3_ACCESS_KEY_ID"]),
    ...(secretAccessKey ? [] : ["EVAL_S3_SECRET_ACCESS_KEY"]),
  ];
  if (missing.length) return { missing };
  const endpoint = (env.EVAL_S3_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  if (!isRfEndpoint(endpoint))
    return {
      error: `EVAL_S3_ENDPOINT ${endpoint}: оригиналы партнёров хранятся только в S3 в РФ (https, домен .ru или storage.yandexcloud.net)`,
    };
  return {
    config: {
      endpoint,
      region: env.EVAL_S3_REGION || env.AWS_DEFAULT_REGION || DEFAULT_REGION,
      bucket: env.EVAL_S3_BUCKET,
      accessKeyId,
      secretAccessKey,
    },
  };
}

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 encoding of SigV4 ("/" kept in paths). */
export function uriEncode(s, keepSlash = false) {
  let out = "";
  for (const byte of Buffer.from(s, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === "/")) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export const amzDate = (d) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** Path-style object URL: <endpoint>/<bucket>/<key>. */
export const objectUrl = (cfg, key) =>
  new URL(`${cfg.endpoint}/${uriEncode(cfg.bucket)}/${uriEncode(key, true)}`);

/**
 * Headers of a header-signed SigV4 request (no query string): the given ones + host, x-amz-date,
 * x-amz-content-sha256, authorization.
 */
export function signRequest({
  method,
  url,
  headers = {},
  payloadHash,
  region,
  accessKeyId,
  secretAccessKey,
  date,
}) {
  const all = {
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
    host: url.host,
    "x-amz-date": amzDate(date),
    "x-amz-content-sha256": payloadHash,
  };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const path = uriEncode(decodeURIComponent(url.pathname || "/"), true);
  const request = [method.toUpperCase(), path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stamp = all["x-amz-date"];
  const day = stamp.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(request)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), "s3"), "aws4_request");
  const sig = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
  };
}

async function send(
  cfg,
  method,
  key,
  { body, headers = {}, fetch = globalThis.fetch, now = () => new Date() },
) {
  const url = objectUrl(cfg, key);
  const signed = signRequest({
    method,
    url,
    headers,
    payloadHash: sha256Hex(body ?? ""),
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    date: now(),
  });
  const { host: _host, ...sendHeaders } = signed;
  const res = await fetch(url, { method, headers: sendHeaders, ...(body !== undefined ? { body } : {}) });
  if (!res.ok) {
    // The S3 error body names the code (NoSuchKey, AccessDenied…); it carries no secrets.
    const text = (await res.text()).slice(0, 300).replace(/\s+/g, " ");
    throw new Error(`S3 ${method} ${key}: HTTP ${res.status} ${text}`);
  }
  return res;
}

/** PUT an object; `meta` → x-amz-meta-* headers. */
export async function putObject(
  cfg,
  key,
  body,
  { contentType = "application/octet-stream", meta = {}, ...o } = {},
) {
  const headers = { "content-type": contentType };
  for (const [k, v] of Object.entries(meta)) headers[`x-amz-meta-${k}`] = v;
  await send(cfg, "PUT", key, { ...o, body, headers });
}

/** GET an object as a Buffer. */
export async function getObject(cfg, key, o = {}) {
  const res = await send(cfg, "GET", key, o);
  return Buffer.from(await res.arrayBuffer());
}
