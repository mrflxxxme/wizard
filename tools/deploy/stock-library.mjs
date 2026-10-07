#!/usr/bin/env node
// B2-43: the platform photo library filled from a GitHub runner (the stocks are closed for the server in RF: on the pilot
// Pexels answers 404 and Pixabay resets the connection, while both work from the runners). The pilot release with
// stock_mode=library runs this in its stock-library job (pilot-reusable.yml) against the systems' files bucket:
//   node tools/deploy/stock-library.mjs seed [--max-requests=400]
// The queries are the photos stage's own (stockQuery): the exact ones of the recorded mvp plans (B2-37), then the niche
// queries of the catalog (packages/agents stock/library.ts librarySeedQueries) in priority order. Per query Pexels
// first, Pixabay for what it did not give; a photo that fits the slot (fitsSlot) is downloaded, re-encoded into the
// library (runtime storeLibraryPhoto, idempotent by provider:id) and recorded in the library index with its author and
// licence. Idempotent: a full query is skipped, so a run goes on where the previous one stopped. Bounded: requests
// (searches + downloads) per run, Pexels searches under its 200 an hour, a pause before every request (Pixabay: 100 a
// minute), a time budget; before the first stock request a check write (small and copy-sized) to the storage, and a
// stop after MAX_PHOTO_FAILURES photos failing in a row — a common cause must not spend the cap. Search answers are not kept (Pixabay terms) — only our copies with attribution.
// Env: PEXELS_API_KEY / PIXABAY_API_KEY, the storage as for the platform (WIZARD_FILES_STORAGE=s3, WIZARD_S3_ENDPOINT,
// WIZARD_S3_REGION, WIZARD_S3_BUCKET, WIZARD_S3_ACCESS_KEY_ID, WIZARD_S3_SECRET_ACCESS_KEY; fs for a local try). Prints
// counts only (never a key, an author or a URL); every problem is a warning — the release never fails because of it.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  annotation,
  errorCode,
  errorList,
  loadAgents,
  probePlan,
  registerTsx,
  scrubKeys,
  stockKeys,
} from "./stock-ci.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const TITLE = "Библиотека фото";
const PROVIDERS = ["pexels", "pixabay"];
const LABEL = { pexels: "Pexels", pixabay: "Pixabay" };

/** Bounds of one run: requests (searches + downloads), Pexels searches (its limit: 200 an hour), minutes, page size. */
export const SEED_LIMITS = { requests: 400, pexelsSearches: 150, minutes: 20, perPage: 30 };
/** Pause before a request, ms (Pixabay: 100 requests a minute). */
export const SEED_DELAYS = { pexels: 400, pixabay: 900, download: 100 };
/** Search errors after which a provider is left for the rest of the run (a rate limit or a refused key: at once). */
const MAX_PROVIDER_ERRORS = 3;
/** The index is written after every this many new photos (a timeout loses at most these entries; copies stay). */
const FLUSH_EVERY = 20;
/**
 * Photos failing in a row (download or copy) after which the run stops: the cause is common to all of them (the first
 * live run lost all 386 downloads to one TypeError), and going on only spends the request cap.
 */
export const MAX_PHOTO_FAILURES = 5;
/** Sizes of the check writes before the first stock request, KB: a small object, then one as large as a copy. */
const CHECK_KB = [1, 256];
/** Distinct errors the annotation lists (with counts); the rest are summed up. */
const MAX_ERROR_KINDS = 6;
/** Longest error description. */
const MAX_ERROR_TEXT = 160;

/** An error of one step of the seeding (a storage operation): the step names where it happened. */
class StepError extends Error {
  constructor(step, cause) {
    super(`${step}: ${cause?.message ?? String(cause)}`, { cause });
    this.step = step;
  }
}

/**
 * The error as one line for the log: the code of a coded error (StockError, PhotoLibraryError), else its class and
 * message, then the cause (undici's «fetch failed» keeps the socket error there). URLs are cut out (a download URL may
 * carry a token); keys are scrubbed by the output.
 */
