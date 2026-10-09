// Template gate of the v3 build (V3-14; specs/agents/builder-v3.md §3 C6 stage template_gate, product.yaml D77_v3 (6)):
// the public site of the draft is fingerprinted without a model — the composer's site model (ui/site.json), the DOM
// shapes of its sections and the perceptual hashes of screenshots at 390 and 1440 px in a slot of the process Chromium
// (B2-28) — and compared with the memory of recent sites: the latest fingerprint of every other system of the same
// niche and of the same organisation (platform.system_site_fingerprints, migration 0038). At or above the threshold of
// @wizard/gates templateVerdict the hook returns redesign {avoid}. The harness calls it right after the skeleton (a hit
// there: the art director again without those archetypes, the skeleton recomposed, the check once more), and on the
// finished site after the scenarios (only a note). Each call stores the system's latest fingerprint, so the memory
// ends with the final site and archetype. A second hit in the run, or a direction the owner pinned, is a note.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Browser, Page, Route } from "@playwright/test";
import {
  readSite,
  type SiteModel,
  type V3BuildContext,
  type V3HookResult,
  type V3StageHook,
} from "@wizard/agents/builder";
import type { AppSpec } from "@wizard/appspec";
import { buildSystem } from "@wizard/build";
import {
  DOM_SKETCH_SCRIPT,
  dHash,
  FULL_PAGE_MAX_HEIGHT,
  type ImageHashes,
  type PageView,
  type PatternLookup,
  pHash,
  type RgbaImage,
  type SectionShape,
  type SiteFingerprint,
  siteStructure,
  TEMPLATE_VIEWPORTS,
  type TemplateMemoryItem,
  type TemplateViewportId,
  templateVerdict,
} from "@wizard/gates";
import { fontFiles } from "@wizard/ui-kit/fonts";
import { toRoleSpec } from "@wizard/ui-kit/role-spec";
import { patternById } from "@wizard/ui-kit/v3/patterns";
import { PNG } from "pngjs";
import type postgres from "postgres";
import type { GoalBrowserProvider } from "../agents/goal-browser.js";

/** Origin the draft is served at inside the browser context (every request is answered in-process, no network). */
export const TEMPLATE_ORIGIN = "http://site.template-gate.invalid";
/** Pages rendered per site (home first, in the site's order); the rest are compared by structure. */
export const TEMPLATE_MAX_PAGES = 4;
/** Wall clock of one capture (both viewports), ms: past it the remaining pages keep their structure only. */
export const TEMPLATE_CAPTURE_MS = 60_000;
/** One page load and settle, ms. */
const PAGE_TIMEOUT_MS = 15_000;
/** Memory of the gate: latest fingerprints of other systems of the niche and of the same organisation. */
export const TEMPLATE_MEMORY_LIMITS = { niche: 20, org: 10 } as const;

/** Layout family and variant of a library pattern (the structural tokens of the site model). */
export const patternLookup: PatternLookup = (id) => {
  const p = patternById(id);
  return p ? { sectionType: p.sectionType, layout: p.layout, variant: p.variant } : undefined;
};

/** A screenshot PNG as an RGBA raster. */
export function decodePng(png: Uint8Array): RgbaImage {
  const img = PNG.sync.read(Buffer.from(png.buffer, png.byteOffset, png.byteLength));
  return { width: img.width, height: img.height, data: img.data };
}

const hashes = (png: Uint8Array): ImageHashes => {
  const img = decodePng(png);
  return { p: pHash(img), d: dHash(img) };
};

/**
 * Waits until the page has rendered: the app root has content, fonts and images are loaded (lazy ones made eager), no
 * section reports aria-busy (the data of the headless hooks), then two animation frames.
 */
