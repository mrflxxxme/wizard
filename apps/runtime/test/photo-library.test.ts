// B2-38 acceptance (runtime): a stock photo copied into the platform photo library is re-encoded into WebP variants
// without EXIF under wz_photos/ (one copy per stock photo, shared by systems; a system purge never touches it) and is
// served from the system's own origin at /_wizard/photos/:id/:width — public, immutable, nosniff; anything else → 404.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  libraryPhotoId,
  MemoryFileStorage,
  PHOTO_LIBRARY_PREFIX,
  PhotoLibraryError,
  purgeSchemaFiles,
  storeLibraryPhoto,
} from "../src/index.js";
import { forumSpec, type Harness, harness, request } from "./helpers.js";
import { encodeJpeg, GPS_MARKER, photo, webpSize, withExif } from "./media-helpers.js";

const storage = new MemoryFileStorage();
let h: Harness;
let schema = "";
const host = "photosys--draft.localhost";
const get = (path: string) => h.rt.fetch(request("GET", host, path, {}));

beforeAll(async () => {
  h = await harness({}, { files: storage });
  ({ schema } = await h.system("photosys", forumSpec()));
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("platform photo library", () => {
  let id = "";

  test("a stock JPEG with EXIF → WebP 1600/960/480 under wz_photos/, no EXIF, idempotent by source", async () => {
    const jpeg = withExif(await encodeJpeg(photo(2400, 1600), 2400, 1600));
    const r = await storeLibraryPhoto(storage, jpeg, { source: "pexels:123" });
    expect(r).toMatchObject({ width: 1600, height: 1067, stored: true });
    expect(r.id).toBe(libraryPhotoId("pexels:123"));
    expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    id = r.id;
    const keys = [...storage.objects.keys()].filter((k) => k.startsWith(`${PHOTO_LIBRARY_PREFIX}/`)).sort();
    expect(keys).toEqual([`wz_photos/${id}`, `wz_photos/${id}.w480`, `wz_photos/${id}.w960`]);
    for (const k of keys)
      expect(Buffer.from(storage.objects.get(k)?.data ?? []).toString("latin1")).not.toContain(GPS_MARKER);
    const again = await storeLibraryPhoto(storage, jpeg, { source: "pexels:123" });
    expect(again).toEqual({ ...r, stored: false });
    expect(libraryPhotoId("pixabay:123")).not.toBe(id);
  }, 60_000);

  test("not a picture → UNSUPPORTED", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
    await expect(storeLibraryPhoto(storage, pdf, { source: "pexels:1" })).rejects.toBeInstanceOf(
      PhotoLibraryError,
    );
  });

  test("GET /_wizard/photos/:id/:width — public, immutable, inline WebP of the asked width", async () => {
    const res = await get(`/_wizard/photos/${id}/480`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(webpSize(new Uint8Array(await res.arrayBuffer()))).toEqual({ width: 480, height: 320 });
    const big = await get(`/_wizard/photos/${id}/1600`);
    expect(webpSize(new Uint8Array(await big.arrayBuffer()))).toEqual({ width: 1600, height: 1067 });
    for (const bad of [
      `/_wizard/photos/${id}/500`,
      `/_wizard/photos/${libraryPhotoId("pexels:404")}/960`,
      "/_wizard/photos/..%2F..%2Fx/960",
      `/_wizard/photos/${id}`,
    ])
      expect((await get(bad)).status, bad).toBe(404);
  });

  test("a system's file purge keeps the library", async () => {
    await purgeSchemaFiles(storage, schema);
    expect((await get(`/_wizard/photos/${id}/960`)).status).toBe(200);
  });
});
