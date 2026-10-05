// WASM codecs of the image pipeline (@jsquash, Apache-2.0; MozJPEG, libwebp, png — BSD/MIT; no native builds, no LGPL:
// AGENTS.md, M2-47). The main thread compiles the modules once; a worker instantiates them per job and exits, which
// frees the codec memory (WASM memories never shrink).
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { ImageMime } from "./header.js";
import type { Codecs } from "./pipeline.js";
import type { Rgba } from "./pixels.js";

export interface CodecModules {
  jpegDec: WebAssembly.Module;
  pngDec: WebAssembly.Module;
  webpDec: WebAssembly.Module;
  webpEnc: WebAssembly.Module;
}

const WASM = {
  jpegDec: "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
  pngDec: "@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
  webpDec: "@jsquash/webp/codec/dec/webp_dec.wasm",
  // Node 22 has WASM SIMD: @jsquash/webp picks its SIMD glue, so the SIMD build is the matching module.
  webpEnc: "@jsquash/webp/codec/enc/webp_enc_simd.wasm",
} as const;

let compiled: Promise<CodecModules> | undefined;

/** Compiled codec modules (once per process). */
export function codecModules(): Promise<CodecModules> {
  compiled ??= (async () => {
    const req = createRequire(import.meta.url);
    const entries = await Promise.all(
      Object.entries(WASM).map(
        async ([k, p]) => [k, await WebAssembly.compile(await readFile(req.resolve(p)))] as const,
      ),
    );
    return Object.fromEntries(entries) as unknown as CodecModules;
  })();
  return compiled;
}

type ImageDataLike = { data: Uint8ClampedArray; width: number; height: number };

/** Codecs bound to instances of `modules` in the current thread. */
export async function instantiateCodecs(modules: CodecModules): Promise<Codecs> {
  // ImageData does not exist in Node: the emscripten glue installs a polyfill, the png glue expects one too.
  const g = globalThis as { ImageData?: unknown };
  g.ImageData ??= class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  };
  const [jd, pd, wd, we] = await Promise.all([
    import("@jsquash/jpeg/decode.js"),
    import("@jsquash/png/decode.js"),
    import("@jsquash/webp/decode.js"),
    import("@jsquash/webp/encode.js"),
  ]);
  await jd.init(modules.jpegDec);
  await pd.init(modules.pngDec);
  await wd.init(modules.webpDec);
  await we.init(modules.webpEnc);
  const rgba = (img: ImageDataLike): Rgba => ({ data: img.data, width: img.width, height: img.height });
  return {
    async decode(bytes: Uint8Array, mime: ImageMime) {
      const buf = bytes.slice().buffer as ArrayBuffer;
      if (mime === "image/jpeg") return rgba((await jd.default(buf)) as ImageDataLike);
      if (mime === "image/png") return rgba((await pd.default(buf)) as ImageDataLike);
      return rgba((await wd.default(buf)) as ImageDataLike);
    },
    async encodeWebp(img: Rgba, quality: number) {
      const out = await we.default(
        { data: img.data, width: img.width, height: img.height, colorSpace: "srgb" } as never,
        {
          quality,
          method: 4,
        },
      );
      return new Uint8Array(out);
    },
  };
}
