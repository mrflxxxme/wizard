// Worker thread of one image job (media/processor.ts): instantiate codecs from the compiled modules, run the pipeline,
// post the variants back (buffers transferred) and let the thread end — its WASM memory goes with it.
import { parentPort, workerData } from "node:worker_threads";
import { type CodecModules, instantiateCodecs } from "./codecs.js";
import type { ImageMime } from "./header.js";
import { processImage } from "./pipeline.js";

export interface WorkerInput {
  bytes: Uint8Array;
  mime: ImageMime;
  modules: CodecModules;
}

const input = workerData as WorkerInput;
try {
  const codecs = await instantiateCodecs(input.modules);
  const out = await processImage(input.bytes, input.mime, codecs);
  parentPort?.postMessage(
    { ok: true, image: out },
    out.variants.map((v) => v.data.buffer as ArrayBuffer),
  );
} catch (err) {
  parentPort?.postMessage({
    ok: false,
    reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
  });
}
