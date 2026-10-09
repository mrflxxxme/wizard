// V3-14: perceptual hashes of the template gate over generated rasters (no image files): the box-filtered grayscale
// thumbnail, the DCT, pHash and dHash; page-like layouts drawn by code — a copy with jitter, other text lengths and
// colours stays close, a colour-inverted copy is close only with the polarity-invariant distance, another layout is far.
import { describe, expect, test } from "vitest";
import {
  dHash,
  grayThumb,
  hamming,
  hashSimilarity,
  lowDct,
  pHash,
  type RgbaImage,
} from "../src/template/index.js";

/** A W × H raster filled with gray `bg`; `rect` paints a gray rectangle (clipped). */
function raster(w: number, h: number, bg: number) {
  const data = new Uint8Array(w * h * 4);
  const img: RgbaImage = { width: w, height: h, data };
  const rect = (x: number, y: number, rw: number, rh: number, v: number) => {
    for (let yy = Math.max(0, Math.round(y)); yy < Math.min(h, Math.round(y + rh)); yy++)
      for (let xx = Math.max(0, Math.round(x)); xx < Math.min(w, Math.round(x + rw)); xx++) {
        const i = (yy * w + xx) * 4;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
  };
  rect(0, 0, w, h, bg);
  return { img, rect };
}

const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

interface Look {
  bg: number;
  ink: number;
  photo: number;
  band: number;
  /** Pixel jitter of every box. */
  jitter: number;
  seed: number;
}

/** A 1440 × 2400 page: header, a hero, a section, a band, a footer — in one of three layouts. */
function page(layout: "split" | "centered" | "cards", look: Look): RgbaImage {
  const r = rng(look.seed);
  const j = () => (r() - 0.5) * 2 * look.jitter;
  const { img, rect } = raster(1440, 2400, look.bg);
  const text = (x: number, y: number, w: number, lines: number) => {
    for (let i = 0; i < lines; i++) rect(x + j(), y + i * 28 + j(), w * (0.75 + r() * 0.25), 14, look.ink);
  };
  rect(0, 0, 1440, 80, look.band);
  text(60, 30, 160, 1);
  if (layout === "split") {
    text(120, 220, 520, 6);
    rect(780 + j(), 160 + j(), 540, 420, look.photo);
    text(120, 800, 1200, 3);
    for (let i = 0; i < 3; i++) rect(120 + i * 420 + j(), 960 + j(), 360, 300, look.band);
  } else if (layout === "centered") {
    text(420, 260, 600, 4);
    rect(620, 420, 200, 56, look.ink);
    rect(0, 640, 1440, 520, look.photo);
    text(320, 1260, 800, 8);
  } else {
    text(120, 180, 700, 2);
    for (let i = 0; i < 4; i++) rect(120 + i * 300 + j(), 320 + j(), 260, 360, look.band);
    for (let i = 0; i < 4; i++) text(140 + i * 300, 720, 220, 3);
    rect(120, 1000, 600, 600, look.photo);
    text(780, 1040, 540, 12);
  }
  rect(0, 2000, 1440, 400, look.ink);
  return img;
}

const LIGHT: Look = { bg: 250, ink: 40, photo: 140, band: 228, jitter: 0, seed: 1 };

describe("grayThumb, DCT and hashes", () => {
  test("box filter: uniform stays uniform, halves average, fractional cells weigh by area, alpha over white", () => {
    const flat = raster(37, 23, 90).img;
    expect([...grayThumb(flat, 8, 8)].every((v) => Math.abs(v - 90) < 1e-9)).toBe(true);
    const halves = raster(4, 2, 0);
    halves.rect(2, 0, 2, 2, 255);
    expect([...grayThumb(halves.img, 2, 1)]).toEqual([0, 255]);
    const three = raster(3, 1, 0);
    three.rect(1, 0, 1, 1, 90);
    three.rect(2, 0, 1, 1, 180);
    const t = grayThumb(three.img, 2, 1);
    expect(t[0]).toBeCloseTo(30, 9);
    expect(t[1]).toBeCloseTo(150, 9);
    const clear: RgbaImage = { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) };
    expect(grayThumb(clear, 1, 1)[0]).toBe(255);
    expect(() => grayThumb({ width: 2, height: 2, data: new Uint8Array(4) }, 1, 1)).toThrow();
  });

  test("DCT of a flat thumbnail: the DC term only", () => {
    const low = lowDct(new Float64Array(32 * 32).fill(2));
    expect(low[0]).toBeCloseTo(2 * 32 * 32, 6);
    expect([...low.slice(1)].every((v) => Math.abs(v) < 1e-9)).toBe(true);
  });

  test("hashes are 16 hex digits; hamming counts bits; dHash reads the gradient direction", () => {
    const img = page("split", LIGHT);
    expect(pHash(img)).toMatch(/^[0-9a-f]{16}$/);
    expect(pHash(img)).toBe(pHash(page("split", LIGHT)));
    expect(hamming("0000000000000000", "000000000000000f")).toBe(4);
    expect(hamming("ffffffffffffffff", "0000000000000000")).toBe(64);
    expect(() => hamming("ff", "fff")).toThrow();
    const ramp = raster(90, 8, 0);
    for (let x = 0; x < 90; x++) ramp.rect(x, 0, 1, 8, x * 2);
    expect(dHash(ramp.img)).toBe("ffffffffffffffff");
    const back = raster(90, 8, 0);
    for (let x = 0; x < 90; x++) back.rect(x, 0, 1, 8, 255 - x * 2);
    expect(dHash(back.img)).toBe("0000000000000000");
  });

  test("hashSimilarity: 1 for the same hash, ≈ 0 at 32 bits; polarity folds an inverted hash back", () => {
    expect(hashSimilarity("0123456789abcdef", "0123456789abcdef")).toBe(1);
    expect(hashSimilarity("ffffffff00000000", "0000000000000000")).toBe(0);
    expect(hashSimilarity("ffffffffffffffff", "0000000000000000")).toBe(0);
    expect(hashSimilarity("ffffffffffffffff", "0000000000000000", true)).toBe(1);
    expect(hashSimilarity("fffffffffffffff0", "0000000000000000", true)).toBeCloseTo(1 - 4 / 32, 9);
  });
});

