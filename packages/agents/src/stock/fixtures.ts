// Stock answers without the network (B2-38): search answers in the format of the Pexels and Pixabay APIs
// (tools/fixtures/stock/<provider>.json — synthetic, gen.mjs; <provider>.recorded.json — live answers of `record` mode,
// which win over the synthetic ones; keyed «query|orientation», «*» — any other query) and deterministic pictures for
// the image URLs of those answers (PNG generated from the URL: soft gradients in the tones of the seed). CI and the
// fixture mode of the platform (WIZARD_STOCK_MODE=fixture) never call a stock. `record` mode (live + recording) keeps
// only the metadata the client reads, with the keys scrubbed, and only for Pexels: the Pixabay API terms ask to cache
// its answers for 24 hours, not to keep them, so Pixabay stays synthetic (docs/ops/eval-d76.md «Стоки из CI»).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import type { FetchFn, StockProvider } from "./client.js";

/** tools/fixtures/stock of the repository. */
export const STOCK_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/fixtures/stock",
);

/** Keys a fixture mode client gets (the recorded answers ignore them). */
export const FIXTURE_KEYS: Readonly<Record<StockProvider, string>> = {
  pexels: "fixture-pexels",
  pixabay: "fixture-pixabay",
};

type Answers = Record<string, unknown>;

const answersFile = (dir: string, provider: StockProvider) => join(dir, `${provider}.json`);
/** File of the live answers of `record` mode (they win over the synthetic answers of the same query). */
export const recordedFile = (dir: string, provider: StockProvider) => join(dir, `${provider}.recorded.json`);

const readAnswers = (f: string): Answers =>
  existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Answers) : {};

function loadAnswers(dir: string, provider: StockProvider): Answers {
  return { ...readAnswers(answersFile(dir, provider)), ...readAnswers(recordedFile(dir, provider)) };
}

/** «query|orientation» of a search URL, or null for other URLs. */
export function searchKey(url: URL): { provider: StockProvider; key: string } | null {
  if (url.hostname === "api.pexels.com" && url.pathname === "/v1/search")
    return {
      provider: "pexels",
      key: `${url.searchParams.get("query") ?? ""}|${url.searchParams.get("orientation") ?? ""}`,
    };
  if (url.hostname === "pixabay.com" && url.pathname === "/api/") {
    const o = url.searchParams.get("orientation");
    const orientation = o === "horizontal" ? "landscape" : o === "vertical" ? "portrait" : "square";
    return { provider: "pixabay", key: `${url.searchParams.get("q") ?? ""}|${orientation}` };
  }
  return null;
}

