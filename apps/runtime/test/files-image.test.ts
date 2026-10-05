// M2-47 acceptance (runtime): image fields — upload by a signed-in role → WebP variants without EXIF; GET of a variant →
// 200 inline, image/webp, nosniff, immutable cache, by the row permission (the public role reads public rows); SVG and
// PDF → 415; a PNG bomb → 413; the public role never uploads images; a replaced image goes with all its variants;
// file fields stay attachments. Also the theme fonts route (M2-42): /_wizard/fonts serves catalog files only.
import type { AppSpec, Entity } from "@wizard/appspec";
import { fontFiles } from "@wizard/ui-kit/fonts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MemoryFileStorage } from "../src/index.js";
import { forumSpec, type Harness, harness, login, request } from "./helpers.js";
import { encodeJpeg, GPS_MARKER, photo, pngBomb, webpSize, withExif } from "./media-helpers.js";

const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

/** Forum + stream.cover (image) readable by the visitor; the visitor may also create streams (still no image upload). */
function imageSpec(): AppSpec {
  const spec = forumSpec();
  (spec.entities.find((e) => e.name === "stream") as Entity).fields.push({
    name: "cover",
    label: "Обложка",
    type: "image",
  });
  const p = spec.permissions.find((x) => x.role === "visitor" && x.entity === "stream");
  if (p) p.ops = ["read", "create"];
  return spec;
}

const storage = new MemoryFileStorage();
let h: Harness;
let host = "";
let schema = "";
let organizer = "";
let jpeg: Uint8Array;

async function upload(cookie: string | null, bytes: Uint8Array, name = "cover.jpg") {
  const form = new FormData();
  form.set("file", new File([bytes as Uint8Array<ArrayBuffer>], name));
  form.set("field", "cover");
  const headers: Record<string, string> = { host, origin: `http://${host}`, "x-wizard-request": "1" };
  if (cookie) headers.cookie = cookie;
  const res = await h.rt.fetch(
    new Request("http://127.0.0.1:4100/api/files", { method: "POST", headers, body: form }),
  );
  return {
    res,
    json: (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } },
  };
}

const get = (path: string, cookie: string | null = null, headers: Record<string, string> = {}) =>
  h.rt.fetch(request("GET", host, path, { cookie, headers }));

async function json(method: string, path: string, cookie: string | null, body?: unknown) {
  const res = await h.rt.fetch(request(method, host, path, { cookie, body }));
  return { res, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  h = await harness({}, { files: storage });
  ({ schema } = await h.system("imgsys", imageSpec()));
  host = "imgsys--draft.localhost";
  organizer = await login(h.rt, host, "organizer");
  jpeg = withExif(await encodeJpeg(photo(4000, 3000), 4000, 3000));
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("image upload", () => {
  let fileId = "";
  let streamId = "";

  test("organizer uploads a 4000×3000 JPEG with EXIF → 201 WebP 1600×1200, variants 960 and 480 stored", async () => {
    const r = await upload(organizer, jpeg);
    expect(r.res.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toMatchObject({ mime: "image/webp", width: 1600, height: 1200, name: "cover.webp" });
    fileId = String(r.json.fileId);
    const keys = [...storage.objects.keys()].filter((k) => k.startsWith(`${schema}/${fileId}`)).sort();
    expect(keys).toEqual([`${schema}/${fileId}`, `${schema}/${fileId}.w480`, `${schema}/${fileId}.w960`]);
    for (const k of keys)
      expect(Buffer.from(storage.objects.get(k)?.data ?? []).toString("latin1")).not.toContain(GPS_MARKER);
  }, 60_000);

  test("before a row holds it, nobody reads the image (404)", async () => {
    expect((await get(`/api/files/${fileId}/img/960`, organizer)).status).toBe(404);
  });

  test("attached to a stream: the visitor (no account) gets the variant inline with an immutable cache", async () => {
    const created = await json("POST", "/api/data/stream", organizer, {
      name: "Дизайн",
      capacity: 100,
      cover: fileId,
    });
    expect(created.res.status, JSON.stringify(created.json)).toBe(201);
    streamId = String((created.json.item as { id: string }).id);
    const res = await get(`/api/files/${fileId}/img/960`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(webpSize(body)).toEqual({ width: 960, height: 720 });
    const etag = res.headers.get("etag") ?? "";
    expect((await get(`/api/files/${fileId}/img/960`, null, { "if-none-match": etag })).status).toBe(304);
    const big = await get(`/api/files/${fileId}/img/1600`, organizer);
    expect(big.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(webpSize(new Uint8Array(await big.arrayBuffer()))).toEqual({ width: 1600, height: 1200 });
    expect((await get(`/api/files/${fileId}/img/777`)).status).toBe(404);
    const info = await json("GET", `/api/files/${fileId}/info`, null);
    expect(info.json).toMatchObject({ mime: "image/webp", width: 1600, height: 1200 });
  });

  test("replacing the image deletes the old object and all its variants", async () => {
    const next = await upload(organizer, await encodeJpeg(photo(640, 480), 640, 480));
    expect(next.res.status).toBe(201);
    expect(next.json).toMatchObject({ width: 640, height: 480 });
    const r = await json("PATCH", `/api/data/stream/${streamId}`, organizer, { cover: next.json.fileId });
    expect(r.res.status, JSON.stringify(r.json)).toBe(200);
    await expect
      .poll(() => [...storage.objects.keys()].filter((k) => k.includes(fileId)).length, { timeout: 3000 })
      .toBe(0);
    // 640 wide: the 960 slot falls back to the largest variant, 480 exists.
    const nid = String(next.json.fileId);
    expect(webpSize(new Uint8Array(await (await get(`/api/files/${nid}/img/960`)).arrayBuffer())).width).toBe(
      640,
    );
    expect(webpSize(new Uint8Array(await (await get(`/api/files/${nid}/img/480`)).arrayBuffer())).width).toBe(
      480,
    );
  }, 60_000);
});

describe("image upload refusals", () => {
  test("SVG and PDF into an image field → 415", async () => {
    for (const [bytes, name] of [
      [SVG, "logo.svg"],
      [PDF, "doc.pdf"],
    ] as const) {
      const r = await upload(organizer, bytes, name);
      expect(r.res.status, name).toBe(415);
    }
  });

  test("PNG 20 000 × 20 000 (decompression bomb) → 413 with a plain message", async () => {
    const r = await upload(organizer, pngBomb(20_000, 20_000), "bomb.png");
    expect(r.res.status).toBe(413);
    expect(r.json.error?.message).toContain("8000");
  });

  test("the public role does not upload images, even with create on the entity → 403", async () => {
    const r = await upload(null, jpeg);
    expect(r.res.status).toBe(403);
  }, 30_000);
});

describe("theme fonts", () => {
  test("GET /_wizard/fonts/<catalog file> → woff2, immutable; anything else → 404", async () => {
    const file = fontFiles()[0] as string;
    const res = await get(`/_wizard/fonts/${file}`, organizer);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()).subarray(0, 4))).toBe("wOF2");
    for (const bad of ["LICENSE-onest.txt", "..%2F..%2Fpackage.json", "nope.woff2"])
      expect((await get(`/_wizard/fonts/${bad}`, organizer)).status, bad).toBe(404);
  });
});
