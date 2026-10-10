// The visual critic of a v3 build in the platform (V3-13): the CriticInspector of @wizard/agents over a slot of the
// process Chromium (agents/goal-browser.ts, B2-28). The system's files with the critic's changes are built by
// buildSystem (prod) and opened without a port or network: every request of the page is answered here — the bundle,
// /_wizard/spec (RoleSpec of the public role), /_wizard/fonts (ui-kit fonts), photos (the library's copies or stand-ins
// of the platform), the data API with the draft's demo rows the public role reads (V3-40: the visitor's draft is seeded,
// so the critic sees the same filled catalog; without rows — empty lists). Each page at each viewport (390/768/1440
// light, 390 dark; reduced motion — content visible at rest, catalog M05) runs the in-page checks once its pictures have
// loaded; screenshots are downscaled to JPEG on a canvas of the same browser. The default hook createCriticHook({inspect})
// is wired by host.ts.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { BrowserContext, Page, Request, Route } from "@playwright/test";
import {
  CRITIC_CHECKS_SCRIPT,
  CRITIC_INIT_SCRIPT,
  type CriticCheckOptions,
  type CriticCheckResult,
  type CriticInspection,
  type CriticInspector,
  type CriticOptions,
  type CriticShot,
  type CriticShotRequest,
  createCriticHook,
  type DeterministicProblem,
  previewPhotoSvg,
  type V3StageHook,
} from "@wizard/agents/builder";
import type { AppSpec } from "@wizard/appspec";
import { buildSystem } from "@wizard/build";
import { generateSeed, type SeedHint } from "@wizard/gates";
import { buildRoleSpec, type FileStorage, libraryPhotoFile, type RoleSpec } from "@wizard/runtime";
import type { GoalBrowserProvider } from "../agents/goal-browser.js";

/** Origin the pages open at: *.localhost is a secure context (crypto.randomUUID of the SDK), no request leaves. */
export const CRITIC_ORIGIN = "http://critic.localhost";
/** A page settles: its data requests answered, the fonts ready (ms cap). */
const SETTLE_MS = 5_000;
/** A page load (ms cap). */
const GOTO_MS = 20_000;
/** Quiet time after the fonts and two frames, ms. */
const QUIET_MS = 150;
/** The page's pictures load (ms cap): the photos come from the shared storage, slower than the page itself. */
const IMAGES_MS = 8_000;
/** Pictures whose requests have finished turn complete (ms cap). */
const DECODE_MS = 1_000;
const JPEG_QUALITY = 0.6;

/** packages/ui-kit/fonts, like the runtime's /_wizard/fonts. */
const FONTS_DIR = join(
  dirname(createRequire(import.meta.url).resolve("@wizard/ui-kit/fonts")),
  "../../fonts",
);
const fontCache = new Map<string, Buffer | null>();
async function font(file: string): Promise<Buffer | null> {
  if (!/^[\w.-]+\.woff2$/.test(file)) return null;
  if (!fontCache.has(file)) fontCache.set(file, await readFile(join(FONTS_DIR, file)).catch(() => null));
  return fontCache.get(file) ?? null;
}

const TYPES: Readonly<Record<string, string>> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  woff2: "font/woff2",
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
  json: "application/json",
};
const typeOf = (path: string) => TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream";

/** The RoleSpec /_wizard/spec gives an anonymous visitor (the public role of the spec). */
function roleSpec(spec: AppSpec): RoleSpec {
  const role = spec.roles.find((r) => r.access === "public")?.name ?? null;
  return buildRoleSpec(spec, {
    role,
    compliance: {
      consentText: spec.compliance?.consentText ?? null,
      policyPage: spec.compliance?.policyPage ?? null,
      policyVersion: "critic",
      consentTextHash: "critic",
    },
    features: { phoneOtp: false },
    env: "prod",
  });
}

/** Demo rows of a system by entity (the draft's seed, every field of the spec; each row has `id`). */
export type CriticDemoRows = Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;

/**
 * The demo rows the draft of a system holds — generateSeed(spec, sha256(systemKey), {hints}) as seed_draft makes them
 * (agents/draft.ts seedDraft): the critic's browser lists the same records with the same names the visitor sees.
 */