export async function settlePage(page: Page, timeoutMs = PAGE_TIMEOUT_MS): Promise<void> {
  await page.waitForFunction(
    "!!document.getElementById('main') || (document.getElementById('root')?.children.length ?? 0) > 0",
    undefined,
    { timeout: timeoutMs },
  );
  await page.evaluate(`(async () => {
    const wait = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
    await wait(document.fonts.ready, 5000);
    await wait(Promise.all(Array.from(document.images).map((i) => {
      i.loading = "eager";
      return i.complete ? null : new Promise((r) => { i.addEventListener("load", r); i.addEventListener("error", r); });
    })), 5000);
    const t0 = Date.now();
    while (document.querySelector("[aria-busy=true]") && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);
}

/**
 * One rendered page at its viewport: the section shapes (DOM_SKETCH_SCRIPT), the hashes of the first screen and of
 * the full page (cut at FULL_PAGE_MAX_HEIGHT). Animations are stopped at their end state.
 */
export async function capturePage(page: Page): Promise<PageView> {
  const shapes = (await page.evaluate(DOM_SKETCH_SCRIPT)) as SectionShape[];
  const first = await page.screenshot({ type: "png", animations: "disabled" });
  const width = page.viewportSize()?.width ?? 1440;
  const scroll = Number(await page.evaluate("document.documentElement.scrollHeight")) || 1;
  const full = await page.screenshot({
    type: "png",
    fullPage: true,
    animations: "disabled",
    clip: { x: 0, y: 0, width, height: Math.max(1, Math.min(FULL_PAGE_MAX_HEIGHT, scroll)) },
  });
  return { shapes, first: hashes(first), full: hashes(full) };
}

/** A neutral photo for every image of the draft: the gate compares compositions, not the photos of the client. */
const PHOTO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067" viewBox="0 0 1600 1067"><rect width="1600" height="1067" fill="#8c8c8c"/></svg>';

/** packages/ui-kit/fonts, like the runtime's /_wizard/fonts (the design system's fonts shape the screenshots). */
const FONTS_DIR = join(
  dirname(createRequire(import.meta.url).resolve("@wizard/ui-kit/fonts")),
  "../../fonts",
);
const FONT_NAMES = new Set(fontFiles());
const fontCache = new Map<string, Uint8Array>();

async function font(file: string): Promise<Uint8Array | null> {
  if (!FONT_NAMES.has(file)) return null;
  const hit = fontCache.get(file);
  if (hit) return hit;
  try {
    const data = new Uint8Array(await readFile(join(FONTS_DIR, file)));
    fontCache.set(file, data);
    return data;
  } catch {
    return null;
  }
}

const TYPES: Readonly<Record<string, string>> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
  woff2: "font/woff2",
  html: "text/html; charset=utf-8",
};

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/**
 * Answers one request of the draft in the browser context: the built client files (history routes → index.html),
 * /_wizard/spec as the public role, theme fonts, a neutral photo for every image, an empty data API (lists empty, no
 * signed-in user, no live events). Anything else — another origin included — is refused: no network.
 */
async function serve(route: Route, client: ReadonlyMap<string, Uint8Array>, roleSpec: string): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin !== TEMPLATE_ORIGIN) return route.abort();
  const path = decodeURIComponent(url.pathname);
  if (path === "/_wizard/spec")
    return route.fulfill({ status: 200, contentType: "application/json", body: roleSpec });
  const fontName = /^\/_wizard\/fonts\/([\w.-]+\.woff2)$/.exec(path)?.[1];
  if (fontName) {
    const data = await font(fontName);
    return data
      ? route.fulfill({ status: 200, contentType: "font/woff2", body: Buffer.from(data) })
      : route.fulfill({ status: 404, body: "" });
  }
  if (/^\/_wizard\/photos\//.test(path) || /^\/api\/files\/[\w.-]+\/img\//.test(path))
    return route.fulfill({ status: 200, contentType: "image/svg+xml", body: PHOTO_SVG });
  if (path === "/api/events") return route.fulfill({ status: 204, body: "" });
  if (path === "/api/auth/me") return json(route, 200, { user: null });
  if (/^\/api\/data\/\w+$/.test(path) && route.request().method() === "GET")
    return json(route, 200, { items: [], total: 0, page: 1, limit: 20, hasMore: false });
  if (/^\/api\/fn\/\w+$/.test(path))
    return json(route, 200, { result: /slots/i.test(path) ? [] : null, deps: [] });
  if (path.startsWith("/api/") || path.startsWith("/_wizard/"))
    return json(route, 404, { error: { code: "NOT_FOUND", message: "Не найдено" } });
  const file = client.get(path.slice(1));
  if (file) {
    const ext = path.split(".").pop() ?? "";
    return route.fulfill({
      status: 200,
      contentType: TYPES[ext] ?? "application/octet-stream",
      body: Buffer.from(file),
    });
  }
  return route.fulfill({
    status: 200,
    contentType: TYPES.html,
    body: Buffer.from(client.get("index.html") ?? new Uint8Array()),
  });
}

export interface CaptureOptions {
  maxPages?: number;
  deadlineMs?: number;
  pageTimeoutMs?: number;
  now?: () => number;
  log?: (msg: string, err: unknown) => void;
}

/**
 * The fingerprint of the draft's public site: the structure of the site model for every page, and for the first
 * TEMPLATE_MAX_PAGES pages a public role can open — the views at 390 and 1440 px (light scheme, reduced motion). The
 * draft is built in memory (buildSystem, env prod) and served inside the browser context. A page that does not render
 * in time keeps its structure only; a build error leaves the whole site structure-only.
 */
export async function captureSite(
  browser: Browser,
  input: { spec: AppSpec; files: ReadonlyMap<string, string>; site: SiteModel },
  o: CaptureOptions = {},
): Promise<SiteFingerprint> {
  const now = o.now ?? Date.now;
  const deadline = now() + (o.deadlineMs ?? TEMPLATE_CAPTURE_MS);
  const structure = siteStructure(input.site, patternLookup);
  const built = await buildSystem({ spec: input.spec, files: input.files, env: "prod" });
  if (!built.ok) {
    o.log?.("template gate build failed", built.errors.map((e) => e.message_ru).join("; "));
    return structure;
  }
  const publicRoles = new Set(input.spec.roles.filter((r) => r.access === "public").map((r) => r.name));
  const routes = input.site.pages
    .filter((p) => !p.route.includes(":") && (!p.roles.length || p.roles.some((r) => publicRoles.has(r))))
    .slice(0, o.maxPages ?? TEMPLATE_MAX_PAGES)
    .map((p) => p.route);
  const roleSpec = JSON.stringify(
    toRoleSpec(input.spec, null, { policyVersion: "1", consentTextHash: "template-gate" }),
  );
  const views = new Map<string, Partial<Record<TemplateViewportId, PageView>>>();
  for (const vp of TEMPLATE_VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
      locale: "ru-RU",
      serviceWorkers: "block",
    });
    try {
      await context.route("**/*", (r) => serve(r, built.client, roleSpec));
      for (const route of routes) {
        if (now() >= deadline) break;
        const page = await context.newPage();
        try {
          const timeout = Math.max(1000, Math.min(o.pageTimeoutMs ?? PAGE_TIMEOUT_MS, deadline - now()));
          await page.goto(`${TEMPLATE_ORIGIN}${route}`, { waitUntil: "load", timeout });
          await settlePage(page, timeout);
          const v = await capturePage(page);
          views.set(route, { ...views.get(route), [vp.id]: v });
        } catch (e) {
          o.log?.("template gate page failed", e);
        } finally {
          await page.close().catch(() => undefined);
        }
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  }
  return {
    version: 1,
    pages: structure.pages.map((p) => {
      const v = views.get(p.route);
      return v ? { ...p, views: v } : p;
    }),
  };
}

/**
 * Memory of the gate: the latest fingerprint of every other live system of the same niche (up to `niche`) and of the
 * same organisation in any niche (up to `org`), newest first, each system once.
 */
export async function templateMemory(
  pg: postgres.Sql,
  systemId: string,
  niche: string,
  limits: { niche: number; org: number } = TEMPLATE_MEMORY_LIMITS,
): Promise<TemplateMemoryItem[]> {
  const rows = await pg<{ system_id: string; archetype: string; fingerprint: SiteFingerprint }[]>`
    (select f.system_id, f.archetype, f.fingerprint, f.updated_at
       from platform.system_site_fingerprints f
       join platform.systems s on s.id = f.system_id
      where f.niche = ${niche} and f.system_id <> ${systemId} and s.deleted_at is null
      order by f.updated_at desc
      limit ${limits.niche})
    union all
    (select f.system_id, f.archetype, f.fingerprint, f.updated_at
       from platform.system_site_fingerprints f
       join platform.systems s on s.id = f.system_id
       join platform.systems me on me.id = ${systemId} and me.org_id = s.org_id
      where f.system_id <> ${systemId} and s.deleted_at is null
      order by f.updated_at desc
      limit ${limits.org})`;
  const seen = new Set<string>();
  const out: TemplateMemoryItem[] = [];
  for (const r of rows) {
    if (seen.has(r.system_id)) continue;
    seen.add(r.system_id);
    out.push({ id: r.system_id, archetype: r.archetype, fingerprint: r.fingerprint });
  }
  return out;
}

/** Stores the latest fingerprint of a system (one row per system; a rebuild replaces it). */
export async function saveTemplateFingerprint(
  pg: postgres.Sql,
  r: {
    systemId: string;
    runId: string | null;
    niche: string;
    archetype: string;
    fingerprint: SiteFingerprint;
    /** Similarity to the nearest recent site, 0…1 (null — empty memory). */
    similarity: number | null;
  },
): Promise<void> {
  const similarity =
    r.similarity === null ? null : Math.round(Math.min(1, Math.max(0, r.similarity)) * 1000) / 1000;
  await pg`
    insert into platform.system_site_fingerprints (system_id, niche, archetype, fingerprint, similarity, run_id)
    values (${r.systemId}, ${r.niche}, ${r.archetype},
            ${pg.json(r.fingerprint as unknown as postgres.JSONValue)}, ${similarity}, ${r.runId})
    on conflict (system_id) do update
      set niche = excluded.niche, archetype = excluded.archetype, fingerprint = excluded.fingerprint,
          similarity = excluded.similarity, run_id = excluded.run_id, updated_at = now()`;
}

/** Fingerprint of the current site for the gate (the browser capture, or the structure in tests and without one). */
export type TemplateCapture = (ctx: V3BuildContext, site: SiteModel) => Promise<SiteFingerprint>;

/** Structure only: the site model without a browser. */
export const structureCapture: TemplateCapture = async (_ctx, site) => siteStructure(site, patternLookup);

/** Capture in a slot of the process browser (B2-28); no slot — structure only. */
export function browserCapture(
  provider: GoalBrowserProvider,
  o: { signal?: AbortSignal; log?: (msg: string, err: unknown) => void } = {},
): TemplateCapture {
  return async (ctx, site) => {
    const lease = await provider.acquire(o.signal);
    if (!lease) return siteStructure(site, patternLookup);
    try {
      return await captureSite(
        lease.browser as Browser,
        { spec: ctx.spec, files: ctx.files, site },
        o.log ? { log: o.log } : {},
      );
    } finally {
      lease.release();
    }
  };
}

export interface TemplateGateOptions {
  pg: postgres.Sql;
  /** The build run (the row's run_id); null in tests without a run. */
  runId: string | null;
  capture: TemplateCapture;
  threshold?: number;
  structureThreshold?: number;
  limits?: { niche: number; org: number };
  log?: (msg: string, err: unknown) => void;
}

/** At most this many archetypes go to the art director to avoid (pickArchetype remembers NICHE_MEMORY = 4). */
const AVOID_MAX = 3;

/**
 * The template_gate hook of the harness v3. The fingerprint of the current site is compared with the memory and
 * stored as the system's latest; over the threshold → redesign {avoid: the current archetype first, then those of the
 * near-duplicates}. No redesign when the owner pinned the direction (brief.design.pinned) or after one redesign in
 * this run (the hook keeps that in its closure: one hook per build run, called after the skeleton, again after a
 * redesign and after the scenarios) — a Russian note instead. The system is ctx.systemId; its own earlier
 * fingerprint is never in its memory.
 */
export function templateGateHook(o: TemplateGateOptions): V3StageHook {
  let redesigned = false;
  return async (ctx): Promise<V3HookResult> => {
    const site = readSite(ctx.files);
    if (!site?.pages.length) return { status: "skipped", note: "у системы нет публичного сайта" };
    let fingerprint: SiteFingerprint;
    try {
      fingerprint = await o.capture(ctx, site);
    } catch (e) {
      // The browser broke down: the structure still tells a template.
      o.log?.("template gate capture failed", e);
      fingerprint = siteStructure(site, patternLookup);
    }
    const niche = ctx.design.niche;
    const memory = await templateMemory(o.pg, ctx.systemId, niche, o.limits);
    const verdict = templateVerdict(fingerprint, memory, {
      ...(o.threshold !== undefined ? { threshold: o.threshold } : {}),
      ...(o.structureThreshold !== undefined ? { structureThreshold: o.structureThreshold } : {}),
    });
    await saveTemplateFingerprint(o.pg, {
      systemId: ctx.systemId,
      runId: o.runId,
      niche,
      archetype: ctx.design.archetype,
      fingerprint,
      similarity: verdict.nearest?.score ?? null,
    });
    const pct = Math.round((verdict.nearest?.score ?? 0) * 100);
    const mode = verdict.nearest?.mode === "structure" ? ", только структура" : "";
    if (!verdict.over)
      return {
        status: "done",
        note: memory.length ? `сходство с недавними сайтами ${pct} %${mode}` : "память ниши пуста",
      };
    if (ctx.brief.design.pinned)
      return {
        status: "done",
        notes: [
          `Сайт похож на недавний сайт в этой нише (сходство ${pct} %), но стиль вы выбрали сами — оставляю его.`,
        ],
        note: `шаблонность ${pct} %${mode}: стиль выбран владельцем`,
      };
    if (redesigned)
      return {
        status: "done",
        notes: [
          `После смены стиля сайт всё ещё похож на недавний сайт в этой нише (сходство ${pct} %) — его можно сделать своеобразнее правками.`,
        ],
        note: `шаблонность ${pct} %${mode} после смены стиля`,
      };
    redesigned = true;
    const avoid = [...new Set([ctx.design.archetype, ...verdict.matches.map((m) => m.archetype)])].slice(
      0,
      AVOID_MAX,
    );
    return { status: "done", redesign: { avoid }, note: `шаблонность ${pct} %${mode}: другой стиль` };
  };
}

/**
 * The template gate of a platform v3 build (builds-v3/host.ts): only with the process browser — a host without one
 * leaves the stage skipped, as before V3-14.
 */
export function templateGateHooks(o: {
  pg: postgres.Sql;
  runId: string;
  browser: GoalBrowserProvider | null;
  signal?: AbortSignal;
  log?: (msg: string, err: unknown) => void;
}): { template_gate?: V3StageHook } {
  if (!o.browser) return {};
  const capture = browserCapture(o.browser, {
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.log ? { log: o.log } : {}),
  });
  return {
    template_gate: templateGateHook({
      pg: o.pg,
      runId: o.runId,
      capture,
      ...(o.log ? { log: o.log } : {}),
    }),
  };
}
