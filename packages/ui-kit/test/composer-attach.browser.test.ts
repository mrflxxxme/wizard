// V3-04 acceptance in chromium: «Приложить ТЗ» in the Composer at 390 and 1280 px, light and dark — the paperclip in the
// row (a 44 px target on the phone), the upload state with a long file name, the client-side refusal and the server's
// error under the row; WCAG AA contrast, labels, no horizontal scroll; the Composer without `attach` has no paperclip.
// The page is generated here (test/.generated, not committed) so the shared demo stays as it is.
import { mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { build, type PreviewServer, preview } from "vite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { A11Y_SCRIPT, type A11yApi } from "./a11y/checks.js";
import { ARTIFACTS, hasChromium, UI_KIT_ROOT } from "./helpers/demo.js";

const ROOT = join(UI_KIT_ROOT, "test/.generated/composer-attach");
const OUT = join(ROOT, "dist");

const HTML = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Приложить ТЗ — проверка</title>
  </head>
  <body style="margin:0">
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
`;

// The page: a start-size Composer with «Приложить ТЗ» whose upload waits for window.__upload, and a plain one.
const MAIN = `import "../../../src/v2/theme.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer, ThemeRoot } from "../../../src/v2/index.ts";

const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
type Pending = { name: string; resolve(): void; reject(message: string): void };
const w = window as unknown as { __upload?: Pending; __wz: { ready: boolean } };

function onFile(file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    w.__upload = { name: file.name, resolve, reject: (m) => reject(new Error(m)) };
  });
}

