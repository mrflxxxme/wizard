// Input tokens of a call estimated before it is made (models.yaml#call_policy.context_too_long; the upper bound of the
// cost in @wizard/agents budget.ts). Text: characters / 3.2 of the messages and tools. Attachments are not text: their
// base64 is never counted; an image counts by its size and the model's rule (models.yaml#models[].image — one token per
// px × px square, capped per image), a PDF by its pages. Without a readable size or a rule of the model — a
// conservative estimate (DEFAULT_IMAGE_RULE, IMAGE_FALLBACK_TOKENS), still far below the base64 length.
import type { ModelDef } from "./registry.js";
import type { LlmAttachment, LlmMessage, LlmTool } from "./types.js";

/** How a vision model reads an image: one token per px × px square, at most `max` tokens per image. */
export interface ImageTokenRule {
  px: number;
  max: number;
}

/** A model without a rule (an own OpenAI-compatible server, a text model): the smallest patch of the catalog. */
export const DEFAULT_IMAGE_RULE: Readonly<ImageTokenRule> = { px: 28, max: 16384 };
/** An image whose size cannot be read (a format we do not parse, cut bytes): ≈ a 1792×1792 picture at 28 px. */
export const IMAGE_FALLBACK_TOKENS = 4096;
/** Tokens a PDF page is read as when the provider renders it (≈ A4 at 150 dpi, 28 px patches). */
export const PDF_PAGE_TOKENS = 2835;
/** Markers around an image in the prompt (vision start/end). */
const IMAGE_OVERHEAD = 2;

/** models.yaml#call_policy.context_too_long: characters / 3.2. */
export function estimateTokens(value: unknown): number {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(s.length / 3.2);
}

/** Tokens of a width × height image by the rule (the provider scales a larger one down to `max`). */
export function imageTokens(
  width: number,
  height: number,
  rule: ImageTokenRule = DEFAULT_IMAGE_RULE,
): number {
  const n = Math.ceil(Math.max(1, width) / rule.px) * Math.ceil(Math.max(1, height) / rule.px);
  return Math.min(rule.max, Math.max(4, n)) + IMAGE_OVERHEAD;
}

const B64_HEAD = 96 * 1024;

/** Bytes of the base64 head (enough for the headers we read), or of the whole data when `all`. */
function bytesOf(data: string, all = false): Buffer {
  const s = all ? data : data.slice(0, B64_HEAD - (B64_HEAD % 4));
  return Buffer.from(s, "base64");
}

function pngSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString("latin1", 12, 16) !== "IHDR")
    return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] as number;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (SOF.has(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    if (marker === 0xda || marker === 0xd9) return null;
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function webpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP")
    return null;
  const kind = b.toString("latin1", 12, 16);
  if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (kind === "VP8L") {
    const v = b.readUInt32LE(21);
    return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) };
  }
  if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  return null;
}

/** Width and height of an image attachment from its header (PNG, JPEG, WebP); null — unreadable. */
export function imageSize(a: Pick<LlmAttachment, "mime" | "data">): { width: number; height: number } | null {
  if (a.data.startsWith("sha256:")) return null;
  const read = (b: Buffer) =>
    a.mime === "image/png" ? pngSize(b) : a.mime === "image/webp" ? webpSize(b) : jpegSize(b);
  // A JPEG may carry big EXIF/ICC segments before its frame header: then the whole file is read.
  const size = read(bytesOf(a.data)) ?? (a.data.length > B64_HEAD ? read(bytesOf(a.data, true)) : null);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** Pages of a PDF attachment (page objects in its bytes; at least 1). */
function pdfPages(data: string): number {
  if (data.startsWith("sha256:")) return 1;
  const text = Buffer.from(data, "base64").toString("latin1");
  return Math.max(1, (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length);
}

/** Tokens one attachment is read as by a model with `rule`. */
export function attachmentTokens(a: LlmAttachment, rule: ImageTokenRule = DEFAULT_IMAGE_RULE): number {
  if (a.mime === "application/pdf") return pdfPages(a.data) * PDF_PAGE_TOKENS;
  const size = imageSize(a);
  return size
    ? imageTokens(size.width, size.height, rule)
    : Math.min(rule.max, IMAGE_FALLBACK_TOKENS) + IMAGE_OVERHEAD;
}

const attachmentsOf = (messages: readonly LlmMessage[]): LlmAttachment[] =>
  messages.flatMap((m) => (m.role === "user" ? (m.attachments ?? []) : []));

/** The messages with the attachment bytes left out (their text part: mime and name stay). */
function withoutBytes(messages: readonly LlmMessage[]): LlmMessage[] {
  return messages.map((m) =>
    m.role === "user" && m.attachments?.length
      ? { ...m, attachments: m.attachments.map((a) => ({ ...a, data: "" })) }
      : m,
  );
}

/**
 * Input tokens of a call for one model: the text of the messages and tools (characters / 3.2) plus the attachments by
 * the model's image rule. A call without attachments is estimated exactly as before (the whole JSON / 3.2).
 */
export function estimateInputTokens(
  messages: readonly LlmMessage[],
  tools: readonly LlmTool[] = [],
  model?: Pick<ModelDef, "image"> | null,
): number {
  const atts = attachmentsOf(messages);
  if (atts.length === 0) return estimateTokens(messages) + estimateTokens(tools);
  const rule = model?.image ?? DEFAULT_IMAGE_RULE;
  return (
    estimateTokens(withoutBytes(messages)) +
    estimateTokens(tools) +
    atts.reduce((s, a) => s + attachmentTokens(a, rule), 0)
  );
}
