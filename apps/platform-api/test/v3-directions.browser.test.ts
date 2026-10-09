// V3-09 acceptance in chromium: the three first screens of a proposal render as the platform shows them — each in
// <iframe srcdoc sandbox="allow-scripts"> on a page under the production platform CSP (platform-web src/csp.ts:
// default-src 'self'; script-src 'self'; frame-src of the system hosts only), the files served by platform-api through
// the same origin (/api like the platform's proxy). At 390 and 1280 px: the header and the hero with the client's
// texts, the design system's fonts loaded, no horizontal overflow, no console errors or CSP refusals.
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import { type Browser, chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { createTestDb, startApi, type TestApi } from "./helpers.js";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync("/opt/pw-browsers"))
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";
const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

/** platformCsp({frameSrc, dev: false}) of apps/platform-web/src/csp.ts — the production policy the srcdoc inherits. */
const PLATFORM_CSP =
  "default-src 'self'; script-src 'self'; frame-src http://*.localhost:4100; object-src 'none'; base-uri 'none'";
const SIZES = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;
const SHOTS = mkdtempSync(join(tmpdir(), "wz-directions-"));

interface DirectionView {
  n: number;
  name: string;
  texts: { title: string };
  fonts: { display: string; text: string };
  previewHtml: string;
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let apiServer: ServerType;
let page: Server;
let origin = "";
let browser: Browser;
let directions: DirectionView[] = [];

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

beforeAll(async () => {
  if (!hasChromium) return;
  tdb = await createTestDb("v3dirb");
  api = await startApi(tdb.url);
  apiServer = serve({ fetch: api.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => apiServer.once("listening", r));
  const apiPort = (apiServer.address() as AddressInfo).port;
  const key = "b3d9e0a1c2f4";
  const sys = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: "dir-browser",
      schema_key: key,
      name: "Стоматология «Улыбка»",
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await saveBriefVersion(api.deps.db, { systemId: sys.id, brief: dentalBrief(), author: "agent" });
  const t0 = performance.now();
  const r = await api.req("POST", `/systems/${sys.id}/directions`);
  expect(r.status, r.text).toBe(201);
  console.info(`V3-09 браузер: три превью собраны за ${Math.round(performance.now() - t0)} мс`);
  directions = r.body.proposal.directions;
  const html = [
    "<!doctype html>",
    '<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Три направления</title></head><body>",
    ...directions.map(
      (d) =>
        `<iframe data-n="${d.n}" title="${attr(d.name)}" sandbox="allow-scripts" srcdoc="${attr(d.previewHtml)}"></iframe>`,
    ),
    "</body></html>",
  ].join("\n");
  // The platform page: its CSP on every answer, /api proxied to platform-api like the platform's own proxy.
  page = createServer(async (req, res) => {
    const path = req.url ?? "/";
    if (path.startsWith("/api/")) {
      const upstream = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
        headers: Object.fromEntries(
          Object.entries(req.headers).filter(([k]) => ["origin", "accept"].includes(k)) as [string, string][],
        ),
      });
      const headers: Record<string, string> = {};
      for (const h of [
        "content-type",
        "access-control-allow-origin",
        "cache-control",
        "content-security-policy",
      ]) {
        const v = upstream.headers.get(h);
        if (v) headers[h] = v;
      }
      res.writeHead(upstream.status, headers);
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    res.writeHead(path === "/" ? 200 : 404, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": PLATFORM_CSP,
    });
    res.end(path === "/" ? html : "");
  });
  await new Promise<void>((r) => page.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(page.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => (page ? page.close(r) : r(null)));
  await new Promise((r) => (apiServer ? apiServer.close(r) : r(null)));
  await api?.dispose();
  await tdb?.drop();
});

describe.skipIf(!hasChromium)("three live first screens in sandboxed srcdoc frames", () => {
  for (const vp of SIZES) {
    test(`${vp.width} px: header and hero with the client's texts, fonts, no overflow, no errors`, async () => {
      const ctx = await browser.newContext({ viewport: vp, locale: "ru-RU", reducedMotion: "reduce" });
      const p = await ctx.newPage();
      const errors: string[] = [];
      p.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(origin);
      // The frames take the page width (CSSOM: the platform CSP has no inline styles); the height shows the screen.
      await p.evaluate(() => {
        document.body.style.margin = "0";
        for (const f of document.querySelectorAll("iframe"))
          f.style.cssText = "display:block;width:100%;height:900px;border:0";
      });
      const frames = await Promise.all(
        directions.map(async (d) => {
          const handle = await p.waitForSelector(`iframe[data-n="${d.n}"]`);
          const frame = await handle.contentFrame();
          if (!frame) throw new Error(`no frame ${d.n}`);
          await frame.waitForSelector(`[data-direction="${d.n}"] h1`, { timeout: 30_000 });
          return { d, frame, handle };
        }),
      );
      for (const { d, frame, handle } of frames) {
        const r = await frame.evaluate(async (display) => {
          await document.fonts.ready;
          const root = document.documentElement;
          return {
            title: document.querySelector("h1")?.textContent ?? "",
            header: !!document.querySelector("header, nav"),
            action: [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "#form"),
            overflow: root.scrollWidth - root.clientWidth,
            fonts: [...document.fonts]
              .filter((f) => f.status === "loaded")
              .map((f) => f.family.replace(/"/g, "")),
            display,
            width: window.innerWidth,
          };
        }, d.fonts.display);
        expect(r.title).toBe(d.texts.title);
        expect(r.header).toBe(true);
        expect(r.action).toBe(true);
        expect(r.overflow, `${d.n} overflow at ${vp.width}`).toBeLessThanOrEqual(1);
        expect(r.fonts, `${d.n}: ${d.fonts.display}`).toContain(d.fonts.display);
        expect(r.width).toBe(vp.width);
        await handle.screenshot({ path: join(SHOTS, `direction-${d.n}-${vp.width}.png`) });
      }
      // The sandbox keeps the frames away from the platform: no access to the parent document.
      const isolated = await frames[0]?.frame.evaluate(() => {
        try {
          return window.parent.document === undefined;
        } catch {
          return true;
        }
      });
      expect(isolated).toBe(true);
      expect(errors, errors.join("\n")).toEqual([]);
      await ctx.close();
    }, 90_000);
  }
});
