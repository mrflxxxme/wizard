// M2-12 (L3-07): partner originals go to the eval S3 bucket in RF, the repository holds only synthetic retellings.
// A loopback S3 stand-in checks every request's SigV4 signature with the runtime's independent implementation.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { signRequest as runtimeSign } from "../../../apps/runtime/src/files/sigv4.ts";
import { BRIEFS_DIR, briefProblems, loadBriefs } from "../lib/briefs.mjs";
import { insideRepo, originalsInRepo, REPO_ROOT, retellingProblems, trackedFiles } from "../lib/partner.mjs";
import { DEFAULT_ENDPOINT, DEFAULT_REGION, isRfEndpoint, s3Config, signRequest } from "../lib/s3.mjs";
import { main } from "../partner-brief.mjs";

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const tmp = mkdtempSync(join(tmpdir(), "wz-partner-test-"));
const briefsDir = join(tmp, "briefs");
const originals = join(tmp, "from-partner");
mkdirSync(briefsDir);
mkdirSync(originals);
const BRIEF = "hz-04-client-crm";
copyFileSync(join(BRIEFS_DIR, `${BRIEF}.json`), join(briefsDir, `${BRIEF}.json`));

// Synthetic "original" of a partner, worded differently from the retelling; the name is a canary-style fake.
const ORIGINAL = [
  "Добрый день! Пишет Elena Vasquez-Holm, у нас студия интерьеров, менеджеров пятеро, дизайнеров двое.",
  "Клиенты пишут отовсюду: форма на сайте, телеграм, звонки — и всё тонет в чатах.",
  "Хотим карточки клиентов, сделки по этапам от первой встречи до договора и отказа с причиной,",
  "напоминалки, если менеджер забыл про следующий шаг, и чтобы начальник мог перекинуть сделку коллеге.",
].join("\n");

const objects = new Map<string, Buffer>();
const seen: { method: string; path: string; meta: Record<string, string> }[] = [];
const creds = { accessKeyId: "test-access-id", secretAccessKey: "test-secret-not-real" };

function verify(req: IncomingMessage, body: Buffer): boolean {
  const auth = String(req.headers.authorization ?? "");
  const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(";") ?? [];
  const stamp = String(req.headers["x-amz-date"] ?? "");
  const date = new Date(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
  );
  if (req.headers["x-amz-content-sha256"] !== sha(body)) return false;
  const headers: Record<string, string> = {};
  for (const h of signed)
    if (!["host", "x-amz-date", "x-amz-content-sha256"].includes(h)) headers[h] = String(req.headers[h]);
  const expected = runtimeSign({
    method: req.method ?? "GET",
    url: new URL(`http://${req.headers.host}${req.url}`),
    headers,
    payloadHash: sha(body),
    region: "ru-1",
    credentials: creds,
    date,
  });
  return expected.authorization === auth;
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (!verify(req, body)) {
      res.writeHead(403).end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
      return;
    }
    const path = decodeURIComponent(req.url ?? "");
    const meta = Object.fromEntries(
      Object.entries(req.headers)
        .filter(([k]) => k.startsWith("x-amz-meta-"))
        .map(([k, v]) => [k, String(v)]),
    );
    seen.push({ method: req.method ?? "", path, meta });
    if (req.method === "PUT") {
      objects.set(path, body);
      res.writeHead(200).end();
    } else if (req.method === "GET" && objects.has(path)) {
      res.writeHead(200).end(objects.get(path));
    } else res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
  });
});

let env: Record<string, string>;
const io = () => {
  const out: string[] = [];
  const errs: string[] = [];
  return { out, errs, opts: { env, log: (l: string) => out.push(l), err: (l: string) => errs.push(l) } };
};

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  env = {
    EVAL_S3_ENDPOINT: `http://127.0.0.1:${port}`,
    EVAL_S3_REGION: "ru-1",
    EVAL_S3_BUCKET: "wizard-eval",
    EVAL_S3_ACCESS_KEY_ID: creds.accessKeyId,
    EVAL_S3_SECRET_ACCESS_KEY: creds.secretAccessKey,
  };
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

