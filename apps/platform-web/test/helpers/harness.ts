// Builds platform-web once (vite), serves it with `vite preview` proxying /api to the mock platform and drives it
// with Playwright chromium. Browser suites are skipped without chromium (architecture.yaml#stack.tests).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContextOptions, chromium, type Page } from "@playwright/test";
import { build, type PreviewServer, preview } from "vite";
import { APP_ROOT, platformViteConfig } from "../../vite.config.js";
import { type Feed, type MockOptions, MockPlatform } from "../mock/server.js";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync("/opt/pw-browsers")) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";
}

export const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const OUT = join(APP_ROOT, "test/.generated/web");
let built: Promise<unknown> | null = null;

function buildOnce(): Promise<unknown> {
  built ??= build({ configFile: false, ...platformViteConfig({ outDir: OUT }), logLevel: "error" });
  return built;
}

export interface Harness {
  mock: MockPlatform;
  origin: string;
  browser: Browser;
  page(opts?: BrowserContextOptions & { path?: string }): Promise<Page>;
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  close(): Promise<void>;
}

export async function startHarness(o: { feed: Feed } & Partial<Omit<MockOptions, "feed">>): Promise<Harness> {
  await buildOnce();
  const mock = await new MockPlatform({ platformOrigin: "", ...o }).start();
  const cfg = platformViteConfig({
    outDir: OUT,
    apiTarget: mock.apiTarget,
    frameSrc: [`http://*.localhost:${mock.port}`],
    port: 0,
    host: "127.0.0.1",
  });
  const server: PreviewServer = await preview({
    configFile: false,
    ...cfg,
    preview: { ...cfg.preview, strictPort: false },
    logLevel: "error",
  });
  const addr = server.httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const origin = `http://localhost:${port}`;
  mock.opts.platformOrigin = origin;
  const browser = await chromium.launch();
  return {
    mock,
    origin,
    browser,
    async page(opts = {}) {
      const { path = "/", ...ctx } = opts;
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: "ru-RU",
        ...ctx,
      });
      const page = await context.newPage();
      await page.goto(`${origin}${path}`);
      return page;
    },
    async api(method, path, body) {
      const res = await fetch(`${mock.apiTarget}/api/v1${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return (await res.json()) as never;
    },
    async close() {
      await browser.close();
      await new Promise<void>((r) => server.httpServer.close(() => r()));
      await mock.close();
    },
  };
}

/** Waits until the mock system reaches `stage`. */
export async function waitStage(
  h: Harness,
  systemId: string,
  stage: string,
  timeoutMs = 20_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (h.mock.systems.get(systemId)?.system.stage === stage) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`stage ${stage} not reached`);
}

/** Creates a system through the API and brings it to the card stage (restByRecommendation). */
export async function toCard(h: Harness, prompt = "Форум на 600 человек"): Promise<string> {
  const { system } = await h.api<{ system: { id: string } }>("POST", "/systems", { prompt });
  const until = Date.now() + 10_000;
  while ((h.mock.systems.get(system.id)?.pendingQuestions.length ?? 0) === 0 && Date.now() < until)
    await new Promise((r) => setTimeout(r, 20));
  await h.api("POST", `/systems/${system.id}/answers`, { answers: [], restByRecommendation: true });
  await waitStage(h, system.id, "card");
  return system.id;
}

export async function toBuilding(h: Harness): Promise<string> {
  const id = await toCard(h);
  const card = h.mock.systems.get(id)?.card;
  await h.api("POST", `/systems/${id}/card/approve`, { cardVersion: card?.cardVersion ?? 1 });
  return id;
}
