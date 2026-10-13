// V4-12 in chromium, 1440 and 390 px: edits in three layers on a built v3 system (test/v3/fake-v3.ts) over the API of
// V4-15 served by the page. The draft is a page whose bridge stub speaks edit-mode / select-mode like the runtime
// bridge: a click on the heading posts literal-selected with its ref (never its text), a click on the block posts
// element-selected. «Правка» → «Тексты и фото»: the picked heading is edited and saved without a model (POST
// /edit/literals with the draft revision) and the frame swaps to the new preview revision; «Стиль»: a slider sends
// the --ds-* preview into the frame at once and «Сохранить стиль» saves only the changed control; «Укажи и измени»:
// the picked block and the wish go as POST /messages with its target. Screenshots in test/artifacts/v4-edit-*.png.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { systemBriefSchema } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadCanvasFeed, loadFeed } from "./mock/server.js";
import { FakeV3, serveV3 } from "./v3/fake-v3.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const HEAD = "aaaaaaaa:1";
const PHOTO = "aaaaaaaa:2";

/** A built v3 system whose draft revision grows with every saved edit. */
class EditV3 extends FakeV3 {
  draft = 5;
  title = "Стоматология «Улыбка»";
  readonly literalPosts: unknown[] = [];
  readonly designPosts: unknown[] = [];
  readonly wishes: unknown[] = [];
  override system(stageOverride?: string): ReturnType<FakeV3["system"]> {
    return {
      ...super.system(stageOverride),
      stage: "ready",
      draftRevision: this.draft,
      previewRevision: this.draft,
    } as unknown as ReturnType<FakeV3["system"]>;
  }
}

/** The draft page: a heading, a photo, a block; the bridge stub of edit-mode and select-mode (like bridge-client.js). */
function draftPage(platformOrigin: string, title: string, rev: string): string {
  const script = `(() => {
    const post = (type, payload) => parent.postMessage({ wz: 1, type, payload }, ${JSON.stringify(platformOrigin)});
    let editing = false, selecting = false;
    addEventListener("message", (e) => {
      if (e.origin !== ${JSON.stringify(platformOrigin)}) return;
      const m = e.data || {};
      if (m.type === "edit-mode") editing = !!m.payload.enabled;
      if (m.type === "select-mode") selecting = !!m.payload.enabled;
      if (m.type === "apply-theme-tokens")
        for (const [k, v] of Object.entries(m.payload.tokens || {})) document.documentElement.style.setProperty(k, v);
    });
    addEventListener("click", (e) => {
      const r = e.target.getBoundingClientRect();
      const rect = { x: r.left, y: r.top, width: r.width, height: r.height };
      if (editing && e.target.id === "head") { e.preventDefault(); post("literal-selected", { refs: ["${HEAD}"], kind: "text", route: "/", rect }); }
      if (selecting && e.target.closest("#block")) { e.preventDefault(); post("element-selected", { componentName: "Hero", wzId: "0a1b2c3d:1", file: "ui/pages/Home.tsx", line: 12, route: "/", rect }); }
    }, true);
  })();`;
  return `<!doctype html><html lang="ru"><body style="margin:0;font:18px system-ui">
<section id="block" style="padding:48px;border-radius:var(--ds-radius,0)"><h1 id="head" data-testid="draft-head">${title}</h1>
<p data-testid="draft-rev">ревизия ${rev}</p></section><script>${script}</script></body></html>`;
}

async function serveEdits(page: Page, fake: EditV3, platformOrigin: string, port: number): Promise<void> {
  await serveV3(page, fake);
  const base = `/api/v1/systems/${fake.systemId}`;
  const draftOrigin = `http://v3-dental--draft.localhost:${port}`;
  await page.route(new RegExp(`${base}/preview-url`), (route) =>
    json(route, 200, {
      url: `${draftOrigin}/_wizard/preview-login?t=${randomUUID()}&next=/`,
      revision: fake.draft,
      roles: [],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }),
  );
  await page.route(/--draft\.localhost/, (route) => {
    const rev = new URL(route.request().url()).searchParams.get("wzrev") ?? "?";
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: draftPage(platformOrigin, fake.title, rev),
    });
  });
  await page.route(new RegExp(`${base}/edit/literals$`), (route) => {
    if (route.request().method() === "GET")
      return json(route, 200, {
        revision: fake.draft,
        literals: [
          { ref: HEAD, kind: "text", value: fake.title, file: "ui/pages/Home.tsx", route: "/" },
          { ref: PHOTO, kind: "image", value: "/_wizard/photos/p1/1200", file: "ui/pages/Home.tsx" },
        ],
      });
    const body = route.request().postDataJSON() as {
      revision: number;
      edits: { ref: string; value: string }[];
    };
    fake.literalPosts.push(body);
    if (body.revision !== fake.draft)
      return json(route, 412, { code: "VERSION_CONFLICT", message_ru: "Черновик изменился" });
    fake.title = body.edits.find((x) => x.ref === HEAD)?.value ?? fake.title;
    fake.draft += 1;
    return json(route, 200, { revision: fake.draft, previewRevision: fake.draft, ms: 420 });
  });
  await page.route(new RegExp(`${base}/edit/design$`), (route) => {
    if (route.request().method() === "GET")
      return json(route, 200, {
        revision: fake.draft,
        radius: "soft",
        density: "regular",
        contrast: "normal",
        fontPair: "Lora+Inter",
        fontPairs: [
          { id: "Lora+Inter", label: "Lora и Inter" },
          { id: "Manrope+Manrope", label: "Manrope и Manrope" },
        ],
        preview: {
          radius: {
            sharp: { "--ds-radius": "0px" },
            crisp: { "--ds-radius": "4px" },
            soft: {},
            round: { "--ds-radius": "28px" },
          },
          density: { compact: { "--ds-space": "12px" }, regular: {}, airy: { "--ds-space": "32px" } },
          contrast: { normal: {}, high: { "--ds-ink-2": "#111111" } },
          fontPair: { "Lora+Inter": {}, "Manrope+Manrope": { "--ds-font-display": "Manrope" } },
        },
      });
    const body = route.request().postDataJSON();
    fake.designPosts.push(body);
    fake.draft += 1;
    return json(route, 200, { revision: fake.draft, previewRevision: fake.draft, ms: 380 });
  });
  await page.route(new RegExp(`${base}/messages$`), (route) => {
    fake.wishes.push(route.request().postDataJSON());
    return json(route, 202, {
      message: { id: randomUUID(), seq: 9, role: "user", kind: "text", text: "x", createdAt: "" },
      run: { id: randomUUID(), kind: "chat_turn", status: "queued", createdAt: new Date().toISOString() },
    });
  });
}

