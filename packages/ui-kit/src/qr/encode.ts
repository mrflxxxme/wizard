// QR encoding for QrTicket: qrcode-generator (MIT) builds the matrix, we render a crisp SVG path.
import qrcode from "qrcode-generator";

export type QrMatrix = boolean[][];

/** Module matrix with error correction level M (ui-kit.yaml#components.QrTicket). */
export function qrMatrix(text: string): QrMatrix {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** SVG path of dark modules (one rect per horizontal run), shifted by the quiet zone. */
export function qrPath(m: QrMatrix, quiet = 4): string {
  const parts: string[] = [];
  m.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      parts.push(`M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`);
    }
  });
  return parts.join("");
}
