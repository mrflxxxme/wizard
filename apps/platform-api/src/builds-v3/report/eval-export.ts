// V5-10: the home-page snapshots of a build report in the layout of the evaluation stand (tools/eval/v5):
// <dir>/<brief id>/{1440,390}.png. The report keeps JPEG; the stand reads PNG (the format must not tell the source).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileStorage } from "@wizard/runtime";
import { reportFile } from "./store.js";
import type { BuildReport } from "./types.js";

/** Re-encodes an image to PNG (the CLI does it in Chromium). */
export type ToPng = (data: Uint8Array, mime: string) => Promise<Uint8Array>;

/** Writes <outDir>/<briefId>/{1440,390}.png of the report's home page; returns the widths written. */
export async function exportEvalShots(
  files: FileStorage,
  report: BuildReport,
  briefId: string,
  outDir: string,
  toPng: ToPng,
): Promise<number[]> {
  if (!/^[\w.-]+$/.test(briefId)) throw new Error("brief id: латиница, цифры, - _ .");
  const dir = join(outDir, briefId);
  await mkdir(dir, { recursive: true });
  const written: number[] = [];
  for (const width of [1440, 390] as const) {
    const shot = report.shots.find((s) => s.width === width && (s.route ?? "/") === "/");
    const f = shot ? await reportFile(files, report, shot.key) : null;
    if (!shot || !f) continue;
    await writeFile(join(dir, `${width}.png`), await toPng(f.data, f.mime));
    written.push(width);
  }
  return written;
}
