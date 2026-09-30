import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { scrub } from "../src/index.js";
import { CORPUS_PATH } from "./gen-corpus.js";

// data-boundary.yaml#detectors.quality.perf: scrub 20 KB ≤ 20 ms; task M0-05: ≥ 1 MB/s. Text is PII-dense (the corpus
// repeated), which is the worst case; see scrub.bench.ts for the benchmark.
const lines = readFileSync(CORPUS_PATH, "utf8")
  .trim()
  .split("\n")
  .map((l) => (JSON.parse(l) as { text: string }).text)
  .join("\n");
const text = (n: number) => lines.repeat(Math.ceil(n / lines.length)).slice(0, n);

/** Best of `runs`: robust to other test files running in parallel workers. */
function best(fn: () => void, runs: number): number {
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return Math.min(...ts);
}

test("scrub: 20 KB ≤ 20 ms and ≥ 1 MB/s", () => {
  const small = text(20_000);
  const big = text(1_000_000);
  scrub(small); // warm-up (dictionary build, JIT)
  expect(best(() => scrub(small), 15)).toBeLessThanOrEqual(20);
  expect(best(() => scrub(big), 3)).toBeLessThanOrEqual(1000);
});