function Page() {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  return (
    <ThemeRoot theme={theme} motion={false}>
      <main style={{ minHeight: "100vh", maxWidth: 720, margin: "0 auto", padding: "32px 16px", display: "grid", alignContent: "start", gap: 32 }}>
        <h1 style={{ margin: 0, font: "600 22px/1.3 var(--p-f-ui)" }}>Расскажите о своём деле или приложите ТЗ</h1>
        <Composer testId="with-attach" size="start" value={a} onChange={setA} onSubmit={() => setA("")} attach={{ onFile }} />
        <Composer testId="plain" value={b} onChange={setB} onSubmit={() => setB("")} />
      </main>
    </ThemeRoot>
  );
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<StrictMode><Page /></StrictMode>);
w.__wz = { ready: true };
`;

const DOCX = Buffer.from("PK\u0003\u0004 fixture bytes — the page never reads them");
const LONG_NAME =
  "Техническое задание на сайт кофейни Зерно и пар с предзаказом напитков, версия для подрядчика.docx";

async function a11y<K extends keyof A11yApi>(page: Page, check: K) {
  await page.addScriptTag({ content: A11Y_SCRIPT });
  return page.evaluate(
    (c) => (window as unknown as { __a11y: Record<string, () => unknown> }).__a11y[c]?.(),
    check,
  ) as Promise<ReturnType<A11yApi[K]>>;
}

const settle = (page: Page, how: "resolve" | "reject", message = "") =>
  page.evaluate(
    ([h, m]) => {
      const u = (window as unknown as { __upload?: { resolve(): void; reject(m: string): void } }).__upload;
      if (h === "resolve") u?.resolve();
      else u?.reject(m as string);
    },
    [how, message] as const,
  );

describe.skipIf(!hasChromium)("Composer «Приложить ТЗ» in chromium", () => {
  let server: PreviewServer;
  let browser: Browser;
  let base = "";

  beforeAll(async () => {
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(join(ROOT, "index.html"), HTML);
    writeFileSync(join(ROOT, "main.tsx"), MAIN);
    const config = {
      configFile: false as const,
      root: ROOT,
      logLevel: "error" as const,
      esbuild: { jsx: "automatic" as const },
    };
    await build({ ...config, build: { outDir: OUT, emptyOutDir: true } });
    server = await preview({
      ...config,
      build: { outDir: OUT },
      preview: { port: 0, host: "127.0.0.1", strictPort: false },
    });
    base = server.resolvedUrls?.local[0] ?? "";
    browser = await chromium.launch();
    mkdirSync(ARTIFACTS, { recursive: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((r) => (server.httpServer as Server).close(() => r()));
  });

  const SIZES = [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ] as const;
  for (const vp of SIZES)
    for (const scheme of ["light", "dark"] as const)
      test(`${vp.width}px ${scheme}: paperclip, upload state, refusal and server error; contrast, labels, touch, overflow`, async () => {
        const ctx = await browser.newContext({
          viewport: vp,
          colorScheme: scheme,
          locale: "ru-RU",
          reducedMotion: "reduce",
        });
        const page = await ctx.newPage();
        await page.goto(`${base}?theme=${scheme}`);
        await page.waitForFunction(
          () => (window as unknown as { __wz?: { ready: boolean } }).__wz?.ready === true,
        );
        const root = page.getByTestId("with-attach");
        const clip = root.getByTestId("p-composer-attach");
        const shot = (state: string) =>
          page.screenshot({
            path: join(ARTIFACTS, `composer-attach-${vp.width}-${scheme}-${state}.png`),
            fullPage: true,
          });

        // At rest: the paperclip sits in the row before the field; the plain Composer has none.
        await expect.poll(() => clip.getAttribute("aria-label")).toBe("Приложить ТЗ");
        expect(await page.getByTestId("plain").getByTestId("p-composer-attach").count()).toBe(0);
        const [clipBox, inputBox, sendBox] = await Promise.all([
          clip.boundingBox(),
          root.getByTestId("p-composer-input").boundingBox(),
          root.getByTestId("p-composer-send").boundingBox(),
        ]);
        expect(clipBox && inputBox && sendBox).toBeTruthy();
        expect((clipBox?.x ?? 0) + (clipBox?.width ?? 0)).toBeLessThanOrEqual((inputBox?.x ?? 0) + 1);
        expect(
          Math.abs(
            (clipBox?.y ?? 0) + (clipBox?.height ?? 0) / 2 - ((sendBox?.y ?? 0) + (sendBox?.height ?? 0) / 2),
          ),
        ).toBeLessThan(2);
        if (vp.width === 390) expect(clipBox?.width).toBeGreaterThanOrEqual(44);
        await shot("idle");
        expect(await a11y(page, "overflow")).toEqual([]);
        expect(await a11y(page, "labels")).toEqual([]);
        expect(await a11y(page, "contrast")).toEqual([]);
        if (vp.width === 390) expect(await a11y(page, "touch")).toEqual([]);

        // Upload: busy paperclip and «Читаем ТЗ «…»…» on one line even for a long name.
        await root
          .getByTestId("p-composer-file")
          .setInputFiles({ name: LONG_NAME, mimeType: "application/octet-stream", buffer: DOCX });
        const status = root.getByTestId("p-composer-attach-status");
        await expect.poll(() => status.textContent()).toBe(`Читаем ТЗ «${LONG_NAME}»…`);
        expect(await clip.getAttribute("aria-busy")).toBe("true");
        expect(await clip.isDisabled()).toBe(true);
        const statusBox = await status.boundingBox();
        expect(statusBox?.height ?? 0).toBeLessThan(24);
        await shot("uploading");
        expect(await a11y(page, "overflow")).toEqual([]);
        expect(await a11y(page, "contrast")).toEqual([]);
        await settle(page, "resolve");
        await expect.poll(() => status.isVisible()).toBe(false);
        expect(await clip.isDisabled()).toBe(false);

        // Refused before upload (another type), then the server's error — both in Russian under the row.
        await root
          .getByTestId("p-composer-file")
          .setInputFiles({ name: "Клиенты.xlsx", mimeType: "application/octet-stream", buffer: DOCX });
        const error = root.getByTestId("p-composer-attach-error");
        await expect.poll(() => error.textContent()).toBe("Подходят файлы .docx, .pdf, .md и .txt");
        await root
          .getByTestId("p-composer-file")
          .setInputFiles({ name: "tz.pdf", mimeType: "application/pdf", buffer: DOCX });
        await expect.poll(() => status.isVisible()).toBe(true);
        await settle(
          page,
          "reject",
          "В файле нет текста. Похоже, это скан — пришлите ТЗ в .docx или текстом, и мы соберём черновик брифа.",
        );
        await expect.poll(() => error.textContent()).toMatch(/^В файле нет текста/);
        await shot("error");
        expect(await a11y(page, "overflow")).toEqual([]);
        expect(await a11y(page, "contrast")).toEqual([]);
        await ctx.close();
      });
});
