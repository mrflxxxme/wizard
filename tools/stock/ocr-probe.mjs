#!/usr/bin/env node
// V4-33 (probe, not merged): can a text detector without an LLM pre-flag the photo library? Tesseract (Apache-2.0,
// rus+eng, apt on the runner) reads a sample of library photos — every photo glm already flagged as text in the given
// shards and random unflagged ones up to --per photos a shard — at 960 px; a photo counts as text when a word of 3+
// letters is read with confidence ≥ T and is tall enough to be seen (≥ H of the frame height). Prints the agreement
// with the glm flags for a few (T, H), the seconds per photo, and writes results.json and the 480 px copies of every
// photo OCR or glm marks into --out for a person to label (glm flags only the photos it saw: «unflagged» is not «no text»).
// Env: the storage as for fill.mjs (WIZARD_FILES_STORAGE=s3, WIZARD_S3_*); counts and file ids only in the log.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { annotation, registerTsx, scrubKeys } from "../deploy/stock-ci.mjs";
import { storageEnv } from "./fill.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const TITLE = "Детектор текста без LLM";

/** Shards where glm flags exist (photo_pick saw their candidates in the surveys). */
export const SHARDS = ["cafe", "barber", "optics", "driving", "languages"];

/** The thresholds the summary compares: word confidence, word height as a share of the frame. */
export const GRID = [
  { conf: 60, height: 0.02 },
  { conf: 70, height: 0.02 },
  { conf: 80, height: 0.02 },
  { conf: 70, height: 0.035 },
  { conf: 80, height: 0.035 },
  { conf: 85, height: 0.05 },
];

const LETTERS = /[A-Za-zА-Яа-яЁё]/g;

/** The words of tesseract's TSV (level 5) with confidence, height and text. */
export function tsvWords(tsv) {
  const words = [];
  for (const line of tsv.split("\n").slice(1)) {
    const c = line.split("\t");
    if (c.length < 12 || c[0] !== "5") continue;
    const text = c[11].trim();
    const conf = Number(c[10]);
    if (!text || !(conf >= 0)) continue;
    words.push({ text, conf, height: Number(c[9]) });
  }
  return words;
}

/** true — the photo shows text at (conf, height): a word of 3+ letters, confident and large enough. */
export function hasText(words, frameHeight, t) {
  return words.some(
    (w) => (w.text.match(LETTERS) ?? []).length >= 3 && w.conf >= t.conf && w.height >= t.height * frameHeight,
  );
}

