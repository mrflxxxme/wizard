// M2-14 Playwright scenario (ui-kit.yaml#components.FileField acceptance) on the forum with a file field, built with the
// real ui-kit and served by the runtime over HTTP: the speaker uploads a PDF in RecordForm → it is stored in the record
// and downloads as an attachment; an SVG disguised as PNG → error at the field. The goldens are untouched: the page
// and the field exist only in this test's build.
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { type Browser, chromium } from "@playwright/test";
import type { AppSpec, Entity } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MemoryFileStorage } from "../src/index.js";
import { forumSpec } from "./helpers.js";
import { type PreviewFixture, previewFixture } from "./preview-helpers.js";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync("/opt/pw-browsers")) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";
}
const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const PAGE = `import { AppShell, RecordForm } from "@wizard/ui-kit";

export default function Slides() {
  return (
    <AppShell title="Заявка с презентацией">
      <RecordForm entity="speaker_application" fields={["full_name", "email", "topic", "abstract", "slides"]} />
    </AppShell>
  );
}
`;

function filesSpec(): AppSpec {
  const spec = forumSpec();
  const app = spec.entities.find((e) => e.name === "speaker_application") as Entity;
  app.fields.push({ name: "slides", label: "Презентация", type: "file" });
  spec.pages?.push({ route: "/slides", title: "Презентация", file: "ui/Slides.tsx", roles: ["speaker"] });
  return spec;
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const storage = new MemoryFileStorage();
let fx: PreviewFixture;
let server: ReturnType<typeof serve>;
let browser: Browser;
let origin = "";
let schema = "";

describe.skipIf(!hasChromium)("FileField in RecordForm (runtime, Chromium)", () => {
  beforeAll(async () => {
    fx = await previewFixture({}, { files: storage });
    const entry = await fx.publish({
      slug: "filespw",
      env: "draft",
      revision: 1,
      migrate: true,
      realUiKit: true,
      spec: filesSpec(),
      files: new Map([["ui/Slides.tsx", PAGE]]),
    });
    schema = `app_${entry.systemId}_draft`;
    server = serve({ fetch: (req) => fx.rt.fetch(req), port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((r) => server.once("listening", () => r()));
    origin = `http://filespw--draft.localhost:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await fx?.close();
  });

  test("PDF uploads and is saved in the record; download is an attachment; SVG → error at the field", async () => {
    const ctx = await browser.newContext({ locale: "ru-RU", acceptDownloads: true });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/_wizard/dev-login?role=speaker&next=/slides`);
    const field = page.getByTestId("wz-filefield-slides");
    await expect.poll(() => field.count(), { timeout: 20_000 }).toBe(1);

    // SVG disguised as PNG: the browser type passes, the runtime sniffs the signature → 415 → message at the field.
    await page.getByTestId("wz-filefield-slides-input").setInputFiles({
      name: "photo.png",
      mimeType: "image/png",
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    });
    await expect
      .poll(() => page.getByTestId("wz-filefield-slides-error").textContent(), { timeout: 10_000 })
      .toBe("Такой тип файла загрузить нельзя");
    expect(storage.objects.size).toBe(0);

    await page.getByTestId("wz-filefield-slides-input").setInputFiles({
      name: "Доклад.pdf",
      mimeType: "application/pdf",
      buffer: PDF,
    });
    await expect
      .poll(() => page.getByTestId("wz-filefield-slides-name").textContent(), { timeout: 10_000 })
      .toBe("Доклад.pdf");
    expect(await page.getByTestId("wz-filefield-slides-error").count()).toBe(0);
    await page.getByTestId("wz-field-full_name").locator("input").fill("Анна Докладчикова");
    await page.getByTestId("wz-field-email").locator("input").fill("anna@example.test");
    await page.getByTestId("wz-field-topic").locator("input").fill("Доклад");
    await page.getByTestId("wz-field-abstract").locator("textarea").fill("Тезисы");
    await page.getByTestId("wz-consent--recordform").locator("input").check();
    await page.getByTestId("wz-recordform-submit").click();

    const saved = async () =>
      (
        await fx.sql.unsafe(`select slides from "${schema}"."speaker_application" where full_name = $1`, [
          "Анна Докладчикова",
        ])
      )[0]?.slides as string | undefined;
    await expect.poll(saved, { timeout: 10_000 }).toMatch(/^[0-9a-f-]{36}$/);
    const fileId = (await saved()) as string;
    expect(storage.objects.get(`${schema}/${fileId}`)?.meta.name).toBe("Доклад.pdf");

    // A link to the saved file (RecordCard/FieldValue «Скачать»): GET /api/files/:id → 302 → signed link → a download
    // (attachment), never a page.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.evaluate((id) => {
        const a = document.createElement("a");
        a.href = `/api/files/${id}`;
        document.body.append(a);
        a.click();
      }, fileId),
    ]);
    // (headless Chromium reports the generic name «download» for filename*; the header itself is checked below)
    expect(await download.failure()).toBeNull();
    const got = await page.evaluate(async (id) => {
      const r = await fetch(`/api/files/${id}`);
      return {
        status: r.status,
        redirected: r.redirected,
        url: r.url,
        disposition: r.headers.get("content-disposition"),
        csp: r.headers.get("content-security-policy"),
        nosniff: r.headers.get("x-content-type-options"),
        body: await r.text(),
      };
    }, fileId);
    expect(got).toMatchObject({ status: 200, redirected: true, nosniff: "nosniff", body: PDF.toString() });
    expect(got.url).toContain(`/api/files/${fileId}/content?t=`);
    expect(got.disposition).toMatch(/^attachment;/);
    expect(got.disposition).toContain(`filename*=UTF-8''${encodeURIComponent("Доклад.pdf")}`);
    expect(got.csp).toMatch(/^sandbox/);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);
});