export function errorDetail(e) {
  if (e instanceof StepError) return `${e.step}: ${errorDetail(e.cause)}`;
  const own =
    typeof e?.code === "string"
      ? errorCode(e)
      : `${e?.name ?? "Error"}${e?.message ? `: ${e.message}` : e instanceof Error ? "" : `: ${String(e)}`}`;
  const c = e?.cause;
  const cause = c
    ? [c.code, c.message ?? (typeof c === "object" ? undefined : String(c))].filter(Boolean)
    : [];
  const text = `${own}${cause.length ? ` (${cause.join(": ")})` : ""}`
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'()<>]+/gi, "<url>")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT - 1)}…` : text;
}

/** The storage with its errors tagged by the operation («хранилище put: …»). */
function traced(storage) {
  const op =
    (name) =>
    async (...args) => {
      try {
        return await storage[name](...args);
      } catch (e) {
        throw new StepError(`хранилище ${name}`, e);
      }
    };
  return {
    kind: storage.kind,
    put: op("put"),
    head: op("head"),
    get: op("get"),
    delete: op("delete"),
    list: op("list"),
  };
}

/**
 * Writes a small and a copy-sized object under a fixed library key, then removes it: a storage that refuses writes (or
 * cuts large uploads) is found before any stock request is spent. Returns the failure line or null.
 */
async function checkWrites(runtime, storage, now) {
  const key = `${runtime.PHOTO_LIBRARY_PREFIX}/${runtime.libraryPhotoId("library-check:v1")}`;
  let passed = null;
  for (const kb of CHECK_KB) {
    const data = new Uint8Array(kb * 1024).map((_, i) => (i * 31 + 7) & 255);
    try {
      await storage.put(key, data, {
        name: "library-check.bin",
        mime: "image/webp",
        size: data.byteLength,
        entity: "_photo_library",
        field: "check",
        uploadedBy: null,
        uploadedAt: new Date(now()).toISOString(),
      });
    } catch (e) {
      return `проверка записи ${kb} КБ${passed ? ` (${passed} КБ записался)` : ""}: ${errorDetail(e)}`;
    }
    passed = kb;
  }
  try {
    await storage.delete(key);
  } catch {}
  return null;
}

/** Distinct errors with counts, the first MAX_ERROR_KINDS of them (in the order of their first appearance). */
function errorSummary(errors) {
  const kinds = [...new Set(errors)];
  if (kinds.length <= MAX_ERROR_KINDS) return errorList(errors);
  const shown = new Set(kinds.slice(0, MAX_ERROR_KINDS));
  const rest = errors.filter((e) => !shown.has(e)).length;
  return `${errorList(errors.filter((e) => shown.has(e)))}; других: ${rest} (видов: ${kinds.length - shown.size})`;
}

/** The TypeScript modules of the runtime the seeding uses (storage and photo library). */
export async function loadRuntime() {
  const at = (p) => import(pathToFileURL(join(ROOT, p)).href);
  const [library, storage] = await Promise.all([
    at("apps/runtime/src/files/photo-library.ts"),
    at("apps/runtime/src/files/storage.ts"),
  ]);
  return { ...library, ...storage };
}

/** Exact queries of the recorded mvp plans (the photos stage's slots of each), first in the seeding order. */
export function briefQueries(agents) {
  return agents.DESIGN_SCENARIOS.flatMap((sc) => {
    let plan;
    try {
      plan = probePlan(agents, sc.brief);
    } catch {
      return [];
    }
    return agents.planSeedQueries(plan, agents.photoSlots(plan));
  });
}

/**
 * One seeding: reads the index, fills the queries in order within `limits`, writes the merged index (every FLUSH_EVERY
 * new photos and at the end). Returns counts only. Throws only when the index cannot be read (nothing is written then).
 */
