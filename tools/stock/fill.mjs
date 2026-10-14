#!/usr/bin/env node
// V4-10 (D79 (6)): fills the semantic photo library from a GitHub runner (the stocks are closed for the server in RF).
//   node tools/stock/fill.mjs model                    — the SigLIP text tower into the storage (the platform reads it there)
//   node tools/stock/fill.mjs fill [--minutes=N] [--max-photos=N] [--niches=a,b] [--prune]
//                                                      — catalog niches in priority order, one shard each; --prune
//                                                        drops the photos of queries the catalog no longer has
//   node tools/stock/fill.mjs backfill [--minutes=N]   — niches the builds asked for (their Russian text, lang=ru)
// Per photo: download from the stock, a copy into the platform photo library (runtime storeLibraryPhoto: WebP, no EXIF,
// idempotent by provider:id), the SigLIP image embedding and the mean colour; the shard of the niche is rewritten every
// FLUSH_EVERY photos and the manifest after every niche, so a run stopped by its budget loses at most a few photos and
// the next run goes on where it stopped (a full shard is skipped, a known photo is never fetched twice). Bounds: time,
// photos, Pexels searches under its 200 an hour, a pause before every request, a stop after MAX_FAILURES in a row.
// Env: PEXELS_API_KEY / PIXABAY_API_KEY and the storage as for the platform (WIZARD_FILES_STORAGE=s3, WIZARD_S3_*).
// Prints counts only (never a key, an author or a URL). Search answers are not kept (Pixabay terms) — only our copies
// with attribution.
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listBuckets, S3 } from "../deploy/pilot.mjs";
import { annotation, errorCode, registerTsx, scrubKeys, stockKeys } from "../deploy/stock-ci.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const TITLE = "Библиотека фото v4";

/** Bounds of one run. */
export const FILL_LIMITS = { minutes: 330, photos: 30_000, pexelsPerHour: 180, perQuery: 0 };
/** Pause before a request, ms (Pixabay: 100 requests a minute). */
export const FILL_DELAYS = { pexels: 400, pixabay: 700, download: 50 };
/** Photos written to a shard between rewrites. */
export const FLUSH_EVERY = 40;
/** Photos failing in a row after which the run stops (a common cause must not spend the budget). */
export const MAX_FAILURES = 8;
/** Searches of one stock query: provider, orientation, page size (pages go on while a query is short of photos). */
export const SEARCH_PLAN = [
  { provider: "pexels", orientation: "landscape", perPage: 80 },
  { provider: "pixabay", orientation: "landscape", perPage: 100 },
  { provider: "pexels", orientation: "portrait", perPage: 40 },
  { provider: "pixabay", orientation: "portrait", perPage: 50 },
];
/** Pages of one search at most. */
export const MAX_PAGES = 3;
/** Photos a requested (backfill) niche gets. */
export const REQUEST_TARGET = 120;
/** Requested niches one run fills at most. */
export const REQUESTS_PER_RUN = 20;

/** A photo is worth keeping: large enough for a first screen in its orientation. */
export const bigEnough = (h) => Math.max(h.width, h.height) >= 1200 && Math.min(h.width, h.height) >= 700;

/**
 * One fill: niches in order, each to its target. `deps`: stock (search/download), objects (LibraryObjects), store
 * (hit, bytes → library copy), embed (bytes → {vector, color, luma}), the stock module `S`. Returns counts only.
 */
