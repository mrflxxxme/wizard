// V4-16 in chromium, 1440 and 390 px: a photo of a built v3 system (test/v3/fake-v3.ts) replaced from the library by
// meaning and by the owner's upload. The draft page's bridge stub posts literal-selected for its photo (edit-mode, like
// bridge-client.js); the panel lists 20 photos for the slot (GET /photos?ref=), a search in Russian asks again with the
// words; a pick saves the slot as an instant edit (POST /edit/literals: the same path with the new id) and the frame
// swaps to the new revision; «Загрузить своё» sends the file (POST /photos), puts it into the slot at once and lists it
// first. Screenshots in test/artifacts/v4-photos-*.png.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
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
const PHOTO = "aaaaaaaa:2";
const ids = Array.from({ length: 20 }, () => randomUUID());

/** A 1×1 PNG of a colour (the previews and the draft's photo). */
function dot(rgb: [number, number, number]): Buffer {
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, ...rgb]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

class PhotoV3 extends FakeV3 {
  draft = 5;
  photo = ids[0] as string;
  readonly literalPosts: { revision: number; edits: { ref: string; value: string }[] }[] = [];
  readonly searches: string[] = [];
  readonly photoUploads: number[] = [];
  readonly own: string[] = [];
  override system(stageOverride?: string): ReturnType<FakeV3["system"]> {
    return {
      ...super.system(stageOverride),
      stage: "ready",
      draftRevision: this.draft,
      previewRevision: this.draft,
    } as unknown as ReturnType<FakeV3["system"]>;
  }
}

function draftPage(platformOrigin: string, photo: string, rev: string): string {
  const script = `(() => {
    let editing = false;
    addEventListener("message", (e) => {
      if (e.origin !== ${JSON.stringify(platformOrigin)}) return;
      if ((e.data || {}).type === "edit-mode") editing = !!e.data.payload.enabled;
    });
    addEventListener("click", (e) => {
      if (!editing || e.target.id !== "photo") return;
      e.preventDefault();
      const r = e.target.getBoundingClientRect();
      parent.postMessage({ wz: 1, type: "literal-selected", payload: { refs: ["${PHOTO}"], kind: "image", route: "/", rect: { x: r.left, y: r.top, width: r.width, height: r.height } } }, ${JSON.stringify(platformOrigin)});
    }, true);
  })();`;
  return `<!doctype html><html lang="ru"><body style="margin:0;font:18px system-ui">
<h1>Стоматология</h1><img id="photo" data-testid="draft-photo" src="/_wizard/photos/${photo}/1600" width="320" height="200" alt="">
<p data-testid="draft-rev">ревизия ${rev}</p><script>${script}</script></body></html>`;
}

async function servePhotos(page: Page, fake: PhotoV3, platformOrigin: string, port: number): Promise<void> {
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
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/_wizard/photos/"))
      return route.fulfill({ status: 200, contentType: "image/png", body: dot([200, 120, 90]) });
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: draftPage(platformOrigin, fake.photo, url.searchParams.get("wzrev") ?? "?"),
    });
  });
  await page.route(new RegExp(`${base}/edit/literals$`), (route) => {
    if (route.request().method() === "GET")
      return json(route, 200, {
        revision: fake.draft,
        literals: [
          { ref: "aaaaaaaa:1", kind: "text", value: "Стоматология", file: "ui/pages/Home.tsx", route: "/" },
          {
            ref: PHOTO,
            kind: "image",
            value: `/_wizard/photos/${fake.photo}/1600`,
            file: "ui/pages/Home.tsx",
          },
        ],
      });
    const body = route.request().postDataJSON();
    fake.literalPosts.push(body);
    fake.photo = /[0-9a-f-]{36}/.exec(body.edits[0].value)?.[0] ?? fake.photo;
    fake.draft += 1;
    return json(route, 200, { revision: fake.draft, previewRevision: fake.draft, ms: 380 });
  });
  await page.route(new RegExp(`${base}/photos/[0-9a-f-]{36}/thumb$`), (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: dot([90, 140, 200]) }),
  );
  await page.route(new RegExp(`${base}/photos(\\?.*)?$`), (route) => {
    if (route.request().method() === "POST") {
      fake.photoUploads.push(route.request().postDataBuffer()?.byteLength ?? 0);
      const id = randomUUID();
      fake.own.unshift(id);
      return json(route, 201, {
        photo: { id, source: "owner", thumb: `${base}/photos/${id}/thumb`, width: 1, height: 1 },
      });
    }
    const url = new URL(route.request().url());
    fake.searches.push(url.searchParams.get("q") ?? `ref:${url.searchParams.get("ref")}`);
    const photos = [
      ...fake.own.map((id) => ({ id, source: "owner", thumb: `${base}/photos/${id}/thumb` })),
      ...ids.map((id, i) => ({
        id,
        source: "library",
        thumb: `${base}/photos/${id}/thumb`,
        author: `Автор ${i + 1}`,
        provider: "pexels",
      })),
    ].slice(0, 20);
    return json(route, 200, { query: url.searchParams.get("q") ?? "Стоматология", photos });
  });
}