export function draftDemoRows(spec: AppSpec, systemKey: string, hints: readonly SeedHint[]): CriticDemoRows {
  const key = createHash("sha256").update(systemKey).digest("hex");
  return generateSeed(spec, key, hints.length ? { hints } : {}).rows;
}

export interface CriticInspectorOptions {
  browser: GoalBrowserProvider;
  /** Photos of /_wizard/photos/<id>/<w> and /api/files/<id>/img/<w>; default — the platform's stand-ins. */
  photo?: (
    path: string,
  ) =>
    | { type: string; body: string | Uint8Array }
    | null
    | Promise<{ type: string; body: string | Uint8Array } | null>;
  /**
   * The draft's demo rows for the spec under check (draftDemoRows): GET /api/data/<entity>[/<id>] answers them for the
   * entities the public role reads, as the runtime does (row filter, hidden fields, the list query); others stay empty.
   * Absent or failed — every list is empty.
   */
  data?: (spec: AppSpec) => CriticDemoRows | Promise<CriticDemoRows>;
  log?: (msg: string, fields?: Record<string, string | number>) => void;
}

type Doc = Record<string, unknown>;

/** Counters of one inspection (the critic_inspection log line). */
interface InspectStats {
  /** Photos answered by `photo`. */
  photos: number;
  /** Photos answered by the platform's stand-ins. */
  stubs: number;
  /** Rows the data API answered. */
  rows: number;
}

/**
 * The rows the anonymous visitor reads, by entity, shaped as the runtime's data API gives them (runtime data/pg.ts
 * `shape`): id, created_at, updated_at, created_by and the role's visible fields; the public role's row filter applied
 * (`$user.*` matches nothing without a user). Seed rows are written in one transaction: one created_at for all of them.
 */
function publicDocs(spec: AppSpec, role: RoleSpec, rows: CriticDemoRows, at: string): Map<string, Doc[]> {
  const out = new Map<string, Doc[]>();
  for (const e of role.entities) {
    const perm = spec.permissions.find((p) => p.role === role.role && p.entity === e.name) as
      | (AppSpec["permissions"][number] & { rowFilterOps?: readonly string[] })
      | undefined;
    if (!perm?.ops.includes("read")) continue;
    const filter =
      perm.rowFilter && (!perm.rowFilterOps || perm.rowFilterOps.includes("read"))
        ? Object.entries(perm.rowFilter)
        : [];
    const anonymous = filter.some(([, v]) => typeof v === "string" && v.startsWith("$user."));
    out.set(
      e.name,
      anonymous
        ? []
        : (rows[e.name] ?? [])
            .filter((r) =>
              filter.every(([k, v]) => r[k] !== null && r[k] !== undefined && String(r[k]) === String(v)),
            )
            .map((r) => {
              const doc: Doc = { id: r.id, created_at: at, updated_at: at, created_by: null };
              for (const f of e.fields) doc[f.name] = r[f.name] ?? null;
              return doc;
            }),
    );
  }
  return out;
}

interface ListFilter {
  field: string;
  op: string;
  value: string | readonly string[] | null;
}

/** The list query of GET /api/data/<entity> (runtime.yaml#data_api.query_params; SDK buildListQuery). */
function listQuery(p: URLSearchParams) {
  const filter: ListFilter[] = [];
  for (const [key, value] of p) {
    const m = /^filter\[([a-z_][a-z0-9_]*)\](?:\[([a-z]+)\])?$/.exec(key);
    if (!m) continue;
    const op = m[2] ?? "eq";
    filter.push({
      field: m[1] as string,
      op,
      value: value === "null" && (op === "eq" || op === "ne") ? null : op === "in" ? value.split(",") : value,
    });
  }
  const sort = (p.get("sort") ?? "")
    .split(",")
    .filter(Boolean)
    .slice(0, 3)
    .map((s) => ({ field: s.replace(/^-/, ""), desc: s.startsWith("-") }));
  const int = (name: string, def: number, max: number) => {
    const n = Number(p.get(name) ?? "");
    return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : def;
  };
  return {
    filter,
    sort,
    page: int("page", 1, 1_000_000),
    limit: int("limit", 20, 100),
    search: (p.get("q") ?? "").trim().toLowerCase(),
  };
}