export async function runFill({
  S,
  stock,
  objects,
  store,
  embed,
  niches,
  limits = FILL_LIMITS,
  delays = FILL_DELAYS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  concurrency = 3,
}) {
  const t0 = now();
  const stats = {
    niches: niches.length,
    full: 0,
    pruned: 0,
    filled: 0,
    added: 0,
    searches: { pexels: 0, pixabay: 0 },
    downloads: 0,
    errors: [],
    stopped: null,
    total: 0,
  };
  const manifest = (await S.readManifest(objects)) ?? { version: S.SEMANTIC_VERSION, model: S.SEMANTIC_MODEL, shards: [] };
  // Every photo of the library once: the shards of the manifest are read first (entries only matter here).
  const shards = new Map();
  for (const m of manifest.shards) {
    const sh = await S.readShard(objects, m.slug).catch(() => null);
    if (sh) shards.set(m.slug, sh);
  }
  const known = new Set([...shards.values()].flatMap((sh) => sh.entries.map(S.sourceOf)));
  const pexelsTimes = [];
  const providerOff = new Set();
  let failures = 0;
  let added = 0;
  const stop = () => {
    if (stats.stopped) return true;
    if (now() - t0 > limits.minutes * 60_000) stats.stopped = "time";
    else if (added >= limits.photos) stats.stopped = "photos";
    return stats.stopped !== null;
  };
  const writeManifest = async () => {
    const at = new Date(now()).toISOString();
    const rows = new Map(manifest.shards.map((s) => [s.slug, s]));
    for (const sh of shards.values())
      rows.set(sh.slug, { slug: sh.slug, name: sh.name, count: sh.entries.length, updatedAt: rows.get(sh.slug)?.updatedAt ?? at });
    manifest.shards = [...rows.values()];
    await S.writeManifest(objects, manifest);
  };

  for (const niche of niches) {
    if (stop()) break;
    const cur = shards.get(niche.slug) ?? {
      slug: niche.slug,
      name: niche.name,
      entries: [],
      vectors: S.quantize([]),
    };
    // V4-30: --prune drops the photos of queries the niche no longer has (the shard then refills with the new ones).
    const keep = cur.entries.flatMap((e, i) =>
      !limits.prune || niche.queries.some((q) => q.slice(0, 100) === e.query) ? [i] : [],
    );
    const rows = keep.map((i) => dequantRow(cur.vectors, i));
    const entries = keep.map((i) => cur.entries[i]);
    const pruned = cur.entries.length - entries.length;
    stats.pruned += pruned;
    if (entries.length >= niche.target) {
      stats.full++;
      continue;
    }
    let dirty = pruned;
    const flush = async () => {
      if (dirty === 0) return;
      const sh = { slug: niche.slug, name: niche.name, entries: [...entries], vectors: S.quantize(rows) };
      await S.writeShard(objects, sh);
      shards.set(niche.slug, sh);
      dirty = 0;
    };
    const perQuery = limits.perQuery || Math.ceil(niche.target / niche.queries.length);
    for (const text of niche.queries) {
      let got = entries.filter((e) => e.query === text).length;
      for (const plan of SEARCH_PLAN) {
        if (providerOff.has(plan.provider) || !stock.providers.includes(plan.provider)) continue;
        for (let page = 1; page <= MAX_PAGES; page++) {
          if (stop() || got >= perQuery || entries.length >= niche.target) break;
          if (plan.provider === "pexels") {
            // Pexels: at most pexelsPerHour searches in any hour.
            while (pexelsTimes.length && now() - pexelsTimes[0] > 3600_000) pexelsTimes.shift();
            if (pexelsTimes.length >= limits.pexelsPerHour) {
              const wait = 3600_000 - (now() - pexelsTimes[0]) + 1000;
              if (now() + wait - t0 > limits.minutes * 60_000) {
                providerOff.add("pexels");
                break;
              }
              await sleep(wait);
            }
            pexelsTimes.push(now());
          }
          await sleep(delays[plan.provider]);
          stats.searches[plan.provider]++;
          let hits;
          try {
            hits = await stock.search(
              plan.provider,
              { text, orientation: plan.orientation, page, lang: niche.lang ?? "en" },
              plan.perPage,
            );
          } catch (e) {
            const code = errorCode(e);
            stats.errors.push(`${plan.provider} поиск: ${code}`);
            if (code === "RATE_LIMITED" || /^HTTP 4/.test(code)) providerOff.add(plan.provider);
            break;
          }
          const fresh = hits.filter((h) => !known.has(S.sourceOf(h)) && bigEnough(h));
          if (fresh.length === 0 && hits.length < plan.perPage) break;
          // A few photos at once: download, copy, embedding.
          for (let i = 0; i < fresh.length; i += concurrency) {
            if (stop() || got >= perQuery || entries.length >= niche.target) break;
            const batch = fresh.slice(i, i + Math.min(concurrency, perQuery - got, niche.target - entries.length));
            for (const h of batch) known.add(S.sourceOf(h));
            const done = await Promise.all(
              batch.map(async (hit) => {
                await sleep(delays.download);
                stats.downloads++;
                let step = "скачивание";
                try {
                  const bytes = await stock.download(hit);
                  step = "копия";
                  const copy = await store(hit, bytes);
                  step = "эмбеддинг";
                  const e = await embed(bytes);
                  return { hit, copy, e };
                } catch (err) {
                  stats.errors.push(`${hit.provider} ${step}: ${errorCode(err)}`);
                  return null;
                }
              }),
            );
            for (const d of done) {
              if (!d) {
                if (++failures >= MAX_FAILURES) stats.stopped = "failures";
                continue;
              }
              failures = 0;
              entries.push({
                provider: d.hit.provider,
                id: d.hit.id,
                file: d.copy.id,
                author: d.hit.author,
                ...(d.hit.authorUrl ? { authorUrl: d.hit.authorUrl } : {}),
                pageUrl: d.hit.pageUrl,
                width: d.copy.width,
                height: d.copy.height,
                color: d.e.color,
                luma: d.e.luma,
                query: text.slice(0, 100),
              });
              rows.push(d.e.vector);
              got++;
              added++;
              dirty++;
            }
            if (dirty >= FLUSH_EVERY) await flush();
          }
        }
      }
    }
    await flush();
    await writeManifest();
    if (entries.length >= niche.target) stats.filled++;
  }
  await writeManifest();
  stats.added = added;
  stats.total = [...shards.values()].reduce((s, sh) => s + sh.entries.length, 0);
  return stats;
}

