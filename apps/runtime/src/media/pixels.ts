// RGBA pixel operations of the image pipeline (pure, no codecs): EXIF orientation and area-average downscaling
// (alpha-premultiplied, streaming one source row at a time: memory O(target width)).

export interface Rgba {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Turns pixels upright for EXIF orientation 1–8 (5–8 swap width and height). */
export function orient(img: Rgba, orientation: number): Rgba {
  if (orientation <= 1 || orientation > 8) return img;
  const { width: w, height: h, data } = img;
  const swap = orientation >= 5;
  const W = swap ? h : w;
  const H = swap ? w : h;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sx: number;
      let sy: number;
      switch (orientation) {
        case 2:
          sx = w - 1 - x;
          sy = y;
          break;
        case 3:
          sx = w - 1 - x;
          sy = h - 1 - y;
          break;
        case 4:
          sx = x;
          sy = h - 1 - y;
          break;
        case 5:
          sx = y;
          sy = x;
          break;
        case 6:
          sx = y;
          sy = h - 1 - x;
          break;
        case 7:
          sx = w - 1 - y;
          sy = h - 1 - x;
          break;
        default:
          sx = w - 1 - y;
          sy = x;
      }
      const s = (sy * w + sx) * 4;
      const d = (y * W + x) * 4;
      out[d] = data[s] as number;
      out[d + 1] = data[s + 1] as number;
      out[d + 2] = data[s + 2] as number;
      out[d + 3] = data[s + 3] as number;
    }
  }
  return { data: out, width: W, height: H };
}

/** Area-average downscale to tw × th (tw ≤ width, th ≤ height). */
export function downscale(img: Rgba, tw: number, th: number): Rgba {
  const { width: w, height: h, data } = img;
  if (tw === w && th === h) return img;
  const sx = w / tw;
  const sy = h / th;
  const out = new Uint8ClampedArray(tw * th * 4);
  const row = new Float32Array(tw * 4);
  const acc = [new Float32Array(tw * 4), new Float32Array(tw * 4)] as const;
  // Horizontal contributions: for target column tx, source columns [i0, i1) with edge weights.
  const i0 = new Int32Array(tw);
  const i1 = new Int32Array(tw);
  const wFirst = new Float32Array(tw);
  const wLast = new Float32Array(tw);
  for (let tx = 0; tx < tw; tx++) {
    const a = tx * sx;
    const b = Math.min(w, a + sx);
    i0[tx] = Math.floor(a);
    i1[tx] = Math.ceil(b);
    wFirst[tx] = Math.min(Math.floor(a) + 1, b) - a;
    wLast[tx] = b - Math.max(Math.ceil(b) - 1, a);
  }
  const flush = (ty: number, buf: Float32Array) => {
    for (let tx = 0; tx < tw; tx++) {
      const k = tx * 4;
      const alpha = buf[k + 3] as number;
      const d = (ty * tw + tx) * 4;
      if (alpha > 0) {
        out[d] = (buf[k] as number) / alpha;
        out[d + 1] = (buf[k + 1] as number) / alpha;
        out[d + 2] = (buf[k + 2] as number) / alpha;
      }
      out[d + 3] = alpha;
    }
    buf.fill(0);
  };
  for (let y = 0; y < h; y++) {
    // Horizontal pass of source row y (premultiplied average over each target column).
    const base = y * w * 4;
    for (let tx = 0; tx < tw; tx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let al = 0;
      const first = i0[tx] as number;
      const last = (i1[tx] as number) - 1;
      for (let i = first; i <= last; i++) {
        const wt = i === first ? (wFirst[tx] as number) : i === last ? (wLast[tx] as number) : 1;
        const s = base + i * 4;
        const aw = ((data[s + 3] as number) / 255) * wt;
        r += (data[s] as number) * aw;
        g += (data[s + 1] as number) * aw;
        b += (data[s + 2] as number) * aw;
        al += (data[s + 3] as number) * wt;
      }
      const k = tx * 4;
      row[k] = r / sx;
      row[k + 1] = g / sx;
      row[k + 2] = b / sx;
      row[k + 3] = al / sx;
    }
    // Vertical: source row [y, y+1) spreads over target rows by overlap; alpha is stored as 0..255.
    const t0 = Math.floor(y / sy);
    const t1 = Math.min(th - 1, Math.floor((y + 1 - 1e-9) / sy));
    for (let ty = t0; ty <= t1; ty++) {
      const top = Math.max(y, ty * sy);
      const bottom = Math.min(y + 1, (ty + 1) * sy);
      const wt = (bottom - top) / sy;
      const buf = acc[ty % 2] as Float32Array;
      for (let k = 0; k < tw * 4; k += 4) {
        buf[k] = (buf[k] as number) + (row[k] as number) * wt * 255;
        buf[k + 1] = (buf[k + 1] as number) + (row[k + 1] as number) * wt * 255;
        buf[k + 2] = (buf[k + 2] as number) + (row[k + 2] as number) * wt * 255;
        buf[k + 3] = (buf[k + 3] as number) + (row[k + 3] as number) * wt;
      }
      if (y + 1 >= (ty + 1) * sy - 1e-9 || y === h - 1) flush(ty, buf);
    }
  }
  return { data: out, width: tw, height: th };
}
