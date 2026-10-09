// Input tokens before a call (V3-13): images count by their size and the model's rule (models.yaml#models[].image),
// PDFs by pages, never their base64 as text; a call without attachments is estimated exactly as before.
import { describe, expect, test } from "vitest";
import {
  attachmentTokens,
  DEFAULT_IMAGE_RULE,
  estimateInputTokens,
  estimateTokens,
  IMAGE_FALLBACK_TOKENS,
  imageSize,
  imageTokens,
  type LlmAttachment,
  type LlmMessage,
  MODELS,
  PDF_PAGE_TOKENS,
} from "../src/index.js";

/** Pseudo-random filler: incompressible bytes, so the base64 is as long as a real screenshot's. */
const filler = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 2654435761) >>> 24));

const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
/** A JPEG: SOI, APP0 (JFIF), optional big APP1, SOF0 with the size, filler, EOI. */
function jpeg(width: number, height: number, bytes = 0, app1 = 0): string {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), u16(16), Buffer.from("JFIF\0"), Buffer.alloc(9)]);
  // EXIF/ICC segments of ≤ 60 000 bytes each (a segment length is 16 bits).
  const segs: Buffer[] = [];
  for (let left = app1; left > 0; left -= 60_000) {
    const n = Math.min(left, 60_000);
    segs.push(Buffer.from([0xff, 0xe1]), u16(n + 2), filler(n));
  }
  const exif = Buffer.concat(segs);
  const sof = Buffer.concat([
    Buffer.from([0xff, 0xc0]),
    u16(17),
    Buffer.from([8]),
    u16(height),
    u16(width),
    Buffer.alloc(10),
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    exif,
    sof,
    filler(bytes),
    Buffer.from([0xff, 0xd9]),
  ]).toString("base64");
}

function png(width: number, height: number): string {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]).toString(
    "base64",
  );
}

function webpX(width: number, height: number): string {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b.toString("base64");
}

const img = (data: string, mime: LlmAttachment["mime"] = "image/jpeg"): LlmAttachment => ({ mime, data });

describe("image size from the header", () => {
  test("JPEG (also behind a large EXIF segment), PNG, WebP; a hashed or broken one is unreadable", () => {
    expect(imageSize(img(jpeg(390, 844, 20_000)))).toEqual({ width: 390, height: 844 });
    expect(imageSize(img(jpeg(1440, 900, 1000, 120_000)))).toEqual({ width: 1440, height: 900 });
    expect(imageSize(img(png(720, 450), "image/png"))).toEqual({ width: 720, height: 450 });
    expect(imageSize(img(webpX(1600, 1200), "image/webp"))).toEqual({ width: 1600, height: 1200 });
    expect(imageSize(img("sha256:abc"))).toBeNull();
    expect(imageSize(img(Buffer.from("not an image").toString("base64")))).toBeNull();
  });
});

describe("tokens of an attachment by the model's rule", () => {
  test("one token per px × px square plus the markers, within [4, max]", () => {
    expect(imageTokens(390, 844)).toBe(14 * 31 + 2);
    expect(imageTokens(390, 844, { px: 32, max: 16384 })).toBe(13 * 27 + 2);
    expect(imageTokens(8000, 8000)).toBe(DEFAULT_IMAGE_RULE.max + 2);
    expect(imageTokens(10, 10)).toBe(4 + 2);
  });

  test("unreadable images and PDFs: conservative, never the base64 length", () => {
    const big = Buffer.from(filler(200_000)).toString("base64");
    expect(attachmentTokens(img(big))).toBe(IMAGE_FALLBACK_TOKENS + 2);
    expect(attachmentTokens(img(big))).toBeLessThan(estimateTokens(big) / 10);
    const pdf = Buffer.from(
      "%PDF-1.7\n1 0 obj << /Type /Pages /Count 2 >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type /Page >>",
    );
    expect(attachmentTokens({ mime: "application/pdf", data: pdf.toString("base64") })).toBe(
      2 * PDF_PAGE_TOKENS,
    );
  });

  test("every vision model of the catalog has its rule; others fall back to the default", () => {
    const vision = MODELS.filter((m) => m.vision);
    expect(vision.map((m) => `${m.id}:${m.image?.px}`)).toEqual([
      "kimi-k2.6:28",
      "qwen3.6-35b:32",
      "glm-5.3-flash:28",
      "glm-4.6v:28",
    ]);
    expect(MODELS.filter((m) => !m.vision).every((m) => m.image === undefined)).toBe(true);
  });
});

describe("input tokens of a call", () => {
  const text: LlmMessage[] = [
    { role: "system", content: "Ты — критик. Отвечай вызовом инструмента." },
    { role: "user", content: "Сайт «Белая линия» — стоматология. Оцени первый экран." },
  ];
  const tools = [{ name: "submit", description: "x", parameters: { type: "object" } }];

  test("without attachments — exactly the old estimate (JSON / 3.2 of messages and tools)", () => {
    for (const m of [undefined, MODELS[0], MODELS.find((x) => x.image)])
      expect(estimateInputTokens(text, tools, m)).toBe(estimateTokens(text) + estimateTokens(tools));
  });

  test("with screenshots — their text part plus image tokens by the model, not the base64", () => {
    const shot = jpeg(390, 844, 21_000);
    const withShot: LlmMessage[] = [
      text[0] as LlmMessage,
      { role: "user", content: "Изображения: 1. / при 390.", attachments: [img(shot)] },
    ];
    const kimi = MODELS.find((m) => m.id === "kimi-k2.6");
    const qwen = MODELS.find((m) => m.id === "qwen3.6-35b");
    const textOnly = estimateTokens([
      text[0],
      {
        role: "user",
        content: "Изображения: 1. / при 390.",
        attachments: [{ mime: "image/jpeg", data: "" }],
      },
    ]);
    expect(estimateInputTokens(withShot, [], kimi)).toBe(textOnly + estimateTokens([]) + 14 * 31 + 2);
    expect(estimateInputTokens(withShot, [], qwen)).toBe(textOnly + estimateTokens([]) + 13 * 27 + 2);
    // The old way counted ≈ 8 800 tokens of base64 for this one picture.
    expect(estimateTokens(withShot)).toBeGreaterThan(8_000);
    expect(estimateInputTokens(withShot, [], kimi)).toBeLessThan(600);
  });
});