/** Row `i` of quantized vectors as floats. */
function dequantRow(v, i) {
  const out = new Float32Array(v.dim);
  const k = v.scales[i];
  for (let j = 0; j < v.dim; j++) out[j] = v.data[i * v.dim + j] * k;
  return out;
}

/** The catalog niches to fill (all, or the slugs of --niches), with their target. */
export function catalogNiches(S, only) {
  const list = only ? S.CATALOG.filter((c) => only.includes(c.slug)) : S.CATALOG;
  return list.map((c) => ({ ...c, target: c.target ?? S.NICHE_TARGET }));
}

/** Requested niches to fill: the most asked first, at most REQUESTS_PER_RUN; their text is the Russian query. */
export function requestNiches(S, requests) {
  return [...requests.requests]
    .sort((a, b) => b.count - a.count || (a.at < b.at ? -1 : 1))
    .slice(0, REQUESTS_PER_RUN)
    .map((r) => ({
      slug: S.requestSlug(r.text),
      name: r.text,
      queries: [r.text],
      lang: "ru",
      target: REQUEST_TARGET,
    }));
}

/** The library by niche (catalog order, then requested niches): a summary line and a Markdown table. */
export function statusText(S, manifest) {
  const rows = manifest?.shards ?? [];
  const by = new Map(rows.map((r) => [r.slug, r]));
  const total = rows.reduce((s, r) => s + r.count, 0);
  const full = S.CATALOG.filter((c) => (by.get(c.slug)?.count ?? 0) >= (c.target ?? S.NICHE_TARGET)).length;
  const lines = [
    `всего фото: ${total}; ниш каталога заполнено: ${full} из ${S.CATALOG.length}; запрошенных ниш: ${rows.filter((r) => r.slug.startsWith("req-")).length}`,
    "",
    "| Ниша | Фото |",
    "|---|---|",
    ...S.CATALOG.map((c) => `| ${c.name} | ${by.get(c.slug)?.count ?? 0} |`),
    ...rows.filter((r) => r.slug.startsWith("req-")).map((r) => `| ${r.name} (запрос) | ${r.count} |`),
  ];
  return lines.join("\n");
}

/** The annotation of a run: counts only. */
export function fillAnnotation(s) {
  const level = s.stopped === "failures" || (s.added === 0 && s.errors.length) ? "warning" : "notice";
  const why = { time: "кончилось время", photos: "достигнут лимит фото", failures: `${MAX_FAILURES} ошибок подряд` };
  const kinds = [...new Set(s.errors)].slice(0, 6);
  return annotation(
    level,
    TITLE,
    `ниш: ${s.niches} (заполнено ${s.filled}, уже полных ${s.full}); добавлено фото: ${s.added}, ` +
      (s.pruned ? `удалено фото старых запросов: ${s.pruned}, ` : "") +
      `всего в библиотеке: ${s.total}; ` +
      `поисков Pexels ${s.searches.pexels}, Pixabay ${s.searches.pixabay}; скачиваний ${s.downloads}` +
      (s.stopped ? `; остановка: ${why[s.stopped]}` : "") +
      (kinds.length ? `; ошибки (${s.errors.length}): ${kinds.join("; ")}` : ""),
  );
}

/**
 * The storage env of the run: WIZARD_S3_BUCKET as given, else the files bucket of DEPLOY_ENV found by the account key
 * (ListBuckets: the one named "<prefix->wizard-<env>-files", as tofu creates it); endpoint and region of the pilot.
 */
