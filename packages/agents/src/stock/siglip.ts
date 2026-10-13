// V4-10: SigLIP 2 (google/siglip2-base-patch16-224, Apache-2.0; ONNX export onnx-community, pinned revision) — the
// image tower runs in CI over every library photo (tools/stock), the text tower on the platform CPU over the Russian
// query of a brief (int8: ≈ 45 ms a query, ≈ 450 МБ resident while loaded). onnxruntime-node (MIT) and
// @huggingface/tokenizers (Apache-2.0) are imported lazily: nothing loads until the first query. No sharp and no
// transformers.js (their image stack ships LGPL binaries): the image is resized here, in plain TypeScript.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalize } from "./semantic.js";

/** The model files, pinned by revision and checksum (CI uploads them to the library storage; the platform reads them there). */
export const SIGLIP = {
  name: "siglip2-base-patch16-224",
  repo: "onnx-community/siglip2-base-patch16-224-ONNX",
  revision: "ba1f3b0843f24bc5417d38e19c37b287d719b2f4",
  size: 224,
  maxTokens: 64,
  files: {
    text: {
      path: "onnx/text_model_int8.onnx",
      sha256: "3a0603d3a00c05a80a6ded4743c16aaac7b1e62cdcc7e362e7ce418659b96400",
    },
    vision: {
      path: "onnx/vision_model.onnx",
      sha256: "c0573e3f4140c3a7c4e9cc5912bd6b26a033b46a6a8e8af26cbea262b163bcad",
    },
    tokenizer: {
      path: "tokenizer.json",
      sha256: "cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322",
    },
    tokenizerConfig: {
      path: "tokenizer_config.json",
      sha256: "7c3a247599e741bceba1a3fe0285aea88d1044dc1fad2caa1e48cdd9fd25f630",
    },
  },
} as const;

export type SiglipFile = keyof typeof SIGLIP.files;
/** What the platform needs (the text tower); CI also needs the vision one. */
export const TEXT_FILES: readonly SiglipFile[] = ["text", "tokenizer", "tokenizerConfig"];
export const VISION_FILES: readonly SiglipFile[] = ["vision"];

/** Download URL of a model file at the pinned revision (CI only: the platform server does not reach Hugging Face). */
export const siglipUrl = (f: SiglipFile): string =>
  `https://huggingface.co/${SIGLIP.repo}/resolve/${SIGLIP.revision}/${SIGLIP.files[f].path}`;