const text = (v: unknown) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
/** A value equals a query value (numbers by value, booleans as «true»/«false»). */
const same = (v: unknown, q: string) => (typeof v === "number" ? v === Number(q) : text(v) === q);
const compare = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? a - b : text(a) < text(b) ? -1 : text(a) > text(b) ? 1 : 0;

function matches(d: Doc, f: ListFilter): boolean {
  const v = d[f.field];
  const none = v === null || v === undefined;
  if (f.value === null) return f.op === "eq" ? none : !none;
  const q = f.value;
  switch (f.op) {
    case "eq":
      return !none && same(v, q as string);
    case "ne":
      return none || !same(v, q as string);
    case "in":
      return !none && (q as readonly string[]).some((x) => same(v, x));
    case "contains":
      return !none && text(v).toLowerCase().includes(String(q).toLowerCase());
    default: {
      if (none) return false;
      const c = compare(v, typeof v === "number" ? Number(q) : q);
      return f.op === "lt"
        ? c < 0
        : f.op === "lte"
          ? c <= 0
          : f.op === "gt"
            ? c > 0
            : f.op === "gte"
              ? c >= 0
              : false;
    }
  }
}

/** A page of the rows by the list query: filters, `q`, order (default created_at desc, then id), page and limit. */
function listOf(docs: readonly Doc[], p: URLSearchParams) {
  const q = listQuery(p);
  const found = docs.filter(
    (d) =>
      q.filter.every((f) => matches(d, f)) &&
      (!q.search ||
        Object.entries(d).some(
          ([k, v]) => k !== "id" && typeof v === "string" && v.toLowerCase().includes(q.search),
        )),
  );
  const keys = [
    ...(q.sort.length ? q.sort : [{ field: "created_at", desc: true }]),
    ...(q.sort.some((s) => s.field === "id") ? [] : [{ field: "id", desc: false }]),
  ];
  found.sort((a, b) => {
    for (const k of keys) {
      const x = a[k.field];
      const y = b[k.field];
      const nx = x === null || x === undefined;
      const ny = y === null || y === undefined;
      if (nx && ny) continue;
      // Postgres: NULLS LAST ascending, NULLS FIRST descending.
      if (nx || ny) return (nx ? 1 : -1) * (k.desc ? -1 : 1);
      const c = compare(x, y);
      if (c) return k.desc ? -c : c;
    }
    return 0;
  });
  const from = (q.page - 1) * q.limit;
  return {
    items: found.slice(from, from + q.limit),
    page: q.page,
    limit: q.limit,
    total: found.length,
    hasMore: q.page * q.limit < found.length,
  };
}

