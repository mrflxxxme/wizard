import { readFileSync } from "node:fs";
import { bench, describe } from "vitest";
import { scrub } from "../src/index.js";
import { CORPUS_PATH } from "./gen-corpus.js";

// Run: pnpm vitest bench packages/pii  (data-boundary.yaml#detectors.quality.perf)
const corpus = readFileSync(CORPUS_PATH, "utf8")
  .trim()
  .split("\n")
  .map((l) => (JSON.parse(l) as { text: string }).text)
  .join("\n");
const dense20k = corpus.repeat(Math.ceil(20_000 / corpus.length)).slice(0, 20_000);
const prose = "Нужна система записи клиентов в салон: администратор видит все записи, мастер — только свои. ";
const prose20k = prose.repeat(Math.ceil(20_000 / prose.length)).slice(0, 20_000);

describe("scrub 20 KB", () => {
  bench("PII-dense corpus text", () => {
    scrub(dense20k);
  });
  bench("brief prose without PII", () => {
    scrub(prose20k);
  });
});