export async function storageEnv(env, { fetch: f = fetch } = {}) {
  const s3 = Object.fromEntries(["WIZARD_S3_ACCESS_KEY_ID", "WIZARD_S3_SECRET_ACCESS_KEY"].map((n) => [n, env[n]?.trim()]));
  const out = {
    ...env,
    ...s3,
    WIZARD_S3_ENDPOINT: env.WIZARD_S3_ENDPOINT || S3.endpoint,
    WIZARD_S3_REGION: env.WIZARD_S3_REGION || S3.region,
  };
  if (env.WIZARD_FILES_STORAGE !== "s3" || env.WIZARD_S3_BUCKET) return out;
  const want = `wizard-${env.DEPLOY_ENV || "prod"}-files`;
  const r = await listBuckets(
    {
      endpoint: out.WIZARD_S3_ENDPOINT,
      region: out.WIZARD_S3_REGION,
      accessKeyId: s3.WIZARD_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: s3.WIZARD_S3_SECRET_ACCESS_KEY ?? "",
    },
    { fetch: f },
  );
  if (!r.names) throw new Error(`список бакетов недоступен (${r.code})`);
  const hits = r.names.filter((n) => n === want || n.endsWith(`-${want}`));
  if (hits.length !== 1) throw new Error(`бакет ${want}: найдено ${hits.length} — задайте WIZARD_S3_BUCKET`);
  return { ...out, WIZARD_S3_BUCKET: hits[0] };
}

const argOf = (argv, name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};

/** The workspace modules the fill uses (tsx registered by main). */
async function loadModules() {
  const at = (p) => import(pathToFileURL(join(ROOT, p)).href);
  const [S, client, library, storage, codecs, sniff, processor] = await Promise.all([
    at("packages/agents/src/stock/index.ts"),
    at("packages/agents/src/stock/client.ts"),
    at("apps/runtime/src/files/photo-library.ts"),
    at("apps/runtime/src/files/storage.ts"),
    at("apps/runtime/src/media/codecs.ts"),
    at("apps/runtime/src/files/sniff.ts"),
    at("apps/runtime/src/media/processor.ts"),
  ]);
  return { S, client, rt: { ...library, ...storage, ...codecs, ...sniff, ...processor } };
}

/** Model files for the local cache of the runner: from Hugging Face at the pinned revision. */
const huggingFace = (S, f) => async (file) => {
  const r = await f(S.siglipUrl(file));
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
};

/**
 * The text tower files into the bucket (from Hugging Face at the pinned revision, checked against the pinned
 * checksums), in TEXT_FILES order: the last one marks a complete upload. Returns how many were written.
 */
export async function uploadModel(S, objects, cache, f = fetch) {
  const { readFile } = await import("node:fs/promises");
  await S.ensureModelFiles(cache, S.TEXT_FILES, huggingFace(S, f));
  let put = 0;
  for (const file of S.TEXT_FILES) {
    const name = S.SEMANTIC_OBJECTS.model(S.SIGLIP.files[file].path);
    const have = await objects.get(name).catch(() => null);
    if (have && S.sha256(have) === S.SIGLIP.files[file].sha256) continue;
    await objects.put(name, new Uint8Array(await readFile(join(cache, S.localName(file)))), "application/octet-stream");
    put++;
  }
  return put;
}

