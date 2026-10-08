// Plain-text ТЗ (md, txt) → a normalized string: BOM (UTF-8, UTF-16LE/BE), BOM-less UTF-16, strict UTF-8, otherwise the
// Cyrillic 8-bit code page that reads as more lowercase letters (Windows-1251 or KOI8-R). Line ends, NBSP and control
// characters are normalized here for every format.

const CYR_LOWER = /[а-яё]/g;
const CYR_UPPER = /[А-ЯЁ]/g;

const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;

/** UTF-16 without a BOM: one of the two byte lanes is mostly zero (Latin text) — the other carries the text. */
function utf16Lane(b: Uint8Array): "utf-16le" | "utf-16be" | null {
  const n = Math.min(b.length - (b.length % 2), 4096);
  if (n < 4) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (b[i] === 0) evenZero++;
    if (b[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  if (oddZero > pairs * 0.3 && evenZero < pairs * 0.05) return "utf-16le";
  if (evenZero > pairs * 0.3 && oddZero < pairs * 0.05) return "utf-16be";
  return null;
}

/** True when the bytes look like text: no NUL outside UTF-16, few control characters. */
export function looksLikeText(b: Uint8Array): boolean {
  if (b.length === 0) return false;
  if (hasBom(b) || utf16Lane(b)) return true;
  const n = Math.min(b.length, 8192);
  let control = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i] as number;
    if (c === 0) return false;
    if (c < 0x09 || (c > 0x0d && c < 0x20)) control++;
  }
  return control <= n * 0.01;
}

function hasBom(b: Uint8Array): boolean {
  return (
    (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) ||
    (b[0] === 0xff && b[1] === 0xfe) ||
    (b[0] === 0xfe && b[1] === 0xff)
  );
}

/** Name of the encoding the text was read in (reported back with the extraction). */
export type TextEncodingName = "utf-8" | "utf-16le" | "utf-16be" | "windows-1251" | "koi8-r";

/** Decodes text bytes; returns the string (not yet normalized) and the encoding that was used. */
export function decodeText(b: Uint8Array): { text: string; encoding: TextEncodingName } {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)
    return { text: new TextDecoder("utf-8").decode(b.subarray(3)), encoding: "utf-8" };
  if (b[0] === 0xff && b[1] === 0xfe)
    return { text: new TextDecoder("utf-16le").decode(b.subarray(2)), encoding: "utf-16le" };
  if (b[0] === 0xfe && b[1] === 0xff)
    return { text: new TextDecoder("utf-16be").decode(b.subarray(2)), encoding: "utf-16be" };
  const lane = utf16Lane(b);
  if (lane) return { text: new TextDecoder(lane).decode(b), encoding: lane };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(b), encoding: "utf-8" };
  } catch {
    // Not UTF-8: a Russian 8-bit code page. In KOI8-R lowercase letters sit where Windows-1251 has capitals, so the
    // reading with more lowercase than capital Cyrillic letters is the right one.
    const cp1251 = new TextDecoder("windows-1251").decode(b);
    const koi8 = new TextDecoder("koi8-r").decode(b);
    const score = (s: string) => count(s, CYR_LOWER) - count(s, CYR_UPPER);
    return score(koi8) > score(cp1251)
      ? { text: koi8, encoding: "koi8-r" }
      : { text: cp1251, encoding: "windows-1251" };
  }
}

/**
 * Normalization shared by all formats: NFC, LF line ends, NBSP and other spaces → space, soft hyphens and control
 * characters removed, trailing spaces trimmed, at most one blank line in a row.
 */
export function normalizeText(s: string): string {
  return (
    s
      .normalize("NFC")
      .replace(/^﻿/, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[    - 　]/g, " ")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters of broken files are dropped on purpose
      .replace(/[­​-‍⁠\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