export async function runSeed({
  agents,
  runtime,
  storage,
  client,
  queries,
  limits = SEED_LIMITS,
  delays = SEED_DELAYS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  let index = agents.parseLibraryIndex(await runtime.readLibraryIndex(storage));
  const store = traced(storage);
  const stats = {
    before: index.entries.length,
    queries: queries.length,
    full: 0,
    searched: 0,
    searches: { pexels: 0, pixabay: 0 },
    downloads: 0,
    added: 0,
    errors: [],
    writeErrors: 0,
    failuresInRow: 0,
    stopped: null,
    after: index.entries.length,
    complete: 0,
  };
  const t0 = now();
  const pickedAt = new Date(now()).toISOString().slice(0, 10);
  const known = new Set(index.entries.map((e) => `${e.provider}:${e.id}`));
  const providerErrors = { pexels: 0, pixabay: 0 };
  const on = (p) => client.providers.includes(p) && providerErrors[p] < MAX_PROVIDER_ERRORS;
  let requests = 0;
  let checked = false;
  let pending = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const next = agents.mergeLibraryIndex(index, pending);
    try {
      await runtime.writeLibraryIndex(storage, agents.serializeLibraryIndex(next));
      index = next;
      pending = [];
    } catch (e) {
      stats.writeErrors++;
      stats.errors.push(`запись индекса: ${errorDetail(e)}`);
    }
  };
  const stop = () => {
    if (stats.stopped !== null) return true;
    if (requests >= limits.requests) stats.stopped ??= "requests";
    else if (now() - t0 > limits.minutes * 60_000) stats.stopped ??= "time";
    return stats.stopped !== null;
  };
  const count = (q) =>
    agents.libraryCount(index, q) +
    pending.filter((e) => e.query === q.text && e.orientation === q.orientation).length;

  for (const q of queries) {
    let need = q.cap - count(q);
    if (need <= 0) {
      stats.full++;
      continue;
    }
    if (stop()) break;
    if (!checked) {
      checked = true;
      const failed = await checkWrites(runtime, store, now);
      if (failed) {
        stats.errors.push(failed);
        stats.stopped = "storage";
        break;
      }
    }
    stats.searched++;
    for (const provider of PROVIDERS) {
      if (need <= 0 || stop() || !on(provider)) continue;
      if (provider === "pexels" && stats.searches.pexels >= limits.pexelsSearches) continue;
      await sleep(delays[provider]);
      requests++;
      stats.searches[provider]++;
      let hits;
      try {
        hits = await client.search(provider, { text: q.text, orientation: q.orientation }, limits.perPage);
      } catch (e) {
        const code = errorCode(e);
        stats.errors.push(`${LABEL[provider]} поиск: ${code}`);
        providerErrors[provider] =
          code === "RATE_LIMITED" || /^HTTP 4/.test(code)
            ? MAX_PROVIDER_ERRORS
            : providerErrors[provider] + 1;
        continue;
      }
      for (const hit of hits) {
        if (need <= 0 || stop()) break;
        const source = `${hit.provider}:${hit.id}`;
        if (known.has(source) || !agents.fitsSlot(hit, { type: q.type, orientation: q.orientation }))
          continue;
        known.add(source);
        await sleep(delays.download);
        requests++;
        stats.downloads++;
        let copy;
        let step = "скачивание";
        try {
          const bytes = await client.download(hit);
          step = "копия";
          copy = await runtime.storeLibraryPhoto(store, bytes, { source });
        } catch (e) {
          stats.errors.push(`${LABEL[hit.provider]} ${step}: ${errorDetail(e)}`);
          if (++stats.failuresInRow >= MAX_PHOTO_FAILURES) stats.stopped = "failures";
          continue;
        }
        stats.failuresInRow = 0;
        pending.push({
          query: q.text,
          orientation: q.orientation,
          provider: hit.provider,
          id: hit.id,
          file: copy.id,
          author: hit.author,
          ...(hit.authorUrl ? { authorUrl: hit.authorUrl } : {}),
          pageUrl: hit.pageUrl,
          ...agents.STOCK_LICENSES[hit.provider],
          width: copy.width,
          height: copy.height,
          pickedAt,
        });
        stats.added++;
        need--;
        if (pending.length >= FLUSH_EVERY) await flush();
      }
    }
  }
  await flush();
  stats.after = index.entries.length;
  stats.complete = queries.filter((q) => agents.libraryCount(index, q) >= q.cap).length;
  return stats;
}

