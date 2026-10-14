#!/usr/bin/env node
// V4-33 (probe, not merged): can SigLIP flag photos with text zero-shot, on the library's own embeddings? The labelled
// sample (text-sample.json: 500 photos of 5 shards, text = a glm flag or a person's label of the tesseract probe
// 38526317892) is scored against English prompts: the similarity to a «text» prompt, and its margin over a «no text»
// prompt. For every method the summary gives the best threshold with ≤ 10 % false among the flagged and its recall,
// and the precision at 60 % recall; the 480 px copies of the top-ranked photos of the best method go into --out for a
// person to check (an unlabelled photo with text there is a label error, not a false flag).
// Env: the storage as for fill.mjs; no model keys, no LLM.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { annotation, registerTsx, scrubKeys } from "../deploy/stock-ci.mjs";
import { storageEnv } from "./fill.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const TITLE = "SigLIP: текст в кадре без LLM";

/** Prompt pairs: text in the frame vs. none (English, as the library is indexed). */
export const PAIRS = [
  ["a sign with text", "a photo without any text"],
  ["a photo with readable text", "a photo with no writing"],
  ["a shop sign with letters", "a photo of a room"],
  ["words written on a board", "a photo without words"],
  ["a logo with a brand name", "a plain photo"],
  ["a photo containing text, letters or a sign", "a photo of people and objects without any text"],
];

/** Every method's best threshold: ≤ 10 % false among the flagged (the largest recall), and the precision at 60 %. */
export function evaluate(scores, labels) {
  const order = scores.map((s, i) => [s, labels[i]]).sort((a, b) => b[0] - a[0]);
  const total = labels.filter(Boolean).length;
  let tp = 0;
  let best = { recall: 0, precision: 0, threshold: null, flagged: 0 };
  let at60 = null;
  order.forEach(([s, l], k) => {
    if (l) tp++;
    const n = k + 1;
    const precision = tp / n;
    const recall = tp / total;
    if (precision >= 0.9 && recall > best.recall) best = { recall, precision, threshold: s, flagged: n };
    if (!at60 && recall >= 0.6) at60 = { precision, threshold: s, flagged: n };
  });
  return { best, at60 };
}

const argOf = (argv, name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};

export async function main(argv, { env = process.env, log = console.log } = {}) {
  const secrets = { s3id: env.WIZARD_S3_ACCESS_KEY_ID, s3secret: env.WIZARD_S3_SECRET_ACCESS_KEY };
  const out = (line) => log(scrubKeys(line, secrets));
  const dir = argOf(argv, "out") ?? join(env.RUNNER_TEMP || join(ROOT, ".data"), "siglip-text");
  const sample = JSON.parse(readFileSync(join(import.meta.dirname, "text-sample.json"), "utf8"));
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
  // The sample's image vectors, from their shards.
  const vec = new Map();
  for (const slug of [...new Set(sample.map((s) => s.shard))]) {
    const sh = await S.readShard(objects, slug);
    if (!sh) continue;
    sh.entries.forEach((e, i) => {
      const v = new Float32Array(sh.vectors.dim);
      for (let j = 0; j < sh.vectors.dim; j++) v[j] = sh.vectors.data[i * sh.vectors.dim + j] * sh.vectors.scales[i];
      vec.set(e.file, v);
    });
  }
  const rows = sample.filter((s) => vec.has(s.file));
  const labels = rows.map((r) => r.text);
  const modelDir = join(env.RUNNER_TEMP || join(ROOT, ".data"), "siglip");
  await S.ensureModelFiles(modelDir, S.TEXT_FILES, (f) => objects.get(S.SEMANTIC_OBJECTS.model(S.SIGLIP.files[f].path)));
  const encoder = await S.loadTextEncoder(modelDir);
  const dot = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  };
  const t0 = Date.now();
  const methods = [];
  for (const [pos, neg] of PAIRS) {
    const p = await encoder.encode(pos);
    const n = await encoder.encode(neg);
    const sp = rows.map((r) => dot(vec.get(r.file), p));
    const sn = rows.map((r) => dot(vec.get(r.file), n));
    methods.push({ name: `«${pos}»`, scores: sp });
    methods.push({ name: `«${pos}» − «${neg}»`, scores: sp.map((s, i) => s - sn[i]) });
  }
  // All the «text» prompts at once: the largest margin over the mean of the «no text» ones.
  const ps = await Promise.all(PAIRS.map(([p]) => encoder.encode(p)));
  const ns = await Promise.all(PAIRS.map(([, n]) => encoder.encode(n)));
  methods.push({
    name: "max(текст) − mean(без текста)",
    scores: rows.map((r) => {
      const v = vec.get(r.file);
      return Math.max(...ps.map((p) => dot(v, p))) - ns.reduce((s, n) => s + dot(v, n), 0) / ns.length;
    }),
  });
  await encoder.close();
  const ms = Date.now() - t0;

  const lines = [
    `## ${TITLE}`,
    "",
    `Фото: ${rows.length}, с текстом по разметке: ${labels.filter(Boolean).length}; запросы и оценка всех фото — ${(ms / 1000).toFixed(1)} с`,
    "",
    "| Метод | Ложных ≤ 10 %: полнота | отмечено | Полнота 60 %: точность | отмечено |",
    "|---|---|---|---|---|",
  ];
  const evals = methods.map((m) => ({ ...m, ...evaluate(m.scores, labels) }));
  for (const m of evals)
    lines.push(
      `| ${m.name} | ${(m.best.recall * 100).toFixed(0)} % | ${m.best.flagged} | ${m.at60 ? `${(m.at60.precision * 100).toFixed(0)} %` : "—"} | ${m.at60?.flagged ?? "—"} |`,
    );
  out(lines.join("\n"));
  if (env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
  // The top 60 of the best method at 60 % recall, for a person: «yes» — labelled text, «no» — not labelled.
  const top = [...evals].sort((a, b) => (b.at60?.precision ?? 0) - (a.at60?.precision ?? 0))[0];
  out(`Лучший при полноте 60 %: ${top.name}`);
  mkdirSync(join(dir, "top"), { recursive: true });
  const ranked = rows.map((r, i) => ({ ...r, score: top.scores[i] })).sort((a, b) => b.score - a.score);
  writeFileSync(join(dir, "ranked.json"), JSON.stringify(ranked.map(({ file, shard, text, glm, score }) => ({ file, shard, text, glm, score }))));
  for (const [k, r] of ranked.slice(0, 60).entries()) {
    const small = await rtLibrary.libraryPhotoFile(storage, r.file, 480).catch(() => null);
    if (small)
      writeFileSync(join(dir, "top", `${String(k + 1).padStart(2, "0")}_${r.text ? "yes" : "no"}_${r.shard}_${r.file.slice(0, 8)}.webp`), small.body);
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
