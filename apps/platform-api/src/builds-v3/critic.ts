// The visual critic of a v3 build in the platform (V3-13): the CriticInspector of @wizard/agents over a slot of the
// process Chromium (agents/goal-browser.ts, B2-28). The system's files with the critic's changes are built by
// buildSystem (prod) and opened without a port or network: every request of the page is answered here — the bundle,
// /_wizard/spec (RoleSpec of the public role), /_wizard/fonts (ui-kit fonts), photos (stand-ins of the platform), the
// data API without records (sections bound to data render their empty state). Each page at each viewport (390/768/1440
// light, 390 dark; reduced motion — content visible at rest, catalog M05) runs the in-page checks; screenshots are
// downscaled to JPEG on a canvas of the same browser. The default hook createCriticHook({inspect}) is wired by host.ts.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { BrowserContext, Page, Route } from "@playwright/test";
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
import { buildRoleSpec, type FileStorage, libraryPhotoFile } from "@wizard/runtime";
import type { GoalBrowserProvider } from "../agents/goal-browser.js";

/** Origin the pages open at: *.localhost is a secure context (crypto.randomUUID of the SDK), no request leaves. */
export const CRITIC_ORIGIN = "http://critic.localhost";
/** A page settles: its data requests answered, the fonts ready (ms cap). */
const SETTLE_MS = 5_000;
/** A page load (ms cap). */
const GOTO_MS = 20_000;
/** Quiet time after the fonts and two frames, ms. */
const QUIET_MS = 150;
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
function roleSpec(spec: AppSpec): string {
  const role = spec.roles.find((r) => r.access === "public")?.name ?? null;
  return JSON.stringify(
    buildRoleSpec(spec, {
      role,
      compliance: {
        consentText: spec.compliance?.consentText ?? null,
        policyPage: spec.compliance?.policyPage ?? null,
        policyVersion: "critic",
        consentTextHash: "critic",
      },
      features: { phoneOtp: false },
      env: "prod",
    }),
  );
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
  log?: (msg: string, fields?: Record<string, string | number>) => void;
}

/** Answers every request of a page opened at CRITIC_ORIGIN (no network). */
function handler(
  client: ReadonlyMap<string, Uint8Array>,
  spec: string,
  o: CriticInspectorOptions,
  hold: Route[],
) {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const photo = async (route: Route, path: string, name: string) => {
    const own = await Promise.resolve(o.photo?.(path)).catch(() => null);
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
    if (/^\/api\/data\/\w+$/.test(path))
      return req.method() === "GET"
        ? json(route, { items: [], total: 0, page: 1, limit: 20, hasMore: false })
        : json(route, { error: { code: "FORBIDDEN", message: "Только просмотр" } }, 403);
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

/** A page settled: the root rendered, nothing aria-busy, the fonts ready. */
async function settle(page: Page): Promise<void> {
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
    const lease = await o.browser.acquire(input.signal);
    if (!lease) return { ok: false, error: "браузер для проверки недоступен", problems: [], shots: [] };
    const spec = roleSpec(input.spec);
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
          await context.route("**/*", handler(built.client, spec, o, hold));
          const blank = wanted.length ? await context.newPage() : null;
          for (const route of input.routes) {
            if (input.signal?.aborted) throw input.signal.reason ?? new Error("aborted");
            const page = await context.newPage();
            const errors: string[] = [];
            page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
            const at = (section: string | null, code: DeterministicProblem["code"], text: string) =>
              problems.push({ code, route, width: vp.width, scheme: vp.scheme, section, message_ru: text });
            try {
              await page.goto(`${CRITIC_ORIGIN}${route}`, { waitUntil: "load", timeout: GOTO_MS });
              await settle(page);
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
                shots.push(await shoot(page, blank as Page, s, r, vp.height));
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
    o.log?.("critic_inspection", { routes: input.routes.length, viewports: input.viewports.length, ms });
    return { ok: true, problems, shots, stubPhotos: !o.photo, ms };
  };
}

/** One screenshot of an open page: the first screen or the whole page, with the sections it shows. */
async function shoot(
  page: Page,
  blank: Page,
  s: CriticShotRequest,
  r: CriticCheckResult,
  viewportHeight: number,
): Promise<CriticShot> {
  await page.evaluate(() => window.scrollTo(0, 0));
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
  const { photo, log, ...rest } = o;
  return createCriticHook({
    ...rest,
    inspect: criticInspector({ browser, ...(photo ? { photo } : {}), ...(log ? { log } : {}) }),
  });
}
