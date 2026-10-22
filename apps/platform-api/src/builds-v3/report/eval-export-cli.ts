// V5-10: snapshots of a build's report for the evaluation stand. Usage (the storage as the platform's: WIZARD_FILES_STORAGE):
//   pnpm --filter @wizard/platform-api eval-shots <run id> <brief id> <out dir>
// then: node tools/eval/v5/cli.mjs run --wizard-shots <out dir>
import { chromium } from "@playwright/test";
import { loadConfig } from "../../config.js";
import { exportEvalShots, type ToPng } from "./eval-export.js";
import { loadBuildReport, reportStorage } from "./index.js";

async function main(argv: string[]): Promise<string> {
  const [runId, briefId, outDir] = argv;
  if (!runId || !briefId || !outDir) throw new Error("eval-shots <run id> <brief id> <out dir>");
  const files = reportStorage(loadConfig());
  const report = await loadBuildReport(files, runId);
  if (!report) throw new Error(`отчёта прогона ${runId} нет`);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const toPng: ToPng = async (data, mime) => {
      const b64 = await page.evaluate(
        async ([src]) => {
          const img = new Image();
          img.src = src as string;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext("2d")?.drawImage(img, 0, 0);
          return c.toDataURL("image/png").split(",")[1] as string;
        },
        [`data:${mime};base64,${Buffer.from(data).toString("base64")}`],
      );
      return new Uint8Array(Buffer.from(b64, "base64"));
    };
    const done = await exportEvalShots(files, report, briefId, outDir, toPng);
    return done.length ? `снимки ${done.join(", ")} → ${outDir}/${briefId}` : "в отчёте нет снимков главной";
  } finally {
    await browser.close();
  }
}

main(process.argv.slice(2)).then(
  (m) => console.log(m),
  (e: unknown) => {
    console.error(String((e as Error)?.message ?? e));
    process.exit(1);
  },
);
