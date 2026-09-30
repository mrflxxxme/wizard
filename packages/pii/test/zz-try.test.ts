import { readFileSync } from "node:fs";
import { test } from "vitest";
import { detectNames } from "../src/detectors/names.js";
test("perf", () => {
  const lines = readFileSync("packages/pii/test/corpus.ru.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).text);
  let big = "";
  while (big.length < 1_000_000) big += `${lines.join("\n")}\n`;
  detectNames(big.slice(0, 5000));
  const res: Record<string, RegExp> = {
    cap: /(?<!\p{L})\p{Lu}\p{L}*(?:-\p{L}+)*/gu,
    after: /(?<![\p{L}])([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?|[A-Z][a-z]+)[ \xa0]+([А-ЯЁA-Z])\.(?:[ \xa0]?([А-ЯЁA-Z])\.)?/gu,
    before: /(?<![\p{L}])([А-ЯЁA-Z])\.[ \xa0]?(?:([А-ЯЁA-Z])\.[ \xa0]?)?([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?|[A-Z][a-z]+)(?![\p{L}])/gu,
  };
  for (const [n, r] of Object.entries(res)) {
    const t0 = performance.now();
    let c = 0;
    for (const _ of big.matchAll(r)) c++;
    console.log(n, Math.round(performance.now() - t0), c);
  }
  const t0 = performance.now();
  detectNames(big);
  console.log("names", Math.round(performance.now() - t0));
});