/** Seeded shuffle (the same sample every run). */
function shuffled(list, seed) {
  const a = [...list];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const argOf = (argv, name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};

export async function main(argv, { env = process.env, log = console.log } = {}) {
  const secrets = { s3id: env.WIZARD_S3_ACCESS_KEY_ID, s3secret: env.WIZARD_S3_SECRET_ACCESS_KEY };
  const out = (line) => log(scrubKeys(line, secrets));
  const dir = argOf(argv, "out") ?? join(env.RUNNER_TEMP || join(ROOT, ".data"), "ocr-probe");
  const per = Number(argOf(argv, "per") ?? 100);
  const shards = (argOf(argv, "shards") ?? SHARDS.join(",")).split(",").filter(Boolean);
  const senv = await storageEnv(env);
  await registerTsx();
  const at = (p) => import(pathToFileURL(join(ROOT, p)).href);
  const [S, rtStorage, rtLibrary] = await Promise.all([
    at("packages/agents/src/stock/index.ts"),
    at("apps/runtime/src/files/storage.ts"),
    at("apps/runtime/src/files/photo-library.ts"),
  ]);
  const storage = rtStorage.createFileStorage(senv, { defaultDir: join(ROOT, ".data", "files") });
  const objects = S.storageObjects(storage, (n) => `${rtLibrary.PHOTO_LIBRARY_PREFIX}/${rtLibrary.libraryPhotoId(n)}`);
  const flagged = new Set((await S.readFlags(objects)).text);
  const tmp = join(dir, "tmp");
  mkdirSync(tmp, { recursive: true });
  mkdirSync(join(dir, "label"), { recursive: true });

  const sample = [];
  for (const slug of shards) {
    const shard = await S.readShard(objects, slug);
    if (!shard) {
      out(annotation("warning", TITLE, `${slug}: шарда нет`));
      continue;
    }
    const withFlag = shard.entries.filter((e) => flagged.has(e.file));
    const rest = shuffled(
      shard.entries.filter((e) => !flagged.has(e.file)),
      slug.length * 7919,
    ).slice(0, Math.max(0, per - withFlag.length));
    for (const e of [...withFlag, ...rest]) sample.push({ slug, file: e.file, flag: flagged.has(e.file) });
    out(`${slug}: фото ${shard.entries.length}, с флагом glm ${withFlag.length}, в выборке ${withFlag.length + rest.length}`);
  }

  const results = [];
  let ocrMs = 0;
  for (const s of sample) {
    const big = await rtLibrary.libraryPhotoFile(storage, s.file, 960).catch(() => null);
    if (!big) continue;
    const webp = join(tmp, `${s.file}.webp`);
    const png = join(tmp, `${s.file}.png`);
    writeFileSync(webp, big.body);
    try {
      execFileSync("dwebp", ["-quiet", webp, "-o", png]);
      const dims = execFileSync("webpinfo", [webp]).toString();
      const height = Number(/Height:\s*(\d+)/.exec(dims)?.[1] ?? 0);
      const t0 = Date.now();
      const tsv = execFileSync("tesseract", [png, "stdout", "-l", "rus+eng", "--psm", "11", "tsv"], {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      const ms = Date.now() - t0;
      ocrMs += ms;
      const words = tsvWords(tsv).filter((w) => (w.text.match(LETTERS) ?? []).length >= 3);
      results.push({ ...s, height, ms, words });
    } catch (e) {
      out(annotation("warning", TITLE, `${s.file.slice(0, 8)}: ${e instanceof Error ? e.message.slice(0, 80) : "ошибка"}`));
    }
  }
  writeFileSync(join(dir, "results.json"), JSON.stringify(results));

  const lines = [
    `## ${TITLE}`,
    "",
    `Фото: ${results.length}, с флагом glm: ${results.filter((r) => r.flag).length}; tesseract в среднем ${(ocrMs / Math.max(1, results.length) / 1000).toFixed(2)} с на фото (960 px, rus+eng, psm 11)`,
    "",
    "| Порог (conf, высота) | Текст по OCR | Совпало с флагом glm | Флаг glm пропущен | OCR без флага glm |",
    "|---|---|---|---|---|",
  ];
  for (const t of GRID) {
    const pos = results.filter((r) => hasText(r.words, r.height, t));
    const tp = pos.filter((r) => r.flag).length;
    const fn = results.filter((r) => r.flag && !hasText(r.words, r.height, t)).length;
    lines.push(`| ${t.conf}, ${t.height} | ${pos.length} | ${tp} | ${fn} | ${pos.length - tp} |`);
  }
  lines.push("");
  out(lines.join("\n"));
  if (env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
  // The 480 px copies a person labels: every photo OCR reads text on at the loosest threshold, and the glm flags OCR
  // missed there (the other thresholds are subsets: their precision comes from the same labels, results.json).
  const loose = GRID[0];
  for (const r of results) {
    const ocr = hasText(r.words, r.height, loose);
    if (!ocr && !r.flag) continue;
    const small = await rtLibrary.libraryPhotoFile(storage, r.file, 480).catch(() => null);
    if (small) writeFileSync(join(dir, "label", `${ocr ? "ocr" : "no"}-${r.flag ? "glm" : "no"}_${r.slug}_${r.file.slice(0, 8)}.webp`), small.body);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.log(annotation("error", TITLE, e instanceof Error ? e.message : String(e)));
      process.exit(1);
    },
  );
}
