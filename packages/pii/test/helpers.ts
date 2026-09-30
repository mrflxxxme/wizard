import { type DetectOptions, detect } from "../src/index.js";

/** Findings as [kind, matched text] pairs, for readable assertions. */
export function found(text: string, options?: DetectOptions): Array<[string, string]> {
  return detect(text, options).map((f) => [f.kind, text.slice(f.start, f.end)]);
}

export function kindsOf(text: string, options?: DetectOptions): string[] {
  return detect(text, options).map((f) => f.kind);
}

/** Replaces the digit at `index` with a different one. */
export function mutateDigit(num: string, index: number): string {
  const d = Number(num[index]);
  return num.slice(0, index) + String((d + 1) % 10) + num.slice(index + 1);
}