describe("upload → fetch round trip (mock S3, signatures checked)", () => {
  const original = join(originals, "brief.txt");
  writeFileSync(original, ORIGINAL);
  const key = `eval/partners/P01/${BRIEF}.txt`;

  test("upload puts the original under eval/partners/<ref>/<id> and records only key, sha256 and size", async () => {
    const { out, errs, opts } = io();
    const code = await main(
      ["upload", original, "--partner=P01", `--brief=${BRIEF}`, `--briefs-dir=${briefsDir}`],
      opts,
    );
    expect(errs).toEqual([]);
    expect(code).toBe(0);
    expect(objects.get(`/wizard-eval/${key}`)?.toString("utf8")).toBe(ORIGINAL);
    expect(seen.at(-1)).toMatchObject({
      method: "PUT",
      meta: { "x-amz-meta-sha256": sha(ORIGINAL), "x-amz-meta-partner": "P01", "x-amz-meta-brief": BRIEF },
    });
    const brief = JSON.parse(readFileSync(join(briefsDir, `${BRIEF}.json`), "utf8"));
    expect(brief.partner).toEqual({
      ref: "P01",
      original: { key, sha256: sha(ORIGINAL), bytes: Buffer.byteLength(ORIGINAL) },
    });
    expect(briefProblems(brief, `${BRIEF}.json`)).toEqual([]);
    // Nothing of the original is in the brief file.
    const raw = readFileSync(join(briefsDir, `${BRIEF}.json`), "utf8");
    expect(raw).not.toContain("Elena Vasquez-Holm");
    expect(out.join("\n")).toContain(`s3://wizard-eval/${key}`);
    expect(out.join("\n")).not.toContain(creds.secretAccessKey);
  });

  test("fetch writes the original outside the repository (0600) and verifies sha256", async () => {
    const { out, opts } = io();
    expect(await main(["fetch", `--brief=${BRIEF}`, `--briefs-dir=${briefsDir}`], opts)).toBe(0);
    const file = /Оригинал: (\S+)/.exec(out.join("\n"))?.[1] ?? "";
    expect(insideRepo(file)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    rmSync(join(file, ".."), { recursive: true, force: true });
  });

  test("fetch refuses an --out inside the repository and writes nothing there", async () => {
    const target = join(REPO_ROOT, "tools", "eval", "partner-originals");
    const { errs, opts } = io();
    expect(
      await main(["fetch", `--brief=${BRIEF}`, `--briefs-dir=${briefsDir}`, `--out=${target}`], opts),
    ).toBe(1);
    expect(errs.join("\n")).toMatch(/внутри репозитория/);
    expect(existsSync(target)).toBe(false);
  });

  test("a tampered object fails the sha256 check", async () => {
    objects.set(`/wizard-eval/${key}`, Buffer.from(`${ORIGINAL} `));
    const { errs, opts } = io();
    const out = join(tmp, "tampered");
    expect(await main(["fetch", `--brief=${BRIEF}`, `--briefs-dir=${briefsDir}`, `--out=${out}`], opts)).toBe(
      1,
    );
    expect(errs.join("\n")).toMatch(/sha256 не совпадает/);
    expect(existsSync(join(out, `${BRIEF}.txt`))).toBe(false);
    objects.set(`/wizard-eval/${key}`, Buffer.from(ORIGINAL));
  });

  test("a wrong secret is rejected by the store (signature is really checked)", async () => {
    const { errs, opts } = io();
    opts.env = { ...env, EVAL_S3_SECRET_ACCESS_KEY: "other-secret" };
    expect(
      await main(["fetch", `--brief=${BRIEF}`, `--briefs-dir=${briefsDir}`, `--out=${join(tmp, "x")}`], opts),
    ).toBe(1);
    expect(errs.join("\n")).toMatch(/HTTP 403 .*SignatureDoesNotMatch/);
    expect(errs.join("\n")).not.toContain("other-secret");
  });
});

describe("guards", () => {
  test("an original inside the repository is refused before it is read or uploaded", async () => {
    const before = seen.length;
    const inRepo = join(BRIEFS_DIR, "hz-02-equipment-inventory.json");
    const { errs, opts } = io();
    const code = await main(
      ["upload", inRepo, "--partner=P02", "--brief=hz-02-equipment-inventory", `--briefs-dir=${briefsDir}`],
      opts,
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/внутри репозитория/);
    expect(seen.length).toBe(before);
  });

  test("the retelling must exist first and must not copy the original", async () => {
    const f = join(originals, "copy.txt");
    const brief = JSON.parse(readFileSync(join(BRIEFS_DIR, "hz-02-equipment-inventory.json"), "utf8"));
    copyFileSync(
      join(BRIEFS_DIR, "hz-02-equipment-inventory.json"),
      join(briefsDir, "hz-02-equipment-inventory.json"),
    );
    writeFileSync(f, brief.text);
    const { errs, opts } = io();
    const args = [
      "upload",
      f,
      "--partner=P02",
      "--brief=hz-02-equipment-inventory",
      `--briefs-dir=${briefsDir}`,
    ];
    expect(await main(args, opts)).toBe(1);
    expect(errs.join("\n")).toMatch(/пересказ совпадает с оригиналом/);
    const missing = io();
    expect(
      await main(
        ["upload", f, "--partner=P02", "--brief=hz-77-none", `--briefs-dir=${briefsDir}`],
        missing.opts,
      ),
    ).toBe(1);
    expect(missing.errs.join("\n")).toMatch(/сначала напишите синтетический пересказ/);
  });

  test("retellingProblems: verbatim 12-word fragment or > 30 % shared 6-word shingles", () => {
    const words = Array.from({ length: 40 }, (_, i) => `слово${i}`);
    const original = words.join(" ");
    expect(retellingProblems(original, original)).toEqual(["пересказ совпадает с оригиналом"]);
    expect(retellingProblems(original, `${words.slice(0, 12).join(" ")} и дальше своими словами`)[0]).toMatch(
      /дословный фрагмент/,
    );
    expect(
      retellingProblems(ORIGINAL, JSON.parse(readFileSync(join(BRIEFS_DIR, `${BRIEF}.json`), "utf8")).text),
    ).toEqual([]);
  });

  test("originalsInRepo finds a tracked file equal to a recorded original; the real repository has none", () => {
    const root = join(tmp, "fake-repo");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "partner.txt"), ORIGINAL);
    writeFileSync(join(root, "docs", "other.txt"), "другое");
    const briefs = [
      {
        id: BRIEF,
        partner: { ref: "P01", original: { sha256: sha(ORIGINAL), bytes: Buffer.byteLength(ORIGINAL) } },
      },
    ];
    expect(originalsInRepo(briefs, ["docs/partner.txt", "docs/other.txt"], root)).toEqual([
      `docs/partner.txt = оригинал партнёра для ${BRIEF}`,
    ]);
    expect(originalsInRepo(loadBriefs(), trackedFiles())).toEqual([]);
  });

  test("check exits 0 on the repository", async () => {
    const { out, opts } = io();
    expect(await main(["check"], opts)).toBe(0);
    expect(out.join("\n")).toMatch(/Оригиналов партнёров в репозитории нет/);
  });

  test("brief format: a bad partner block is reported", () => {
    const b = JSON.parse(readFileSync(join(BRIEFS_DIR, `${BRIEF}.json`), "utf8"));
    const bad = {
      ...b,
      partner: { ref: "Acme", original: { key: "elsewhere/x.exe", sha256: "zz", bytes: 0 } },
    };
    expect(briefProblems(bad, `${BRIEF}.json`)).toEqual([
      expect.stringMatching(/partner.ref "Acme"/),
      expect.stringMatching(/partner.original.key/),
      expect.stringMatching(/sha256/),
      expect.stringMatching(/bytes/),
    ]);
    const verbatim = {
      ...b,
      partner: {
        ref: "P03",
        original: { key: `eval/partners/P03/${BRIEF}.txt`, sha256: sha(b.text), bytes: 10 },
      },
    };
    expect(briefProblems(verbatim, `${BRIEF}.json`)).toEqual([
      expect.stringMatching(/синтетический пересказ/),
    ]);
  });
});

