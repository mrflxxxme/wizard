#!/usr/bin/env node
// Partner brief originals ↔ eval S3 bucket in RF (specs/quality/eval.yaml#briefs.set, L3-07). See tools/eval/README.md.
//   node tools/eval/partner-brief.mjs upload <original outside the repo> --partner=P01 --brief=<id>
//   node tools/eval/partner-brief.mjs fetch --brief=<id> [--out=<dir outside the repo>]
//   node tools/eval/partner-brief.mjs check     (CI guard: no tracked file equals a partner original)
// Exit codes: 0 ok, 1 error, 2 usage, 3 S3 not configured (EVAL_S3_* names are printed, never values).
import { pathToFileURL } from "node:url";
import { BRIEFS_DIR, loadBriefs } from "./lib/briefs.mjs";
import { fetchOriginal, originalsInRepo, trackedFiles, uploadOriginal } from "./lib/partner.mjs";
import { parseArgs } from "./lib/report.mjs";
import { s3Config } from "./lib/s3.mjs";

const USAGE = `Использование:
  node tools/eval/partner-brief.mjs upload <файл вне репозитория> --partner=P01 --brief=<id брифа>
  node tools/eval/partner-brief.mjs fetch --brief=<id брифа> [--out=<каталог вне репозитория>]
  node tools/eval/partner-brief.mjs check`;

/** Runs the CLI; returns the exit code. `io` is injectable for tests. */
export async function main(argv, { env = process.env, fetch, log = console.log, err = console.error } = {}) {
  const [cmd, ...rest] = argv;
  const positional = rest.filter((a) => !a.startsWith("--"));
  const args = parseArgs(rest.filter((a) => a.startsWith("--")));
  const str = (k) => (typeof args[k] === "string" ? args[k] : undefined);
  const briefsDir = str("briefs-dir") ?? BRIEFS_DIR;
  try {
    if (cmd === "check") {
      const leaks = originalsInRepo(loadBriefs(undefined, briefsDir), trackedFiles());
      if (leaks.length) {
        err(
          `Оригиналы партнёров в репозитории (L3-07) — удалите их из git и из истории:\n${leaks.join("\n")}`,
        );
        return 1;
      }
      log("Оригиналов партнёров в репозитории нет.");
      return 0;
    }
    if (cmd !== "upload" && cmd !== "fetch") {
      err(USAGE);
      return 2;
    }
    if (cmd === "upload" && (positional.length !== 1 || !str("partner") || !str("brief"))) {
      err(USAGE);
      return 2;
    }
    if (cmd === "fetch" && !str("brief")) {
      err(USAGE);
      return 2;
    }
    const s3 = s3Config(env);
    if (s3.missing) {
      err(`S3 eval не настроен: не задан ${s3.missing.join(", ")} (docs/ops/eval.md)`);
      return 3;
    }
    if (s3.error) {
      err(`Ошибка: ${s3.error}`);
      return 1;
    }
    const io = fetch ? { fetch } : {};
    if (cmd === "upload") {
      const block = await uploadOriginal({
        file: positional[0],
        ref: str("partner"),
        briefId: str("brief"),
        briefsDir,
        s3: s3.config,
        ...io,
      });
      log(
        `Загружено: s3://${s3.config.bucket}/${block.original.key} (${block.original.bytes} байт, sha256 ${block.original.sha256})`,
      );
      log(`В бриф ${str("brief")} записан блок partner; сам оригинал в репозиторий не попадает.`);
      return 0;
    }
    const file = await fetchOriginal({
      briefId: str("brief"),
      briefsDir,
      ...(str("out") ? { out: str("out") } : {}),
      s3: s3.config,
      ...io,
    });
    log(`Оригинал: ${file} (вне репозитория; удалите после работы)`);
    return 0;
  } catch (e) {
    err(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = await main(process.argv.slice(2));
