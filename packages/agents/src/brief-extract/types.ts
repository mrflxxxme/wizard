// Limits and errors of reading a ТЗ file (V3-04, D77 (8)). The file is read on the platform server in the RF; its text
// goes only to the T0 call brief_extract (data-boundary.yaml#call_types.brief_extract).

/** Limits of one ТЗ file: the upload, the unpacked docx, pages of a pdf, the text kept and its chunks for the model. */
export const BRIEF_FILE_LIMITS = {
  /** The file as uploaded (Composer and POST /systems/:id/brief/upload). */
  fileBytes: 10 * 1024 * 1024,
  /** All docx parts read, after inflating (zip-bomb guard). */
  unpackedBytes: 60 * 1024 * 1024,
  /** Pages of a pdf read for text; the rest is dropped like text over `textChars`. */
  pdfPages: 300,
  /** Characters of normalized text kept; longer text is cut (truncated: true). */
  textChars: 120_000,
  /** One model call reads at most this many characters (≈ 7 500 tokens at 3.2 characters per token). */
  chunkChars: 24_000,
} as const;

/** Formats recognized by the file signature (never by the extension). */
export const BRIEF_FILE_FORMATS = ["docx", "pdf", "text"] as const;
export type BriefFileFormat = (typeof BRIEF_FILE_FORMATS)[number];

export const BRIEF_FILE_ERROR_CODES = [
  "FILE_TOO_LARGE",
  "UNPACKED_TOO_LARGE",
  "UNSUPPORTED_FORMAT",
  "BAD_FILE",
  "ENCRYPTED",
  "EMPTY_TEXT",
] as const;
export type BriefFileErrorCode = (typeof BRIEF_FILE_ERROR_CODES)[number];

/** A ТЗ file that cannot be read; `message` is Russian and shown to the owner as is. */
export class BriefFileError extends Error {
  constructor(
    readonly code: BriefFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BriefFileError";
  }

  /** HTTP status of the upload route: 413 for size, 415 for a format, 400 otherwise. */
  get httpStatus(): 400 | 413 | 415 {
    if (this.code === "FILE_TOO_LARGE" || this.code === "UNPACKED_TOO_LARGE") return 413;
    if (this.code === "UNSUPPORTED_FORMAT") return 415;
    return 400;
  }
}

export const tooLarge = () =>
  new BriefFileError("FILE_TOO_LARGE", "Файл больше 10 МБ — сократите ТЗ или пришлите его частями.");
export const unpackedTooLarge = () =>
  new BriefFileError(
    "UNPACKED_TOO_LARGE",
    "Файл слишком большой после распаковки — пришлите ТЗ без вложенных картинок.",
  );
export const badFile = () =>
  new BriefFileError("BAD_FILE", "Файл повреждён или не читается — сохраните ТЗ заново и приложите ещё раз.");
export const unsupported = (hint = "") =>
  new BriefFileError(
    "UNSUPPORTED_FORMAT",
    `Подходят файлы .docx, .pdf, .md и .txt.${hint ? ` ${hint}` : ""}`,
  );
export const emptyText = (hint = "") =>
  new BriefFileError("EMPTY_TEXT", `В файле нет текста.${hint ? ` ${hint}` : ""}`);
