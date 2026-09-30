// Logo upload sanitising (api.yaml uploadAsset, security/isolation.yaml#user_files.logo): type by signature,
// PNG decoded and re-encoded (≤ 512×512, metadata dropped); WebP rebuilt with image chunks only (see impl-notes M0-15).
import { PNG } from "pngjs";
import { ApiError } from "../errors.js";

export const MAX_LOGO_BYTES = 1_048_576;
export const MAX_SIDE = 512;

export interface Logo {
  ext: "png" | "webp";
  data: Buffer;
  width: number;
  height: number;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniff(buf: Buffer): "png" | "webp" | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return "png";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP")
    return "webp";
  return null;
}

function downscale(src: PNG, w: number, h: number): PNG {
  const out = new PNG({ width: w, height: h });
  const sx = src.width / w;
  const sy = src.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          for (let k = 0; k < 4; k++) acc[k] = (acc[k] as number) + (src.data[i + k] as number);
          n++;
        }
      }
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out.data[o + k] = Math.round((acc[k] as number) / n);
    }
  }
  return out;
}

function recodePng(buf: Buffer): Logo {
  let img: PNG;
  try {
    img = PNG.sync.read(buf);
  } catch {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "Файл повреждён или это не PNG");
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = scale < 1 ? downscale(img, w, h) : img;
  const fresh = new PNG({ width: w, height: h });
  out.data.copy(fresh.data);
  return { ext: "png", data: PNG.sync.write(fresh), width: w, height: h };
}

const KEEP_WEBP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH"]);

function webpSize(fourcc: string, d: Buffer): [number, number] | null {
  if (fourcc === "VP8X" && d.length >= 10) return [d.readUIntLE(4, 3) + 1, d.readUIntLE(7, 3) + 1];
  if (fourcc === "VP8L" && d.length >= 5 && d[0] === 0x2f) {
    const b = d.readUInt32LE(1);
    return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1];
  }
  if (fourcc === "VP8 " && d.length >= 10 && d[3] === 0x9d && d[4] === 0x01 && d[5] === 0x2a)
    return [d.readUInt16LE(6) & 0x3fff, d.readUInt16LE(8) & 0x3fff];
  return null;
}

function sanitizeWebp(buf: Buffer): Logo {
  const bad = () => new ApiError("UNSUPPORTED_MEDIA_TYPE", "Файл повреждён или это не WebP");
  const chunks: Buffer[] = [];
  let size: [number, number] | null = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const fourcc = buf.toString("latin1", off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    const end = off + 8 + len;
    if (end > buf.length) throw bad();
    const data = Buffer.from(buf.subarray(off + 8, end));
    if (fourcc === "ANIM" || fourcc === "ANMF")
      throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "Анимированный логотип не поддерживается");
    if (KEEP_WEBP.has(fourcc)) {
      if (fourcc === "VP8X") data[0] = (data[0] as number) & 0x10; // keep only the alpha flag
      const s = webpSize(fourcc, data);
      if (s && (!size || fourcc === "VP8X")) size = s;
      const head = Buffer.alloc(8);
      head.write(fourcc, 0, "latin1");
      head.writeUInt32LE(len, 4);
      chunks.push(head, data, len % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0));
    }
    off = end + (len % 2);
  }
  if (!size) throw bad();
  if (size[0] > MAX_SIDE || size[1] > MAX_SIDE)
    throw new ApiError("PAYLOAD_TOO_LARGE", "Логотип WebP больше 512×512 — уменьшите его или загрузите PNG");
  const body = Buffer.concat(chunks);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write("WEBP", 8, "latin1");
  return { ext: "webp", data: Buffer.concat([riff, body]), width: size[0], height: size[1] };
}

export function processLogo(buf: Buffer): Logo {
  if (buf.length > MAX_LOGO_BYTES) throw new ApiError("PAYLOAD_TOO_LARGE", "Логотип больше 1 МБ");
  const kind = sniff(buf);
  if (kind === "png") return recodePng(buf);
  if (kind === "webp") return sanitizeWebp(buf);
  throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "Логотип должен быть PNG или WebP");
}
