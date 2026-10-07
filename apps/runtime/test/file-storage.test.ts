// M2-14 storage of file fields: SigV4 against the AWS documented examples, the S3 client against a local
// S3-compatible stub that verifies every signature and payload hash, the folder backend, env configuration and purge.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sha256Hex } from "../src/files/sigv4.js";
import {
  createFileStorage,
  EMPTY_SHA256,
  type FileMeta,
  type FileStorage,
  FsFileStorage,
  MemoryFileStorage,
  presignUrl,
  purgeSchemaFiles,
  S3Error,
  S3FileStorage,
  signRequest,
} from "../src/index.js";

const AWS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const DAY0 = new Date("2013-05-24T00:00:00Z");

describe("SigV4 (AWS documented examples)", () => {
  test("GET object with Range → known Authorization", () => {
    const h = signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      payloadHash: EMPTY_SHA256,
      region: "us-east-1",
      credentials: AWS,
      date: DAY0,
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  test("presigned GET, 86400 s → known signature", () => {
    const url = presignUrl({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      credentials: AWS,
      date: DAY0,
      expiresSec: 86400,
    });
    expect(url).toMatch(/X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  });
});

// ------------------------------------------------------------------------------------------------
// S3-compatible stub (path-style, one bucket): PUT/HEAD/GET/DELETE object, ListObjectsV2 with paging.

const CREDS = { accessKeyId: "test-key", secretAccessKey: "test-secret-0123456789" };
const objects = new Map<string, { body: Buffer; headers: Record<string, string> }>();
const requests: { method: string; path: string; sse?: string }[] = [];
let server: Server;
let endpoint = "";

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  return Buffer.concat(chunks);
}

function verified(req: IncomingMessage, body: Buffer): boolean {
  const auth = String(req.headers.authorization ?? "");
  const m = /SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return false;
  if (sha256Hex(body) !== req.headers["x-amz-content-sha256"]) return false;
  const signed = (m[1] as string).split(";");
  const headers: Record<string, string> = {};
  for (const n of signed)
    if (n !== "host" && n !== "x-amz-date" && n !== "x-amz-content-sha256")
      headers[n] = String(req.headers[n]);
  const stamp = String(req.headers["x-amz-date"]);
  const date = new Date(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
  );
  const again = signRequest({
    method: String(req.method),
    url: new URL(`http://${req.headers.host}${req.url}`),
    headers,
    payloadHash: String(req.headers["x-amz-content-sha256"]),
    region: "ru-central-1",
    credentials: CREDS,
    date,
  });
  return again.authorization === auth;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await bodyOf(req);
    const url = new URL(`http://x${req.url}`);
    requests.push({
      method: String(req.method),
      path: url.pathname,
      ...(req.headers["x-amz-server-side-encryption"]
        ? { sse: String(req.headers["x-amz-server-side-encryption-aws-kms-key-id"]) }
        : {}),
    });
    if (!verified(req, body)) {
      res.writeHead(403).end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
      return;
    }
    const [, bucket, ...rest] = url.pathname.split("/");
    if (bucket !== "system-files") return void res.writeHead(404).end();
    const key = decodeURIComponent(rest.join("/"));
    if (req.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get("continuation-token") ?? "0");
      const page = all.slice(start, start + 2);
      const more = start + 2 < all.length;
      res
        .writeHead(200, { "content-type": "application/xml" })
        .end(
          `<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${page
            .map((k) => `<Contents><Key>${k}</Key></Contents>`)
            .join(
              "",
            )}${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}</ListBucketResult>`,
        );
      return;
    }
    const obj = objects.get(key);
    if (req.method === "PUT") {
      objects.set(key, {
        body,
        headers: {
          "content-type": String(req.headers["content-type"]),
          "x-amz-meta-wizard": String(req.headers["x-amz-meta-wizard"]),
        },
      });
      return void res.writeHead(200).end();
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      return void res.writeHead(204).end();
    }
    if (!obj) return void res.writeHead(404).end();
    res.writeHead(200, { ...obj.headers, "content-length": String(obj.body.length) });
    res.end(req.method === "HEAD" ? undefined : obj.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const meta = (over: Partial<FileMeta> = {}): FileMeta => ({
  name: "Счёт №1.pdf",
  mime: "application/pdf",
  size: 9,
  entity: "order",
  field: "invoice",
  uploadedBy: null,
  uploadedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BYTES = new TextEncoder().encode("%PDF-1.4\n");

async function roundTrip(s: FileStorage) {
  const k1 = `app_abc123def456_prod/${ID(1)}`;
  await s.put(k1, BYTES, meta());
  for (const n of [2, 3, 4]) await s.put(`app_abc123def456_prod/${ID(n)}`, BYTES, meta());
  await s.put(`app_abc123def456_draft/${ID(5)}`, BYTES, meta());
  expect(await s.head(k1)).toEqual(meta());
  expect(await s.get(k1)).toEqual({ data: BYTES, meta: meta() });
  expect(await s.head(`app_abc123def456_prod/${ID(9)}`)).toBeNull();
  expect(await s.list("app_abc123def456_prod/")).toEqual(
    [1, 2, 3, 4].map((n) => `app_abc123def456_prod/${ID(n)}`),
  );
  await s.delete(k1);
  await s.delete(k1);
  expect(await s.get(k1)).toBeNull();
  expect(await purgeSchemaFiles(s, "app_abc123def456_prod")).toBe(3);
  expect(await s.list("app_abc123def456_prod/")).toEqual([]);
  expect(await s.list("app_abc123def456_draft/")).toEqual([`app_abc123def456_draft/${ID(5)}`]);
  // Keys outside <schema>/<uuid> are refused before any I/O.
  await expect(s.put("../etc/passwd", BYTES, meta())).rejects.toThrow("invalid file key");
  await expect(s.list("app_x/../")).rejects.toThrow("invalid file prefix");
  expect(await s.head("app_x/not-a-uuid")).toBeNull();
}

describe("backends", () => {
  test("S3: signed PUT/HEAD/GET/DELETE/ListObjectsV2 (paged), SSE-KMS header, metadata with a Cyrillic name", async () => {
    const s3 = new S3FileStorage({
      endpoint,
      region: "ru-central-1",
      bucket: "system-files",
      credentials: CREDS,
      kmsKeyId: "kms-key-1",
    });
    await roundTrip(s3);
    expect(requests.filter((r) => r.method === "PUT").every((r) => r.sse === "kms-key-1")).toBe(true);
    expect(requests.some((r) => r.path === "/system-files" || r.path === "/system-files/")).toBe(true);
    const wrong = new S3FileStorage({
      endpoint,
      region: "ru-central-1",
      bucket: "system-files",
      credentials: { ...CREDS, secretAccessKey: "wrong" },
    });
    await expect(wrong.head(`app_abc123def456_prod/${ID(1)}`)).rejects.toBeInstanceOf(S3Error);
  });

  test("S3 over Node's fetch with the undici package as dispatcher (installed globally when @wizard/llm loads first)", async () => {
    // B2-43: an explicit content-length went out as "N, N" and undici v7 refused every PUT («fetch failed»).
    const undici = createRequire(new URL("../../../packages/llm/package.json", import.meta.url))(
      "undici",
    ) as {
      Agent: new () => { close(): Promise<void> };
    };
    const dispatcher = new undici.Agent();
    try {
      const s3 = new S3FileStorage({
        endpoint,
        region: "ru-central-1",
        bucket: "system-files",
        credentials: CREDS,
        fetch: (url, init) => fetch(url, { ...init, dispatcher } as RequestInit),
      });
      await roundTrip(s3);
    } finally {
      await dispatcher.close();
    }
  });

  test("folder and memory backends behave alike", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wz-files-"));
    try {
      await roundTrip(new FsFileStorage(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await roundTrip(new MemoryFileStorage());
  });

  test("createFileStorage: fs by default, memory, s3 with keys only", () => {
    expect(createFileStorage({}, { defaultDir: "/x/files" })).toMatchObject({ kind: "fs", root: "/x/files" });
    expect(createFileStorage({ WIZARD_FILES_DIR: "/y" }, { defaultDir: "/x" })).toMatchObject({ root: "/y" });
    expect(createFileStorage({ WIZARD_FILES_STORAGE: "memory" }, { defaultDir: "/x" }).kind).toBe("memory");
    expect(() => createFileStorage({ WIZARD_FILES_STORAGE: "s3" }, { defaultDir: "/x" })).toThrow(
      /WIZARD_S3_ACCESS_KEY_ID/,
    );
    const s3 = createFileStorage(
      {
        WIZARD_FILES_STORAGE: "s3",
        WIZARD_S3_ENDPOINT: "https://s3.cloud.ru",
        WIZARD_S3_ACCESS_KEY_ID: "k",
        WIZARD_S3_SECRET_ACCESS_KEY: "s",
      },
      { defaultDir: "/x" },
    );
    expect(s3).toBeInstanceOf(S3FileStorage);
    expect((s3 as S3FileStorage).config).toMatchObject({ region: "ru-central-1", bucket: "system-files" });
    expect(() => createFileStorage({ WIZARD_FILES_STORAGE: "ftp" }, { defaultDir: "/x" })).toThrow();
  });
});
