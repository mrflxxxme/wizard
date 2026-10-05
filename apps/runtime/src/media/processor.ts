// Image jobs of the runtime process (runtime.yaml#files.image, executability MP-29): size limits from the header before
// decoding, one worker thread per job with a heap cap and a time cap, at most `concurrency` jobs at once and a short
// queue. Errors are ImageError codes; routes/files.ts maps them to 413 / 422 / 429.
import { Worker } from "node:worker_threads";
import { codecModules } from "./codecs.js";
import { type ImageMime, imageSize, withinLimits } from "./header.js";
import type { ProcessedImage } from "./pipeline.js";
import type { WorkerInput } from "./worker.js";

export type ImageErrorCode = "TOO_LARGE" | "UNREADABLE" | "TIMEOUT" | "BUSY";

export class ImageError extends Error {
  override name = "ImageError";
  constructor(readonly code: ImageErrorCode) {
    super(code);
  }
}

export interface ImageProcessorOptions {
  /** Time cap of one job (default 30 s). */
  timeoutMs?: number;
  /** Jobs at once (default 1: a 40 Mpx decode needs ≈ 0.5 ГБ of WASM memory). */
  concurrency?: number;
  /** Jobs waiting beyond `concurrency` (default 4); more → BUSY. */
  maxQueue?: number;
  /** JS heap cap of a worker, MB (default 256); pixel memory is bounded by the size limits. */
  heapMb?: number;
}

const BOOT = new URL("./worker-boot.mjs", import.meta.url);

export class ImageProcessor {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly o: Required<ImageProcessorOptions>;

  constructor(o: ImageProcessorOptions = {}) {
    this.o = { timeoutMs: 30_000, concurrency: 1, maxQueue: 4, heapMb: 256, ...o };
  }

  /** WebP variants of an uploaded image; ImageError on oversize, unreadable bytes, timeout or a full queue. */
  async process(bytes: Uint8Array, mime: ImageMime): Promise<ProcessedImage> {
    const size = imageSize(bytes, mime);
    if (!size) throw new ImageError("UNREADABLE");
    if (!withinLimits(size)) throw new ImageError("TOO_LARGE");
    await this.slot();
    try {
      return await this.run(bytes, mime);
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private async slot(): Promise<void> {
    if (this.running < this.o.concurrency) {
      this.running++;
      return;
    }
    if (this.waiting.length >= this.o.maxQueue) throw new ImageError("BUSY");
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
  }

  private async run(bytes: Uint8Array, mime: ImageMime): Promise<ProcessedImage> {
    const modules = await codecModules();
    const input: WorkerInput = { bytes, mime, modules };
    const worker = new Worker(BOOT, {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: this.o.heapMb, maxYoungGenerationSizeMb: 32 },
    });
    return new Promise<ProcessedImage>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        void worker.terminate();
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new ImageError("TIMEOUT"))), this.o.timeoutMs);
      worker.once("message", (m: { ok: true; image: ProcessedImage } | { ok: false }) =>
        finish(() => (m.ok ? resolve(m.image) : reject(new ImageError("UNREADABLE")))),
      );
      // Heap cap (ERR_WORKER_OUT_OF_MEMORY) or a codec crash.
      worker.once("error", () => finish(() => reject(new ImageError("UNREADABLE"))));
      worker.once("exit", () => finish(() => reject(new ImageError("UNREADABLE"))));
    });
  }
}

let shared: ImageProcessor | undefined;

/** The process-wide processor used by POST /api/files. */
export function imageProcessor(): ImageProcessor {
  shared ??= new ImageProcessor();
  return shared;
}
