// Type of an uploaded file by its signature (magic bytes), never by name or Content-Type (runtime.yaml#files.upload,
// security/isolation.yaml#user_files). Everything outside the allowlist — SVG, HTML, XML, JS, archives — is refused.

export const FILE_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type FileMime = (typeof FILE_MIMES)[number];

/** runtime.yaml#files.upload: ≤ 10 МБ. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const FILE_EXT: Readonly<Record<FileMime, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) =>
  b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** Allowlisted MIME type of the bytes, or null (→ 415). */
export function sniffMime(b: Uint8Array): FileMime | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, PNG)) return "image/png";
  if (b.length >= 16 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 8 && ascii(b, 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

/** Display name of an upload: base name only, no control or path characters, ≤ 120 chars; default by type. */
export function safeFileName(raw: unknown, mime: FileMime): string {
  const base = typeof raw === "string" ? (raw.split(/[\\/]/).pop() ?? "") : "";
  const clean = [...base.normalize("NFC")]
    .filter((ch) => {
      const c = ch.codePointAt(0) as number;
      const control = c < 0x20 || c === 0x7f;
      const bidi = (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
      return !control && !bidi && !'<>:"|?*'.includes(ch);
    })
    .join("")
    .trim()
    .slice(0, 120);
  return clean && clean !== "." && clean !== ".." ? clean : `файл.${FILE_EXT[mime]}`;
}

/** Content-Disposition: attachment with an ASCII fallback and the UTF-8 name (RFC 6266/5987). */
export function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_") || "file";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