/** Answers every request of a page opened at CRITIC_ORIGIN (no network). */
function handler(
  client: ReadonlyMap<string, Uint8Array>,
  spec: string,
  data: ReadonlyMap<string, readonly Doc[]>,
  o: CriticInspectorOptions,
  hold: Route[],
  stats: InspectStats,
) {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const photo = async (route: Route, path: string, name: string) => {
    const own = await Promise.resolve(o.photo?.(path)).catch(() => null);
    if (own) stats.photos += 1;
    else stats.stubs += 1;
    return own
      ? route.fulfill({ status: 200, contentType: own.type, body: Buffer.from(own.body) })
      : route.fulfill({ status: 200, contentType: "image/svg+xml", body: previewPhotoSvg(name) });
  };
  return async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== CRITIC_ORIGIN) return route.abort("blockedbyclient");
    const path = decodeURIComponent(url.pathname);
    if (path === "/_wizard/spec")
      return route.fulfill({ status: 200, contentType: "application/json", body: spec });
    const f = /^\/_wizard\/fonts\/([\w.-]+)$/.exec(path);
    if (f) {
      const body = await font(f[1] as string);
      return body
        ? route.fulfill({ status: 200, contentType: "font/woff2", body })
        : route.fulfill({ status: 404 });
    }
    const pic =
      /^\/_wizard\/photos\/([\w-]+)\/\d+$/.exec(path) ?? /^\/api\/files\/([\w.-]+)\/img\/\d+$/.exec(path);
    if (pic) return photo(route, path, `${pic[1]}.svg`);
    // The realtime stream stays open, as the runtime's does (released when the context closes).
    if (path === "/api/events") {
      hold.push(route);
      return;
    }
    if (path === "/api/auth/me") return json(route, { user: null });
    const d = /^\/api\/data\/(\w+)(?:\/([^/]+))?$/.exec(path);
    if (d) {
      if (req.method() !== "GET")
        return json(route, { error: { code: "FORBIDDEN", message: "Только просмотр" } }, 403);
      const docs = data.get(d[1] as string) ?? [];
      if (d[2] !== undefined) {
        const item = docs.find((x) => String(x.id) === d[2]);
        if (item) stats.rows += 1;
        return item
          ? json(route, { item })
          : json(route, { error: { code: "NOT_FOUND", message: "Не найдено" } }, 404);
      }
      const page = listOf(docs, url.searchParams);
      stats.rows += page.items.length;
      return json(route, page);
    }
    if (/^\/api\/fn\/\w+$/.test(path)) return json(route, { result: [], deps: [] });
    if (path.startsWith("/api/"))
      return json(route, { error: { code: "NOT_FOUND", message: "Не найдено" } }, 404);
    const file = client.get(path === "/" ? "index.html" : path.slice(1));
    if (file)
      return route.fulfill({
        status: 200,
        contentType: typeOf(path === "/" ? "index.html" : path),
        body: Buffer.from(file),
      });
    // History routes of the SPA fall back to the page.
    return route.fulfill({
      status: 200,
      contentType: TYPES.html as string,
      body: Buffer.from(client.get("index.html") ?? ""),
    });
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The page's pictures loaded, as a visitor who scrolled through it sees them: a pass in screen steps starts the lazy
 * ones (`loading="lazy"` loads near the viewport, a full-page screenshot never scrolls), the image requests in flight
 * finish — photos come from the shared storage and arrive after the page has rendered — and the pictures are decoded.
 * Without this the screenshots showed the empty grey frames of the photos (V3-40 pilot: «фото в hero пустое/серое»).
 */
async function loadImages(page: Page, inflight: ReadonlySet<Request>, scroll: boolean): Promise<void> {
  const deadline = Date.now() + IMAGES_MS;
  if (scroll)
    await page
      .evaluate(async (cap) => {
        const end = Date.now() + cap;
        const frames = () =>
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        for (
          let y = innerHeight;
          y < document.documentElement.scrollHeight && Date.now() < end;
          y += innerHeight
        ) {
          window.scrollTo(0, y);
          await frames();
        }
        window.scrollTo(0, 0);
        await frames();
      }, IMAGES_MS)
      .catch(() => {});
  // Requests reach this process a moment after the page starts them: in flight is «none» twice in a row.
  for (let quiet = 0; quiet < 2 && Date.now() < deadline; ) {
    quiet = inflight.size ? 0 : quiet + 1;
    await sleep(40);
  }
  await page
    .evaluate(
      async (cap) => {
        const end = Date.now() + cap;
        const shown = () => [...document.images].filter((i) => i.getClientRects().length > 0);
        while (Date.now() < end && shown().some((i) => !i.complete))
          await new Promise((r) => setTimeout(r, 25));
        await Promise.all(
          shown()
            .filter((i) => i.complete && i.naturalWidth > 0)
            .map((i) => i.decode().catch(() => {})),
        );
      },
      Math.max(0, Math.min(DECODE_MS, deadline - Date.now())),
    )
    .catch(() => {});
}

/** A page settled: the root rendered, nothing aria-busy, its pictures loaded, the fonts ready. */
async function settle(page: Page, inflight: ReadonlySet<Request>): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const root = document.getElementById("root");
        return !!root && root.children.length > 0 && !document.querySelector("[aria-busy=true]");
      },
      undefined,
      { timeout: SETTLE_MS },
    )
    .catch(() => {});
  await loadImages(page, inflight, true);
  await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => {});
  // Layout after the fonts and images, and the shifts of effects that run after the first paint (CLS).
  await page
    .evaluate(
      (quiet) =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, quiet))),
        ),
      QUIET_MS,
    )
    .catch(() => {});
}