describe.skipIf(!hasChromium)("photos of a system on the canvas (chromium)", () => {
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
    test(`${vp.width}px: a photo from the library by meaning, then the owner's own`, async () => {
      const page = await h.page({ viewport: vp, colorScheme: "light", reducedMotion: "reduce" });
      const fake = new PhotoV3();
      fake.versions.push({
        version: 1,
        brief: systemBriefSchema.parse(dentalBrief()),
        diff: [],
        author: "agent",
        createdAt: new Date().toISOString(),
      });
      await servePhotos(page, fake, h.origin, h.mock.port);
      await page.goto(`${h.origin}/s/${fake.systemId}`);
      const frame = page.frameLocator('[data-testid="canvas-frame-site"]');
      await frame.getByTestId("draft-photo").waitFor({ timeout: 15_000 });

      // A click on the photo on the site: 20 photos for the slot, chosen by its meaning.
      await page.getByTestId("p-composer-input").click();
      await page.getByTestId("canvas-tile-edit").click();
      await page.getByTestId("edit-text-pick").click();
      await page.getByTestId("canvas-panel-edit").waitFor({ state: "hidden" });
      await frame.getByTestId("draft-photo").click();
      const choices = page.getByTestId("photo-choice");
      await expect.poll(() => choices.count(), { timeout: 10_000 }).toBe(20);
      expect(fake.searches[0]).toBe(`ref:${PHOTO}`);
      expect(await choices.first().getAttribute("aria-pressed")).toBe("true");

      // A search in Russian asks again with the words.
      await page.getByTestId("photo-search").fill("улыбка врача");
      await page.getByTestId("photo-search-go").click();
      await expect.poll(() => fake.searches.at(-1)).toBe("улыбка врача");
      await expect.poll(() => choices.count()).toBe(20);
      await page.screenshot({ path: join(ARTIFACTS, `v4-photos-${vp.width}-1-choice.png`) });

      // A pick: the instant edit of the slot (same width, new id), the frame shows the new photo.
      await choices.nth(3).click();
      await expect.poll(() => fake.literalPosts.length).toBe(1);
      expect(fake.literalPosts[0]).toEqual({
        revision: 5,
        edits: [{ ref: PHOTO, value: `/_wizard/photos/${ids[3]}/1600` }],
      });
      await expect
        .poll(() => frame.getByTestId("draft-photo").getAttribute("src"), { timeout: 10_000 })
        .toBe(`/_wizard/photos/${ids[3]}/1600`);
      await expect.poll(() => page.getByTestId("edit-note").textContent()).toBe("Фото заменено за 0,4 с");

      // «Загрузить своё»: the file goes up, lands in the slot at once and is offered first.
      await page.getByTestId("photo-upload-file").setInputFiles({
        name: "моё фото.png",
        mimeType: "image/png",
        buffer: dot([10, 200, 30]),
      });
      await expect.poll(() => fake.photoUploads.length).toBe(1);
      await expect.poll(() => fake.literalPosts.length).toBe(2);
      const own = fake.own[0] as string;
      expect(fake.literalPosts[1]?.edits[0]?.value).toBe(`/_wizard/photos/${own}/1600`);
      await expect.poll(() => choices.first().getAttribute("data-source")).toBe("owner");
      await expect
        .poll(() => frame.getByTestId("draft-photo").getAttribute("src"), { timeout: 10_000 })
        .toBe(`/_wizard/photos/${own}/1600`);
      await page.screenshot({ path: join(ARTIFACTS, `v4-photos-${vp.width}-2-own.png`) });
      await page.context().close();
    }, 90_000);
});
