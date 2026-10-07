// Builds the demo (vite) into a per-suite directory, serves it and drives it with Playwright chromium.
// Browser suites are skipped when chromium is not installed (PLAYWRIGHT_BROWSERS_PATH, architecture.yaml#stack.tests).
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContextOptions, chromium, type Page } from "@playwright/test";
import { build, type PreviewServer, preview } from "vite";

export const UI_KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO = join(UI_KIT_ROOT, "demo");
export const ARTIFACTS = join(UI_KIT_ROOT, "test/artifacts");

export const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

export type DemoHarness = {
  url(query?: string, path?: string): string;
  browser: Browser;
  /** `path` — another page of the demo build (e.g. "v2/" for the design system v2). */
  page(opts?: BrowserContextOptions & { query?: string; path?: string }): Promise<Page>;
  launch(args: string[]): Promise<Browser>;
  close(): Promise<void>;
};

export async function startDemo(name: string): Promise<DemoHarness> {
  const outDir = join(UI_KIT_ROOT, "test/.generated", `demo-${name}`);
  await build({
    configFile: join(DEMO, "vite.config.ts"),
    root: DEMO,
    logLevel: "error",
    build: { outDir, emptyOutDir: true },
  });
  const server: PreviewServer = await preview({
    configFile: join(DEMO, "vite.config.ts"),
    root: DEMO,
    logLevel: "error",
    build: { outDir },
    preview: { port: 0, host: "127.0.0.1", strictPort: false },
  });
  const addr = server.resolvedUrls?.local[0] ?? "";
  const browser = await chromium.launch();
  const extra: Browser[] = [];
  const url = (query = "", path = "") => `${addr}${path}${query ? `?${query.replace(/^\?/, "")}` : ""}`;
  mkdirSync(ARTIFACTS, { recursive: true });
  return {
    url,
    browser,
    async page(opts = {}) {
      const { query, path, ...ctxOpts } = opts;
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: "ru-RU",
        ...ctxOpts,
      });
      const page = await ctx.newPage();
      await page.goto(url(query, path));
      await page.waitForFunction(
        () => (window as unknown as { __wz?: { ready: boolean } }).__wz?.ready === true,
      );
      return page;
    },
    async launch(args) {
      const b = await chromium.launch({ args });
      extra.push(b);
      return b;
    },
    async close() {
      for (const b of extra) await b.close();
      await browser.close();
      await new Promise<void>((r) => server.httpServer.close(() => r()));
    },
  };
}

/** Component names of ui-kit.yaml#components (milestone M0), read from the spec text. */
export function specComponents(yaml: string, milestone = "M0"): string[] {
  return [...yaml.matchAll(/- name: (\w+)\n\s+milestone: (M\d)/g)]
    .filter((m) => m[2] === milestone)
    .map((m) => m[1] as string);
}
