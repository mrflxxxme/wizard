// Generates a Y4M clip with a QR code for Chromium's --use-file-for-fake-video-capture (QrScanner acceptance).
import { writeFileSync } from "node:fs";
import { qrMatrix } from "../../src/qr/encode.js";

export function writeQrY4m(path: string, payload: string, frames = 10, w = 640, h = 480): void {
  const m = qrMatrix(payload);
  const n = m.length + 8;
  const cell = Math.floor((Math.min(w, h) - 40) / n);
  const ox = Math.floor((w - n * cell) / 2);
  const oy = Math.floor((h - n * cell) / 2);
  const y = Buffer.alloc(w * h, 235);
  for (let r = 0; r < m.length; r++)
    for (let c = 0; c < m.length; c++) {
      if (!m[r]?.[c]) continue;
      for (let dy = 0; dy < cell; dy++)
        for (let dx = 0; dx < cell; dx++) y[(oy + (r + 4) * cell + dy) * w + ox + (c + 4) * cell + dx] = 16;
    }
  const uv = Buffer.alloc((w / 2) * (h / 2) * 2, 128);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), y, uv]);
  const header = Buffer.from(`YUV4MPEG2 W${w} H${h} F10:1 Ip A1:1 C420jpeg\n`);
  writeFileSync(path, Buffer.concat([header, ...Array.from({ length: frames }, () => frame)]));
}
