// M1 holdout corpus (data-boundary.yaml#detectors.quality.holdout, L3-05): ≥ 300 hand-labelled lines from real
// wording, stored in RF (S3 eval), never in the repository. Run: WIZARD_PII_HOLDOUT=/path/holdout.jsonl pnpm vitest
// run packages/pii/test/holdout.test.ts. Line format = corpus.ru.jsonl: {id, text, spans: [{kind, start, end}]}.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { detect, type Kind } from "../src/index.js";

const PATH = process.env.WIZARD_PII_HOLDOUT;
const THRESHOLDS = { recall: 0.95, precision: 0.9 }; // thresholds.M0 — the M1 criterion
/** Kinds added for L3-05; each must be present in the holdout. */
const M1_KINDS: readonly Kind[] = [
  "phone_intl",
  "social_handle",
  "ogrnip",
  "car_plate_ru",
  "person_name_latin",
];

interface Line {
  id: string;
  text: string;
  spans: { kind: Kind; start: number; end: number }[];
}

export function evaluateHoldout(lines: readonly Line[]) {
  const per = new Map<string, { tp: number; fp: number; fn: number }>();
  const stat = (k: string) => {
    let s = per.get(k);
    if (!s) {
      s = { tp: 0, fp: 0, fn: 0 };
      per.set(k, s);
    }
    return s;
  };
  const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
    a.start < b.end && b.start < a.end;
  for (const line of lines) {
    const found = detect(line.text);
    for (const g of line.spans)
      stat(g.kind)[found.some((f) => f.kind === g.kind && overlaps(f, g)) ? "tp" : "fn"]++;
    for (const f of found)
      if (!line.spans.some((g) => g.kind === f.kind && overlaps(f, g))) stat(f.kind).fp++;
  }
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const s of per.values()) {
    tp += s.tp;
    fp += s.fp;
    fn += s.fn;
  }
  return { per, recall: tp + fn ? tp / (tp + fn) : 1, precision: tp + fp ? tp / (tp + fp) : 1 };
}

describe.skipIf(!PATH)("holdout corpus (M1, stored in RF)", () => {
  test("≥ 300 lines; recall ≥ 0.95, precision ≥ 0.90; the L3-05 kinds are covered", () => {
    const file = resolve(PATH as string);
    expect(existsSync(file), file).toBe(true);
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Line);
    expect(lines.length).toBeGreaterThanOrEqual(300);
    const { per, recall, precision } = evaluateHoldout(lines);
    // Only aggregate numbers are printed: holdout text must not end up in CI logs.
    console.log(
      [...per.entries()]
        .sort()
        .map(([k, s]) => `${k.padEnd(18)} tp=${s.tp} fp=${s.fp} fn=${s.fn}`)
        .concat(`TOTAL R=${recall.toFixed(3)} P=${precision.toFixed(3)}`)
        .join("\n"),
    );
    for (const k of M1_KINDS) expect((per.get(k)?.tp ?? 0) + (per.get(k)?.fn ?? 0), k).toBeGreaterThan(0);
    expect(recall).toBeGreaterThanOrEqual(THRESHOLDS.recall);
    expect(precision).toBeGreaterThanOrEqual(THRESHOLDS.precision);
  });
});

describe("holdout evaluator", () => {
  test("counts tp/fp/fn by overlapping spans of the same kind", () => {
    const text = "Звоните +375 29 123-45-67, спросить Ивана";
    const r = evaluateHoldout([
      { id: "h1", text, spans: [{ kind: "phone_intl", start: 8, end: 25 }] },
      { id: "h2", text: "ничего нет", spans: [{ kind: "ogrnip", start: 0, end: 6 }] },
    ]);
    expect(r.per.get("phone_intl")).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(r.per.get("ogrnip")).toEqual({ tp: 0, fp: 0, fn: 1 });
    expect(r.recall).toBeLessThan(1);
  });
});