describe("page-like layouts drawn by code", () => {
  const LAYOUTS = ["split", "centered", "cards"] as const;
  const copies: Look[] = [
    { ...LIGHT, seed: 2, jitter: 3 },
    { bg: 236, ink: 70, photo: 120, band: 210, jitter: 2, seed: 3 },
    { bg: 255, ink: 20, photo: 160, band: 240, jitter: 4, seed: 4 },
  ];

  test("a copy with jitter, other text lengths and colours stays close (pHash ≥ 0.75, dHash ≥ 0.6)", () => {
    for (const layout of LAYOUTS) {
      const base = page(layout, LIGHT);
      for (const look of copies) {
        const copy = page(layout, look);
        expect(hashSimilarity(pHash(base), pHash(copy), true), `${layout} p`).toBeGreaterThanOrEqual(0.75);
        expect(hashSimilarity(dHash(base), dHash(copy)), `${layout} d`).toBeGreaterThanOrEqual(0.6);
      }
    }
  });

  test("a colour-inverted copy: far as is, close with the polarity-invariant pHash distance", () => {
    for (const layout of LAYOUTS) {
      const base = page(layout, LIGHT);
      const dark = page(layout, {
        bg: 255 - LIGHT.bg,
        ink: 255 - LIGHT.ink,
        photo: 255 - LIGHT.photo,
        band: 255 - LIGHT.band,
        jitter: 0,
        seed: 1,
      });
      expect(hashSimilarity(pHash(base), pHash(dark))).toBeLessThan(0.2);
      expect(hashSimilarity(pHash(base), pHash(dark), true)).toBeGreaterThanOrEqual(0.9);
    }
  });

  test("another layout is far (pHash ≤ 0.5 even with the polarity fold)", () => {
    for (const a of LAYOUTS)
      for (const b of LAYOUTS) {
        if (a === b) continue;
        expect(
          hashSimilarity(pHash(page(a, LIGHT)), pHash(page(b, LIGHT)), true),
          `${a}/${b}`,
        ).toBeLessThanOrEqual(0.5);
      }
  });
});