/** CLI; returns the exit code: 0 — done (a fill problem is a warning), 1 — the model upload failed, 2 — usage. */
export async function main(argv, { env = process.env, fetch: f = fetch, log = console.log } = {}) {
  const keys = stockKeys(env);
  const secrets = { ...keys, s3id: env.WIZARD_S3_ACCESS_KEY_ID, s3secret: env.WIZARD_S3_SECRET_ACCESS_KEY };
  const out = (line) => log(scrubKeys(line, secrets));
  const [action, ...rest] = argv;
  if (!["model", "fill", "backfill", "status"].includes(action)) {
    out(annotation("error", TITLE, "действие: model | fill | backfill | status [--minutes=N] [--max-photos=N] [--niches=a,b] [--prune]"));
    return 2;
  }
  const minutes = argOf(rest, "minutes");
  const maxPhotos = argOf(rest, "max-photos");
  for (const [name, v] of [["minutes", minutes], ["max-photos", maxPhotos]])
    if (v !== undefined && !/^[1-9][0-9]{0,4}$/.test(v)) {
      out(annotation("error", TITLE, `--${name}: целое от 1 до 99999`));
      return 2;
    }
  if (!["s3", "fs"].includes(env.WIZARD_FILES_STORAGE ?? "")) {
    out(annotation("warning", TITLE, "хранилище не задано (WIZARD_FILES_STORAGE=s3 и WIZARD_S3_*) — ничего не сделано"));
    return 0;
  }
  let senv;
  try {
    senv = await storageEnv(env, { fetch: f });
  } catch (e) {
    out(annotation("warning", TITLE, `хранилище: ${e instanceof Error ? e.message : String(e)}`));
    return action === "model" ? 1 : 0;
  }
  await registerTsx();
  const { S, client, rt } = await loadModules();
  const storage = rt.createFileStorage(senv, { defaultDir: join(ROOT, ".data", "files") });
  const objects = S.storageObjects(storage, (name) => `${rt.PHOTO_LIBRARY_PREFIX}/${rt.libraryPhotoId(name)}`);
  const cache = join(env.RUNNER_TEMP || join(ROOT, ".data"), "siglip");

  if (action === "status") {
    const m = await S.readManifest(objects);
    const text = statusText(S, m);
    out(annotation("notice", TITLE, text.split("\n")[0]));
    log(text);
    if (env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
    }
    return 0;
  }

  if (action === "model") {
    try {
      const put = await uploadModel(S, objects, cache, f);
      out(annotation("notice", TITLE, `модель ${S.SIGLIP.name}: файлов загружено ${put}, уже были ${S.TEXT_FILES.length - put}`));
      return 0;
    } catch (e) {
      out(annotation("error", TITLE, `модель не загружена: ${e instanceof Error ? e.message : String(e)}`));
      return 1;
    }
  }

  if (Object.keys(keys).length === 0) {
    out(annotation("warning", TITLE, "нет ключей стоков (PEXELS_API_KEY, PIXABAY_API_KEY) — библиотека не пополнялась"));
    return 0;
  }
  try {
    // The platform needs the text tower in the bucket: its last file marks a complete upload.
    const last = S.SIGLIP.files[S.TEXT_FILES.at(-1)].path;
    if (!(await objects.get(S.SEMANTIC_OBJECTS.model(last)))) await uploadModel(S, objects, cache, f);
    await S.ensureModelFiles(cache, S.VISION_FILES, huggingFace(S, f));
    const cores = availableParallelism();
    const encoder = await S.loadImageEncoder(cache, { threads: Math.max(1, cores - 1) });
    const codecs = await rt.instantiateCodecs(await rt.codecModules());
    const processor = new rt.ImageProcessor({ concurrency: Math.max(1, Math.min(3, cores - 1)), maxQueue: 16 });
    const embed = async (bytes) => {
      const mime = rt.sniffMime(bytes);
      if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new Error("NOT_IMAGE");
      const input = S.imageInput(await codecs.decode(bytes, mime));
      return { vector: await encoder.encode(input.pixels), color: input.color, luma: input.luma };
    };
    const store = (hit, bytes) =>
      rt.storeLibraryPhoto(storage, bytes, {
        source: S.sourceOf(hit),
        process: (b, m) => processor.process(b, m),
      });
    const only = argOf(rest, "niches")?.split(",").map((s) => s.trim()).filter(Boolean);
    const requests = action === "backfill" ? await S.readRequests(objects) : null;
    const niches = requests ? requestNiches(S, requests) : catalogNiches(S, only);
    const limits = {
      ...FILL_LIMITS,
      ...(minutes ? { minutes: Number(minutes) } : {}),
      ...(maxPhotos ? { photos: Number(maxPhotos) } : {}),
      ...(rest.includes("--prune") ? { prune: true } : {}),
    };
    const s = await runFill({
      S,
      stock: client.createStockClient({ fetch: f, keys, timeoutMs: 20_000 }),
      objects,
      store,
      embed,
      niches,
      limits,
    });
    if (requests) {
      // Requests whose shard is full leave the queue (a request added meanwhile stays: it is re-read here).
      const full = new Set(
        (await S.readManifest(objects))?.shards.filter((m) => m.count >= REQUEST_TARGET).map((m) => m.slug) ?? [],
      );
      const cur = await S.readRequests(objects);
      await S.writeRequests(objects, { ...cur, requests: cur.requests.filter((r) => !full.has(S.requestSlug(r.text))) });
    }
    await encoder.close();
    out(fillAnnotation(s));
  } catch (e) {
    out(annotation("warning", TITLE, `библиотека не пополнена: ${e instanceof Error ? e.message : String(e)}`));
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.log(annotation("warning", TITLE, scrubKeys(e instanceof Error ? e.message : String(e), stockKeys(process.env))));
    },
  );
}
