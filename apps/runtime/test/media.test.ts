// M2-47 acceptance (pipeline part): JPEG 4000×3000 with EXIF GPS → WebP variants 1600/960/480 without EXIF, largest
// ≤ 400 КБ; EXIF orientation applied; a PNG bomb (20 000 × 20 000) is refused from its header without decoding.
import { describe, expect, test } from "vitest";
import { IMAGE_WIDTHS, imageSize, jpegOrientation, withinLimits } from "../src/media/header.js";
import { LARGEST_MAX_BYTES } from "../src/media/pipeline.js";
import { downscale, orient } from "../src/media/pixels.js";
import { ImageError, ImageProcessor } from "../src/media/processor.js";
import { ascii, encodeJpeg, GPS_MARKER, photo, pngBomb, webpSize, withExif } from "./media-helpers.js";

describe("pixels", () => {
  test("downscale averages areas (2×2 → 1×1) and keeps alpha-weighted colour", () => {
    const img = {
      width: 2,
      height: 2,
      data: Uint8ClampedArray.from([0, 0, 0, 255, 200, 100, 0, 255, 100, 100, 100, 255, 0, 0, 0, 0]),
    };
    const out = downscale(img, 1, 1);
    expect([...out.data]).toEqual([100, 67, 33, 191]);
  });

  test("downscale to a non-integer ratio keeps a uniform colour uniform", () => {
    const w = 7;
    const h = 5;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([10, 200, 30, 255], i * 4);
    const out = downscale({ width: w, height: h, data }, 3, 2);
    for (let i = 0; i < 6; i++) expect([...out.data.subarray(i * 4, i * 4 + 4)]).toEqual([10, 200, 30, 255]);
  });

  test("orientation 6 rotates 90° clockwise: top-left comes from bottom-left", () => {
    // 2×1: left red, right blue → after 6: 1×2, top red, bottom blue.
    const img = { width: 2, height: 1, data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, 255, 255]) };
    const out = orient(img, 6);
    expect([out.width, out.height]).toEqual([1, 2]);
    expect([...out.data]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
    const o8 = orient(img, 8);
    expect([...o8.data]).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
  });
});

describe("headers", () => {
  test("PNG bomb 20 000 × 20 000: size read from IHDR, over the limits", () => {
    const s = imageSize(pngBomb(20_000, 20_000), "image/png");
    expect(s).toEqual({ width: 20_000, height: 20_000 });
    expect(withinLimits(s as never)).toBe(false);
    expect(withinLimits({ width: 8000, height: 5000 })).toBe(true);
    expect(withinLimits({ width: 8001, height: 100 })).toBe(false);
    expect(withinLimits({ width: 7000, height: 7000 })).toBe(false);
  });
});

describe("processor", () => {
  test("JPEG 4000×3000 with EXIF GPS → WebP 1600/960/480 without EXIF, largest ≤ 400 КБ", async () => {
    const jpeg = withExif(await encodeJpeg(photo(4000, 3000), 4000, 3000));
    expect(ascii(jpeg)).toContain(GPS_MARKER);
    expect(imageSize(jpeg, "image/jpeg")).toEqual({ width: 4000, height: 3000 });
    const out = await new ImageProcessor().process(jpeg, "image/jpeg");
    expect(out.variants.map((v) => v.slot)).toEqual([...IMAGE_WIDTHS].reverse());
    for (const v of out.variants) {
      const text = ascii(v.data);
      expect(text.slice(0, 4)).toBe("RIFF");
      expect(text.slice(8, 12)).toBe("WEBP");
      expect(text).not.toContain("EXIF");
      expect(text).not.toContain("Exif");
      expect(text).not.toContain(GPS_MARKER);
      expect(webpSize(v.data)).toEqual({ width: v.slot, height: (v.slot * 3) / 4 });
    }
    expect(out.variants[0]?.data.byteLength).toBeLessThanOrEqual(LARGEST_MAX_BYTES);
    expect([out.width, out.height]).toEqual([1600, 1200]);
  }, 60_000);

  test("EXIF orientation 6 (phone portrait): variants are upright, smaller source → no upscaling", async () => {
    const jpeg = withExif(await encodeJpeg(photo(800, 600), 800, 600), 6);
    expect(jpegOrientation(jpeg)).toBe(6);
    const out = await new ImageProcessor().process(jpeg, "image/jpeg");
    expect([out.width, out.height]).toEqual([600, 800]);
    expect(out.variants.map((v) => [v.slot, v.width, v.height])).toEqual([
      [1600, 600, 800],
      [480, 480, 640],
    ]);
  }, 60_000);

  test("PNG bomb → TOO_LARGE before any worker starts; garbage → UNREADABLE", async () => {
    const p = new ImageProcessor();
    const bomb = pngBomb(20_000, 20_000);
    await expect(p.process(bomb, "image/png")).rejects.toEqual(new ImageError("TOO_LARGE"));
    const broken = pngBomb(100, 100);
    await expect(p.process(broken, "image/png")).rejects.toEqual(new ImageError("UNREADABLE"));
  }, 60_000);

  test("time cap: a job over timeoutMs ends as TIMEOUT and the worker is stopped", async () => {
    const jpeg = await encodeJpeg(photo(2000, 1500), 2000, 1500);
    await expect(new ImageProcessor({ timeoutMs: 5 }).process(jpeg, "image/jpeg")).rejects.toEqual(
      new ImageError("TIMEOUT"),
    );
  }, 60_000);
});
