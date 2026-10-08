// pdf → text through unpdf (MIT; the serverless build of PDF.js, Apache-2.0, without native modules). Text items are
// grouped into lines by their baseline; lines set noticeably larger than the body text become headings «# …»/«## …»,
// wrapped lines of one paragraph are joined, page numbers dropped. Scans have no text layer → EMPTY_TEXT upstream.
import { getDocumentProxy } from "unpdf";
import { BRIEF_FILE_LIMITS, BriefFileError, badFile } from "./types.js";

interface Item {
  str: string;
  x: number;
  y: number;
  size: number;
  eol: boolean;
}

interface PdfLine {
  text: string;
  y: number;
  size: number;
}

const LIST_MARK = /^(?:[-*•–—▪●◦]|\d{1,2}[.)]|[a-zа-я][)])\s/u;

/** Lines of one page in reading order (as the content stream gives them), items of a line joined by x. */
function pageLines(items: readonly Item[]): PdfLine[] {
  const lines: { items: Item[]; y: number; size: number }[] = [];
  let line: { items: Item[]; y: number; size: number } | null = null;
  let breakNext = false;
  for (const it of items) {
    const sameLine = line && !breakNext && Math.abs(it.y - line.y) <= Math.max(1, line.size * 0.4);
    if (!line || !sameLine) {
      line = { items: [], y: it.y, size: 0 };
      lines.push(line);
    }
    if (it.str) {
      line.items.push(it);
      line.size = Math.max(line.size, it.size);
    }
    breakNext = it.eol;
  }
  return lines
    .map((l) => ({
      text: l.items
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str)
        .join("")
        .replace(/\s+/g, " ")
        .trim(),
      y: l.y,
      size: l.size,
    }))
    .filter((l) => l.text && !/^(?:стр\.?\s*)?\d{1,4}(?:\s*(?:из|\/)\s*\d{1,4})?$/i.test(l.text));
}

/** Median font size weighted by characters: the body text. */
function bodySize(lines: readonly PdfLine[]): number {
  const sizes = lines
    .flatMap((l) => Array<number>(Math.min(l.text.length, 200)).fill(l.size))
    .sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)] ?? 0;
}

/** Lines of all pages → markdown-like text. */
export function pdfLinesToText(pages: readonly (readonly PdfLine[])[]): string {
  const body = bodySize(pages.flat());
  const blocks: string[] = [];
  let para: string | null = null;
  let prev: PdfLine | null = null;
  const flush = () => {
    if (para) blocks.push(para);
    para = null;
  };
  for (const lines of pages) {
    prev = null;
    for (const l of lines) {
      const heading = body > 0 && l.size >= body * 1.15 && l.text.length <= 120;
      if (heading) {
        flush();
        blocks.push(`${l.size >= body * 1.5 ? "#" : "##"} ${l.text}`);
        prev = null;
        continue;
      }
      const gap = prev ? Math.abs(prev.y - l.y) : 0;
      const continues =
        para !== null &&
        prev !== null &&
        !LIST_MARK.test(l.text) &&
        gap <= Math.max(prev.size, l.size) * 1.6 &&
        !/[.:;!?]$/.test(para);
      if (continues) {
        // A word hyphenated at the line end is joined back.
        para =
          /[а-яёa-z]-$/i.test(para as string) && /^[а-яёa-z]/.test(l.text)
            ? `${(para as string).slice(0, -1)}${l.text}`
            : `${para} ${l.text}`;
      } else {
        flush();
        para = l.text;
      }
      prev = l;
    }
    flush();
  }
  // List items stay together, other blocks are separated by a blank line.
  let out = "";
  for (const [i, b] of blocks.entries()) {
    if (i > 0) out += LIST_MARK.test(b) && LIST_MARK.test(blocks[i - 1] as string) ? "\n" : "\n\n";
    out += LIST_MARK.test(b) ? `- ${b.replace(LIST_MARK, "")}` : b;
  }
  return out;
}

/** Text of a pdf (at most BRIEF_FILE_LIMITS.pdfPages pages) and the page count. */
export async function readPdf(b: Uint8Array): Promise<{ text: string; pages: number }> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // A copy: PDF.js may transfer the buffer it is given.
    pdf = await getDocumentProxy(new Uint8Array(b), {
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    });
  } catch (e) {
    if ((e as { name?: string }).name === "PasswordException")
      throw new BriefFileError("ENCRYPTED", "Файл защищён паролем — снимите пароль и приложите ТЗ ещё раз.");
    throw badFile();
  }
  try {
    const pages: PdfLine[][] = [];
    const n = Math.min(pdf.numPages, BRIEF_FILE_LIMITS.pdfPages);
    for (let p = 1; p <= n; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items: Item[] = [];
      for (const it of content.items) {
        if (!("str" in it)) continue;
        const [a = 0, bb = 0, , , x = 0, y = 0] = it.transform as number[];
        items.push({ str: it.str, x, y, size: Math.hypot(a, bb), eol: it.hasEOL });
      }
      pages.push(pageLines(items));
      page.cleanup();
    }
    return { text: pdfLinesToText(pages), pages: pdf.numPages };
  } catch (e) {
    if (e instanceof BriefFileError) throw e;
    throw badFile();
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
}