/** Local name of a model file in a cache directory. */
export const localName = (f: SiglipFile): string => SIGLIP.files[f].path.replace(/\//g, "_");

export const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/**
 * Puts the model files into `dir` from `source` (the library storage on the platform, Hugging Face in CI), each checked
 * against its pinned checksum; a file already there with the right size is kept (its checksum was checked on write).
 */
export async function ensureModelFiles(
  dir: string,
  files: readonly SiglipFile[],
  source: (f: SiglipFile) => Promise<Uint8Array | null>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const f of files) {
    const path = join(dir, localName(f));
    const ok = join(dir, `${localName(f)}.ok`);
    if (await exists(ok)) continue;
    const bytes = await source(f);
    if (!bytes) throw new Error(`siglip: no ${SIGLIP.files[f].path}`);
    if (sha256(bytes) !== SIGLIP.files[f].sha256)
      throw new Error(`siglip: checksum of ${SIGLIP.files[f].path}`);
    await writeFile(`${path}.part`, bytes);
    await rename(`${path}.part`, path);
    await writeFile(ok, SIGLIP.files[f].sha256);
  }
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Text as the model was trained on it: lower case, single spaces. */
export const textForModel = (t: string): string => t.toLowerCase().replace(/\s+/g, " ").trim();

/** Token ids padded with <pad> (0) to SIGLIP.maxTokens; a longer text is cut, keeping its final <eos>. */
export function padTokens(ids: readonly number[], eos = 1): number[] {
  const max = SIGLIP.maxTokens;
  const out = ids.length > max ? [...ids.slice(0, max - 1), eos] : [...ids];
  while (out.length < max) out.push(0);
  return out;
}

/** RGBA pixels, as the codecs decode them. */
export interface Rgba {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * The model input of an image (CHW, 224 × 224, (x / 255 − 0.5) / 0.5 — SiglipImageProcessor: resize without crop) and
 * its mean colour and luma. The resize averages the source pixels under each output pixel (no aliasing on 1600 px).
 */
export function imageInput(img: Rgba): { pixels: Float32Array; color: string; luma: number } {
  const S = SIGLIP.size;
  const { data, width: w, height: h } = img;
  if (w < 1 || h < 1 || data.length < w * h * 4) throw new Error("image: bad pixels");
  const out = new Float32Array(3 * S * S);
  const sum = [0, 0, 0];
  for (let y = 0; y < S; y++) {
    const y0 = Math.floor((y * h) / S);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / S));
    for (let x = 0; x < S; x++) {
      const x0 = Math.floor((x * w) / S);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / S));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const p = (yy * w + xx) * 4;
          r += data[p] as number;
          g += data[p + 1] as number;
          b += data[p + 2] as number;
        }
      const k = 1 / ((y1 - y0) * (x1 - x0));
      const px = [r * k, g * k, b * k];
      for (let c = 0; c < 3; c++) {
        out[c * S * S + y * S + x] = ((px[c] as number) / 255 - 0.5) / 0.5;
        sum[c] = (sum[c] as number) + (px[c] as number);
      }
    }
  }
  const mean = sum.map((v) => v / (S * S));
  const [r, g, b] = mean as [number, number, number];
  const color = `#${mean.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const luma = Math.round(((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * 100) / 100;
  return { pixels: out, color, luma };
}

export interface TextEmbedder {
  /** Unit embedding of a text. */
  encode(text: string): Promise<Float32Array>;
  close(): Promise<void>;
}

export interface ImageEmbedder {
  /** Unit embedding of the model input of imageInput. */
  encode(pixels: Float32Array): Promise<Float32Array>;
  close(): Promise<void>;
}

type Ort = typeof import("onnxruntime-node");

const ort = async (): Promise<Ort> => {
  const m = (await import("onnxruntime-node")) as Ort & { default?: Ort };
  return m.default ?? m;
};

/** The text tower over the files of `dir` (ensureModelFiles TEXT_FILES). */
export async function loadTextEncoder(dir: string, o: { threads?: number } = {}): Promise<TextEmbedder> {
  const [rt, { Tokenizer }] = await Promise.all([ort(), import("@huggingface/tokenizers")]);
  const read = async (f: SiglipFile) => JSON.parse(await readFile(join(dir, localName(f)), "utf8"));
  const tok = new Tokenizer(await read("tokenizer"), await read("tokenizerConfig"));
  const session = await rt.InferenceSession.create(join(dir, localName("text")), {
    intraOpNumThreads: o.threads ?? 2,
    interOpNumThreads: 1,
  });
  const output = session.outputNames.includes("pooler_output")
    ? "pooler_output"
    : (session.outputNames.at(-1) as string);
  return {
    async encode(text) {
      const ids = padTokens(tok.encode(textForModel(text)).ids);
      const r = await session.run({
        input_ids: new rt.Tensor(
          "int64",
          BigInt64Array.from(ids, (i) => BigInt(i)),
          [1, SIGLIP.maxTokens],
        ),
      });
      return normalize(Float32Array.from(r[output]?.data as Float32Array));
    },
    close: () => session.release(),
  };
}

/** The image tower over the files of `dir` (ensureModelFiles VISION_FILES). */
export async function loadImageEncoder(dir: string, o: { threads?: number } = {}): Promise<ImageEmbedder> {
  const rt = await ort();
  const session = await rt.InferenceSession.create(join(dir, localName("vision")), {
    intraOpNumThreads: o.threads ?? 0,
  });
  const output = session.outputNames.includes("pooler_output")
    ? "pooler_output"
    : (session.outputNames.at(-1) as string);
  const S = SIGLIP.size;
  return {
    async encode(pixels) {
      const r = await session.run({ pixel_values: new rt.Tensor("float32", pixels, [1, 3, S, S]) });
      return normalize(Float32Array.from(r[output]?.data as Float32Array));
    },
    close: () => session.release(),
  };
}

/**
 * A text encoder loaded on first use and released after `idleMs` without queries (the worker keeps its ≈ 450 МБ only
 * while builds search photos). `load` failing leaves it unloaded; the next call tries again.
 */
export function lazyTextEncoder(
  load: () => Promise<TextEmbedder>,
  o: { idleMs?: number } = {},
): TextEmbedder & { loaded(): boolean } {
  const idleMs = o.idleMs ?? 10 * 60_000;
  let current: Promise<TextEmbedder> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = 0;
  const release = async () => {
    const enc = current;
    current = undefined;
    if (enc) await (await enc.catch(() => null))?.close();
  };
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (busy === 0) void release();
    }, idleMs);
    timer.unref?.();
  };
  return {
    async encode(text) {
      busy++;
      try {
        current ??= load().catch((e) => {
          current = undefined;
          throw e;
        });
        return await (await current).encode(text);
      } finally {
        busy--;
        arm();
      }
    },
    async close() {
      if (timer) clearTimeout(timer);
      await release();
    },
    loaded: () => current !== undefined,
  };
}