/** A PNG screenshot downscaled to `maxWidth` and cut to `maxHeight` as JPEG, on a canvas of the browser. */
async function shrink(
  blank: Page,
  png: Buffer,
  maxWidth: number,
  maxHeight: number,
): Promise<{ data: string; width: number; height: number }> {
  return blank.evaluate(
    async ({ b64, maxWidth, maxHeight, quality }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const scale = Math.min(1, maxWidth / bmp.width);
      const width = Math.round(bmp.width * scale);
      const height = Math.min(maxHeight, Math.round(bmp.height * scale));
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      const g = c.getContext("2d") as CanvasRenderingContext2D;
      g.imageSmoothingQuality = "high";
      g.fillStyle = "#fff";
      g.fillRect(0, 0, width, height);
      g.drawImage(bmp, 0, 0, Math.round(bmp.width * scale), Math.round(bmp.height * scale));
      const url = c.toDataURL("image/jpeg", quality);
      return { data: url.slice(url.indexOf(",") + 1), width, height };
    },
    { b64: png.toString("base64"), maxWidth, maxHeight, quality: JPEG_QUALITY },
  );
}

const RU_SCHEME = { light: "светлая тема", dark: "тёмная тема" } as const;

/** The inspector of the critic in a slot of the process Chromium. */
export function criticInspector(o: CriticInspectorOptions): CriticInspector {
  return async (input): Promise<CriticInspection> => {
    const started = Date.now();
    const built = await buildSystem({ spec: input.spec, files: input.files, env: "prod" });
    if (!built.ok)
      return {
        ok: false,
        error: built.errors
          .map((e) => e.message_ru)
          .join("; ")
          .slice(0, 300),
        problems: [],
        shots: [],
      };
    const role = roleSpec(input.spec);
    const spec = JSON.stringify(role);
    // The demo rows before a browser slot is taken (the source may read the database).
    const rows = o.data
      ? await Promise.resolve()
          .then(() => o.data?.(input.spec) ?? null)
          .catch((e: unknown) => {
            o.log?.("critic_data_failed", { error: String((e as Error)?.message ?? e).slice(0, 160) });
            return null;
          })
      : null;
    const data = rows ? publicDocs(input.spec, role, rows, new Date(started).toISOString()) : new Map();
    const stats: InspectStats = { photos: 0, stubs: 0, rows: 0 };
    const lease = await o.browser.acquire(input.signal);
    if (!lease) return { ok: false, error: "браузер для проверки недоступен", problems: [], shots: [] };
    const problems: DeterministicProblem[] = [];
    const shots: CriticShot[] = [];
    try {
      for (const vp of input.viewports) {
        const wanted = vp.scheme === "light" ? input.shots.filter((s) => s.width === vp.width) : [];
        const hold: Route[] = [];
        const context: BrowserContext = await lease.browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          colorScheme: vp.scheme,
          reducedMotion: "reduce",
          deviceScaleFactor: 1,
          locale: "ru-RU",
          serviceWorkers: "block",
        });
        try {
          await context.addInitScript(CRITIC_INIT_SCRIPT);
          await context.addInitScript(CRITIC_CHECKS_SCRIPT);
          await context.route("**/*", handler(built.client, spec, data, o, hold, stats));
          const blank = wanted.length ? await context.newPage() : null;
          for (const route of input.routes) {
            if (input.signal?.aborted) throw input.signal.reason ?? new Error("aborted");
            const page = await context.newPage();
            const errors: string[] = [];
            page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
            // Image requests of the page in flight (photos, backgrounds): the checks and shots wait for them.
            const inflight = new Set<Request>();
            page.on("request", (r) => {
              if (r.resourceType() === "image") inflight.add(r);
            });
            page.on("requestfinished", (r) => inflight.delete(r));
            page.on("requestfailed", (r) => inflight.delete(r));
            const at = (section: string | null, code: DeterministicProblem["code"], text: string) =>
              problems.push({ code, route, width: vp.width, scheme: vp.scheme, section, message_ru: text });
            try {
              await page.goto(`${CRITIC_ORIGIN}${route}`, { waitUntil: "load", timeout: GOTO_MS });
              await settle(page, inflight);
              const opts: CriticCheckOptions = {
                fonts: [...input.fonts],
                touch: vp.width <= 1024,
                fold: vp.width <= 390 ? vp.height : null,
              };
              const r = (await page.evaluate(
                (x) => (window as unknown as { __wzCritic: { run(o: unknown): unknown } }).__wzCritic.run(x),
                opts,
              )) as CriticCheckResult;
              for (const e of errors.slice(0, 2)) at(null, "RENDER", `ошибка на странице: ${e}`);
              for (const p of r.problems)
                at(p.section, p.code, vp.scheme === "dark" ? `${p.text} (${RU_SCHEME.dark})` : p.text);
              for (const s of wanted.filter((x) => x.route === route))
                shots.push(await shoot(page, blank as Page, s, r, vp.height, inflight));
            } catch (e) {
              if (input.signal?.aborted) throw e;
              at(
                null,
                "RENDER",
                `страница не открылась: ${String((e as Error)?.message ?? e).slice(0, 160)}`,
              );
            } finally {
              await page.close().catch(() => {});
            }
          }
        } finally {
          for (const r of hold) await r.abort().catch(() => {});
          await context.close().catch(() => {});
        }
      }
    } finally {
      lease.release();
    }
    const ms = Date.now() - started;
    o.log?.("critic_inspection", {
      routes: input.routes.length,
      viewports: input.viewports.length,
      ms,
      photosLibrary: stats.photos,
      photosStub: stats.stubs,
      dataRows: stats.rows,
    });
    // Stand-ins in the shots (no photo source, or a photo it does not have): the model judges the place, not the plot.
    return { ok: true, problems, shots, stubPhotos: !o.photo || stats.stubs > 0, ms };
  };
}