// ---------------------------------------------------------------- deterministic pictures

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = (CRC_TABLE[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.byteLength);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A PNG «photo» of the seed: a diagonal gradient between two tones with soft light spots (deterministic). */
export function fixtureImage(seed: string, width: number, height: number): Uint8Array {
  const h = createHash("sha256").update(seed).digest();
  const at = (i: number) => h[i % h.length] as number;
  const tone = (i: number) => [at(i), at(i + 1), at(i + 2)].map((v) => 60 + Math.round((v / 255) * 150));
  const a = tone(0);
  const b = tone(3);
  const spots = Array.from({ length: 4 }, (_, k) => ({
    x: (at(6 + k * 3) / 255) * width,
    y: (at(7 + k * 3) / 255) * height,
    r: (0.15 + (at(8 + k * 3) / 255) * 0.25) * Math.max(width, height),
  }));
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      let light = 0;
      for (const s of spots) {
        const d = Math.hypot(x - s.x, y - s.y) / s.r;
        if (d < 1) light += (1 - d) * (1 - d) * 0.35;
      }
      for (let c = 0; c < 3; c++) {
        const v = (a[c] as number) * (1 - t) + (b[c] as number) * t;
        raw[o++] = Math.max(0, Math.min(255, Math.round(v + (255 - v) * Math.min(0.6, light))));
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

/** Size of a fixture picture from its URL (`wz=960x640`), else 960×640. */
function fixtureSize(url: URL): [number, number] {
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(url.searchParams.get("wz") ?? "");
  const w = Math.min(1600, Number(m?.[1] ?? 960));
  const h = Math.min(1600, Number(m?.[2] ?? 640));
  return [w, h];
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/**
 * fetch of the fixture mode: recorded search answers by «query|orientation» (else «*», else an empty answer) and
 * generated pictures for the image hosts. Any other URL is refused, like the egress allowlist.
 */
export function fixtureStockFetch(dir = STOCK_FIXTURES_DIR): FetchFn {
  const cache = new Map<StockProvider, Answers>();
  return async (input) => {
    const url = new URL(input);
    const s = searchKey(url);
    if (s) {
      let answers = cache.get(s.provider);
      if (!answers) {
        answers = loadAnswers(dir, s.provider);
        cache.set(s.provider, answers);
      }
      const body =
        answers[s.key] ?? answers["*"] ?? (s.provider === "pexels" ? { photos: [] } : { hits: [] });
      return json(body);
    }
    if (["images.pexels.com", "pixabay.com", "cdn.pixabay.com"].includes(url.hostname)) {
      const [w, h] = fixtureSize(url);
      const png = fixtureImage(url.pathname, w, h);
      return new Response(png as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { "content-type": "image/png", "content-length": String(png.byteLength) },
      });
    }
    return new Response("not in the fixtures", { status: 404 });
  };
}

/** Providers whose live answers `record` mode keeps (Pixabay: a 24 h cache only, by its API terms). */
export const RECORDED_PROVIDERS: readonly StockProvider[] = ["pexels"];

/** Largest side of the fixture picture drawn for a recorded answer (`wz`, as the synthetic answers have). */
const RECORDED_SIDE = 960;

const withSize = (u: unknown, width: number, height: number): string | undefined => {
  if (typeof u !== "string" || !(width > 0) || !(height > 0)) return undefined;
  try {
    const url = new URL(u);
    const k = RECORDED_SIDE / Math.max(width, height);
    url.searchParams.set(
      "wz",
      `${Math.max(10, Math.round(width * k))}x${Math.max(10, Math.round(height * k))}`,
    );
    return url.toString();
  } catch {
    return undefined;
  }
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** A JSON value with every given secret (and its URL-encoded form) cut out of its strings, `key=` parameters dropped. */
export function scrubSecrets<T>(value: T, secrets: readonly string[]): T {
  const cut = secrets
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
    .flatMap((s) => [...new Set([s, encodeURIComponent(s)])]);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      let out = v;
      for (const s of cut) out = out.split(s).join("");
      return out.replace(/([?&])key=[^&#]*&?/gi, "$1").replace(/[?&]$/, "");
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * A live search answer as `record` mode keeps it: only the fields the client reads (no next page, colours or alt
 * texts), image URLs with `wz=<w>x<h>` in the photo's proportions (the fixture fetch draws that picture instead of
 * downloading) and the secrets scrubbed. null for a provider that is not kept (RECORDED_PROVIDERS) or a bad answer.
 */
export function sanitizeStockAnswer(
  provider: StockProvider,
  body: unknown,
  secrets: readonly string[] = [],
): unknown {
  if (!RECORDED_PROVIDERS.includes(provider) || !isObject(body) || !Array.isArray(body.photos)) return null;
  const photos = body.photos.filter(isObject).map((p) => {
    const src = isObject(p.src) ? p.src : {};
    const original = withSize(src.original, Number(p.width), Number(p.height));
    const large2x = withSize(src.large2x, Number(p.width), Number(p.height));
    return {
      id: p.id,
      width: p.width,
      height: p.height,
      url: p.url,
      photographer: p.photographer,
      ...(typeof p.photographer_url === "string" ? { photographer_url: p.photographer_url } : {}),
      src: { ...(original ? { original } : {}), ...(large2x ? { large2x } : {}) },
    };
  });
  return scrubSecrets(
    { page: body.page, per_page: body.per_page, photos, total_results: body.total_results },
    secrets,
  );
}

/**
 * fetch of the record mode: the live search answers of RECORDED_PROVIDERS go into <provider>.recorded.json
 * (sanitizeStockAnswer: metadata only, `secrets` — the keys — scrubbed; queries sorted, so a re-recording diffs).
 */
export function recordingStockFetch(
  inner: FetchFn,
  dir = STOCK_FIXTURES_DIR,
  o: { secrets?: readonly string[] } = {},
): FetchFn {
  return async (input, init) => {
    const res = await inner(input, init);
    const s = searchKey(new URL(input));
    if (!s || res.status !== 200 || !RECORDED_PROVIDERS.includes(s.provider)) return res;
    const body = sanitizeStockAnswer(s.provider, await res.clone().json(), o.secrets ?? []);
    if (body === null) return res;
    const file = recordedFile(dir, s.provider);
    const answers = { ...readAnswers(file), [s.key]: body };
    const sorted = Object.fromEntries(
      Object.entries(answers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(sorted, null, 1)}\n`);
    return res;
  };
}