describe("S3 settings (EVAL_S3_*, Timeweb by default)", () => {
  test("defaults: Timeweb endpoint and region ru-1; AWS_* keys accepted as in the eval-live workflow", () => {
    expect(DEFAULT_ENDPOINT).toBe("https://s3.twcstorage.ru");
    expect(DEFAULT_REGION).toBe("ru-1");
    const c = s3Config({ EVAL_S3_BUCKET: "b", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "s" });
    expect(c.config).toMatchObject({ endpoint: DEFAULT_ENDPOINT, region: "ru-1", bucket: "b" });
    expect(
      s3Config({
        EVAL_S3_BUCKET: "b",
        EVAL_S3_ACCESS_KEY_ID: "a",
        EVAL_S3_SECRET_ACCESS_KEY: "s",
        EVAL_S3_ENDPOINT: "https://s3.cloud.ru",
        EVAL_S3_REGION: "ru-central-1",
      }).config,
    ).toMatchObject({ endpoint: "https://s3.cloud.ru", region: "ru-central-1" });
  });

  test("only RF endpoints: *.ru over https, Yandex Object Storage, loopback for tests", () => {
    expect(isRfEndpoint("https://s3.twcstorage.ru")).toBe(true);
    expect(isRfEndpoint("https://storage.yandexcloud.net")).toBe(true);
    expect(isRfEndpoint("http://127.0.0.1:9000")).toBe(true);
    expect(isRfEndpoint("http://s3.twcstorage.ru")).toBe(false);
    expect(isRfEndpoint("https://s3.eu-central-1.amazonaws.com")).toBe(false);
    expect(isRfEndpoint("https://evil.ru.example.com")).toBe(false);
    const c = s3Config({
      EVAL_S3_BUCKET: "b",
      EVAL_S3_ACCESS_KEY_ID: "a",
      EVAL_S3_SECRET_ACCESS_KEY: "s",
      EVAL_S3_ENDPOINT: "https://s3.amazonaws.com",
    });
    expect(c.error).toMatch(/только в S3 в РФ/);
  });

  test("not configured → exit 3 with variable names only", async () => {
    const out: string[] = [];
    const code = await main(["fetch", `--brief=${BRIEF}`], {
      env: { EVAL_S3_ACCESS_KEY_ID: "visible-id" },
      log: () => {},
      err: (l) => out.push(l),
    });
    expect(code).toBe(3);
    expect(out.join("\n")).toMatch(/не задан EVAL_S3_BUCKET, EVAL_S3_SECRET_ACCESS_KEY/);
    expect(out.join("\n")).not.toContain("visible-id");
    expect(await main(["nope"], { env: {}, log: () => {}, err: () => {} })).toBe(2);
  });

  test("the eval signer matches the runtime's SigV4 for the same request", () => {
    const url = new URL("https://s3.twcstorage.ru/wizard-eval/eval/partners/P01/hz-04-client-crm.txt");
    const date = new Date("2026-10-01T12:00:00.000Z");
    const input = {
      method: "PUT",
      url,
      headers: { "content-type": "text/plain; charset=utf-8", "x-amz-meta-partner": "P01" },
      payloadHash: sha("x"),
    };
    const mine = signRequest({ ...input, region: "ru-1", ...creds, date });
    const theirs = runtimeSign({ ...input, region: "ru-1", credentials: creds, date });
    expect(mine.authorization).toBe(theirs.authorization);
  });
});