/** One screenshot of an open page: the first screen or the whole page, with the sections it shows. */
async function shoot(
  page: Page,
  blank: Page,
  s: CriticShotRequest,
  r: CriticCheckResult,
  viewportHeight: number,
  inflight: ReadonlySet<Request>,
): Promise<CriticShot> {
  await page.evaluate(() => window.scrollTo(0, 0));
  // The checks scroll texts into view: pictures they started finish before the shot.
  await loadImages(page, inflight, false);
  const full = s.kind === "page";
  const scale = Math.min(1, s.maxWidth / s.width);
  const cssHeight = full ? Math.min(r.height, Math.ceil(s.maxHeight / scale)) : viewportHeight;
  const png = await page.screenshot({
    type: "png",
    fullPage: full,
    ...(full ? { clip: { x: 0, y: 0, width: s.width, height: cssHeight } } : {}),
    animations: "disabled",
  });
  const img = await shrink(blank, png, s.maxWidth, s.maxHeight);
  const sections = r.sections
    .filter((x) => x.top < cssHeight)
    .map((x) => (full ? `${x.id} ${x.top}–${x.top + x.height}` : x.id));
  return { ...s, mime: "image/jpeg", data: img.data, px: { width: img.width, height: img.height }, sections };
}

/**
 * V3-40: the critic's photos from the shared file storage — /_wizard/photos/<id>/<w> gets the library's WebP the
 * runtime would serve; the owner's uploads (/api/files/…) stay the platform's stand-ins.
 */
export function criticLibraryPhotos(files: FileStorage): NonNullable<CriticInspectorOptions["photo"]> {
  return async (path) => {
    const m = /^\/_wizard\/photos\/([\w-]+)\/(\d+)$/.exec(path);
    return m ? libraryPhotoFile(files, m[1] as string, Number(m[2])) : null;
  };
}

/**
 * The critic hook of the platform: the inspector in the process Chromium; model calls go through ctx.route (the
 * harness wallet, the run's cap), so the platform's usage journal has them.
 */
export function platformCritic(
  browser: GoalBrowserProvider,
  o: Omit<CriticOptions, "inspect"> & Omit<CriticInspectorOptions, "browser"> = {},
): V3StageHook {
  const { photo, data, log, ...rest } = o;
  return createCriticHook({
    ...rest,
    inspect: criticInspector({
      browser,
      ...(photo ? { photo } : {}),
      ...(data ? { data } : {}),
      ...(log ? { log } : {}),
    }),
  });
}
