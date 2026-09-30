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

/**
 * Best of `runs` of the time scrub spends on the CPU, in ms. Each run is min(wall, process CPU): wall clock grows
 * when parallel test workers or Chromium preempt this process, process CPU grows with concurrent GC helper threads,
 * and scrub's own single-thread CPU time is ≤ both. So the budget is checked against the work itself, not against
 * the load of the machine (FU-3), and a real regression of scrub still exceeds it.
 */
function best(fn: () => void, runs: number): number {
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    fn();
    const wall = performance.now() - t0;
    const cpu = process.cpuUsage(c0);
    ts.push(Math.min(wall, (cpu.user + cpu.system) / 1000));
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
