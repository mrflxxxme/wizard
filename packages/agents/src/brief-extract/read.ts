// readBriefFile(bytes): the ТЗ file → normalized text. The format is taken from the signature, never from the name:
// %PDF → pdf, a zip with a Word document → docx, text bytes → md/txt (encodings: decode.ts). Old .doc, rtf, images and
// other binaries are refused with a Russian hint.
import { decodeText, looksLikeText, normalizeText, type TextEncodingName } from "./decode.js";
import { readDocx } from "./docx.js";
import { readPdf } from "./pdf.js";
import { BRIEF_FILE_LIMITS, type BriefFileFormat, emptyText, tooLarge, unsupported } from "./types.js";
import { isZip } from "./zip.js";

export interface BriefFileText {
  format: BriefFileFormat;
  /** Normalized text, at most BRIEF_FILE_LIMITS.textChars characters (markdown-like headings and lists for docx/pdf). */
  text: string;
  /** Characters of the whole normalized text before the cut. */
  chars: number;
  truncated: boolean;
  /** Pages of a pdf. */
  pages?: number;
  /** Encoding of a text file. */
  encoding?: TextEncodingName;
}

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) => sig.every((x, i) => b[at + i] === x);

/** «%PDF-» within the first KB (the format allows junk before the header). */
function isPdf(b: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(b.subarray(0, 1024));
  return head.includes("%PDF-");
}

/** Signature-based format of a ТЗ file; null — not a supported format. */
export function detectBriefFileFormat(b: Uint8Array): BriefFileFormat | null {
  if (b.length === 0) return null;
  if (isPdf(b)) return "pdf";
  if (isZip(b)) return "docx";
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0]) || startsWith(b, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return null;
  return looksLikeText(b) ? "text" : null;
}

function refuse(b: Uint8Array): never {
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0]))
    throw unsupported("Старый формат .doc не читается — сохраните файл как .docx или PDF.");
  if (startsWith(b, [0x7b, 0x5c, 0x72, 0x74, 0x66]))
    throw unsupported("Файл RTF сохраните как .docx или PDF.");
  const image =
    startsWith(b, [0x89, 0x50, 0x4e, 0x47]) ||
    startsWith(b, [0xff, 0xd8, 0xff]) ||
    startsWith(b, [0x47, 0x49, 0x46, 0x38]) ||
    (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) ||
    startsWith(b, [0x66, 0x74, 0x79, 0x70], 4);
  if (image) throw unsupported("Картинки и сканы не читаются — пришлите ТЗ текстом.");
  throw unsupported();
}

/** Cuts the text at the last paragraph break (or line break) before `max` characters. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const at = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("\n"));
  return (at > max * 0.5 ? head.slice(0, at) : head).trimEnd();
}

/** Reads a ТЗ file (≤ 10 МБ) into normalized text; BriefFileError with a Russian message when it cannot. */
export async function readBriefFile(bytes: Uint8Array): Promise<BriefFileText> {
  if (bytes.length > BRIEF_FILE_LIMITS.fileBytes) throw tooLarge();
  const format = detectBriefFileFormat(bytes);
  if (!format) {
    if (bytes.length === 0) throw emptyText();
    refuse(bytes);
  }
  let raw: string;
  let pages: number | undefined;
  let encoding: TextEncodingName | undefined;
  if (format === "pdf") ({ text: raw, pages } = await readPdf(bytes));
  else if (format === "docx") raw = readDocx(bytes, { left: BRIEF_FILE_LIMITS.unpackedBytes });
  else ({ text: raw, encoding } = decodeText(bytes));
  const text = normalizeText(raw);
  if (!/[\p{L}\p{N}]{2}/u.test(text))
    throw emptyText(format === "pdf" ? "Похоже, это скан — пришлите ТЗ в .docx или текстом." : "");
  const cut = cutText(text, BRIEF_FILE_LIMITS.textChars);
  return {
    format,
    text: cut,
    chars: text.length,
    truncated: cut.length < text.length,
    ...(pages !== undefined ? { pages } : {}),
    ...(encoding ? { encoding } : {}),
  };
}