/** The run as one annotation: counts and error codes only. */
export function seedAnnotation(s, limits = SEED_LIMITS) {
  const lines = [
    `Добавлено фото: ${s.added} (скачано ${s.downloads}; поисков: Pexels ${s.searches.pexels}, Pixabay ${s.searches.pixabay})`,
    `В библиотеке: ${s.after} фото (было ${s.before}); заполнено запросов ${s.complete} из ${s.queries}`,
  ];
  if (s.stopped === "requests")
    lines.push(`Остановлено на лимите запросов (${limits.requests}): следующий выкат продолжит`);
  if (s.stopped === "time")
    lines.push(`Остановлено по времени (${limits.minutes} мин): следующий выкат продолжит`);
  if (s.stopped === "failures")
    lines.push(
      `Остановлено после ${MAX_PHOTO_FAILURES} ошибок фото подряд: причина общая, повтор только тратил бы запросы`,
    );
  if (s.stopped === "storage") lines.push("Остановлено до запросов к стокам: запись в хранилище не проходит");
  if (s.errors.length) lines.push(`Ошибки: ${errorSummary(s.errors)}`);
  const level = s.errors.length || (s.added === 0 && s.complete < s.queries) ? "warning" : "notice";
  return annotation(level, TITLE, lines.join("\n"));
}

const argOf = (argv, name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};

/**
 * CLI; returns the exit code: 0 — done or a warning (a seeding problem never fails the release), 2 — wrong usage.
 * Tests pass `agents`, `runtime`, `storage` and `fetch` (no tsx, no network).
 */
export async function main(
  argv,
  { env = process.env, fetch: f = fetch, log = console.log, agents, runtime, storage, sleep } = {},
) {
  const keys = stockKeys(env);
  const secrets = { ...keys, s3id: env.WIZARD_S3_ACCESS_KEY_ID, s3secret: env.WIZARD_S3_SECRET_ACCESS_KEY };
  const out = (line) => log(scrubKeys(line, secrets));
  const warn = (text) => out(annotation("warning", TITLE, text));
  const [action, ...rest] = argv;
  if (action !== "seed") {
    out(annotation("error", TITLE, "действие: seed [--max-requests=N]"));
    return 2;
  }
  const max = argOf(rest, "max-requests");
  if (max !== undefined && !/^[1-9][0-9]{0,3}$/.test(max)) {
    out(annotation("error", TITLE, "--max-requests: целое от 1 до 9999"));
    return 2;
  }
  if (Object.keys(keys).length === 0) {
    warn("нет ключей стоков (PEXELS_API_KEY, PIXABAY_API_KEY) — библиотека не пополнялась");
    return 0;
  }
  if (!storage && !["s3", "fs"].includes(env.WIZARD_FILES_STORAGE ?? "")) {
    warn("хранилище не задано (WIZARD_FILES_STORAGE=s3 и WIZARD_S3_*) — библиотека не пополнялась");
    return 0;
  }
  try {
    if (!agents || !runtime) await registerTsx();
    const a = agents ?? (await loadAgents());
    const rt = runtime ?? (await loadRuntime());
    // The account key trimmed as the pods get it (pilot-secrets.mjs clusterSecretFiles).
    const s3 = Object.fromEntries(
      ["WIZARD_S3_ACCESS_KEY_ID", "WIZARD_S3_SECRET_ACCESS_KEY"].map((n) => [n, env[n]?.trim()]),
    );
    const store =
      storage ?? rt.createFileStorage({ ...env, ...s3 }, { defaultDir: join(ROOT, ".data", "files") });
    const queries = a.librarySeedQueries(briefQueries(a));
    const limits = { ...SEED_LIMITS, ...(max ? { requests: Number(max) } : {}) };
    const s = await runSeed({
      agents: a,
      runtime: rt,
      storage: store,
      client: a.createStockClient({ fetch: f, keys }),
      queries,
      limits,
      ...(sleep ? { sleep } : {}),
    });
    out(seedAnnotation(s, limits));
  } catch (e) {
    warn(`библиотека не пополнена: ${e instanceof Error ? e.message : String(e)}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      const keys = stockKeys(process.env);
      console.log(annotation("warning", TITLE, scrubKeys(e instanceof Error ? e.message : String(e), keys)));
    },
  );
}