describe.skipIf(!hasChromium)("edits in three layers on the canvas (chromium)", () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    h = await startHarness({ feed: loadFeed("forum"), canvas: loadCanvasFeed(), eventDelayMs: 20 });
  }, 180_000);
  afterAll(async () => h?.close());

  for (const vp of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ] as const)
    test(`${vp.width}px: a text without a model, the style at once, «Укажи и измени»`, async () => {
      const page = await h.page({ viewport: vp, colorScheme: "light", reducedMotion: "reduce" });
      const fake = new EditV3();
      fake.versions.push({
        version: 1,
        brief: systemBriefSchema.parse(dentalBrief()),
        diff: [],
        author: "agent",
        createdAt: new Date().toISOString(),
      });
      await serveEdits(page, fake, h.origin, h.mock.port);
      await page.goto(`${h.origin}/s/${fake.systemId}`);
      const frame = page.frameLocator('[data-testid="canvas-frame-site"]');
      await frame.getByTestId("draft-head").waitFor({ timeout: 15_000 });

      // 1. «Тексты и фото»: pick the heading on the site, change it, save — no model, the frame swaps to the new revision.
      await page.getByTestId("canvas-island-edit").click();
      await page.getByTestId("edit-panel").waitFor();
      await page.getByTestId("edit-text-pick").click();
      // On a phone the panel steps aside while picking and comes back with the pick.
      await page.getByTestId("canvas-panel-edit").waitFor({ state: "hidden" });
      await frame.getByTestId("draft-head").click();
      const field = page.getByTestId("edit-text-field");
      await expect.poll(() => field.inputValue()).toBe("Стоматология «Улыбка»");
      await field.fill("Улыбка — стоматология у дома");
      await page.screenshot({ path: join(ARTIFACTS, `v4-edit-${vp.width}-1-text.png`) });
      await page.getByTestId("edit-text-save").click();
      await expect.poll(() => page.getByTestId("edit-note").textContent()).toBe("Готово за 0,4 с");
      expect(fake.literalPosts).toEqual([
        { revision: 5, edits: [{ ref: HEAD, value: "Улыбка — стоматология у дома" }] },
      ]);
      await expect
        .poll(() => frame.getByTestId("draft-head").textContent(), { timeout: 10_000 })
        .toBe("Улыбка — стоматология у дома");
      expect(await frame.getByTestId("draft-rev").textContent()).toBe("ревизия 6");

      // 2. «Стиль»: a slider changes the site at once (the --ds-* preview), «Сохранить стиль» sends only that control.
      await page.getByTestId("edit-tab-style").click();
      await page.getByTestId("edit-style-radius-round").click();
      await expect
        .poll(() =>
          frame.locator("html").evaluate((el) => (el as HTMLElement).style.getPropertyValue("--ds-radius")),
        )
        .toBe("28px");
      await page.screenshot({ path: join(ARTIFACTS, `v4-edit-${vp.width}-2-style.png`) });
      await page.getByTestId("edit-style-save").click();
      await expect.poll(() => fake.designPosts).toEqual([{ revision: 6, radius: "round" }]);

      // 3. «Укажи и измени»: pick the block, a wish in words → POST /messages with its target.
      await page.getByTestId("edit-tab-point").click();
      await page.getByTestId("edit-point-pick").click();
      await page.getByTestId("canvas-panel-edit").waitFor({ state: "hidden" });
      await frame.locator("#block p").click();
      await page.getByTestId("edit-point-target").waitFor();
      expect(await page.getByTestId("edit-point-target").textContent()).toBe("Блок «Hero»");
      await page.getByTestId("edit-point-wish").fill("Сделай заголовок короче");
      await page.getByTestId("edit-point-send").click();
      await expect.poll(() => fake.wishes.length).toBe(1);
      expect(fake.wishes[0]).toMatchObject({
        text: "Сделай заголовок короче",
        target: { wzId: "0a1b2c3d:1", componentName: "Hero", file: "ui/pages/Home.tsx", line: 12 },
      });
      await page.screenshot({ path: join(ARTIFACTS, `v4-edit-${vp.width}-3-point.png`) });
      await page.context().close();
    }, 90_000);
});
