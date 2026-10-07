#!/usr/bin/env node
// B2-38: the stock keys in the CI of the build pipeline (.github/workflows/stock.yml; docs/ops/eval-d76.md «Стоки из
// CI»). The coordinator works only through the GitHub API, so every verdict is an annotation (plus, for the probe, a
// comment in the issue «Стоки: проверка из CI»); the job summary and artifacts are not used.
//   node tools/deploy/stock-ci.mjs check   — one free search per provider (preflight stockKeyVerdict);
//   node tools/deploy/stock-ci.mjs probe [--briefs=a,b,c]
//        — the photos stage of builder v2 (runPhotosStage) with the real keys on 3–5 mvp briefs: the recorded plans and
//          design answers of B2-37 (packages/agents/test/design-mvp-scenarios.ts), no models, the photo library in
//          memory, at most 20 searches and 10 downloads; numbers only (no authors, links or URLs);
//   node tools/deploy/stock-ci.mjs record [--dir=tools/fixtures/stock]
//        — the Pexels search answers of the fixture dictionary (tools/fixtures/stock/gen.mjs QUERIES) into
//          pexels.recorded.json: metadata only, keys scrubbed; Pixabay is not recorded (its API terms: a 24 h cache).
// Keys come only from the step env (PEXELS_API_KEY, PIXABAY_API_KEY); every printed line passes through scrubKeys.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { STOCK_KEY_INPUTS, stockAnnotation, stockKeyVerdicts } from "./preflight.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const STOCK_DIR = join(ROOT, "tools", "fixtures", "stock");

/** The issue the probe comments in (found by title, created once). */
export const STOCK_ISSUE_TITLE = "Стоки: проверка из CI";
/** mvp briefs of the probe by default: those whose recorded plans have photo places (16 places, 8 searches groups). */
export const PROBE_BRIEFS = [
  "mvp-01-dental-clinic",
  "mvp-02-renovation",
  "mvp-03-english-courses",
  "mvp-04-beauty-salon",
  "mvp-10-yoga-subscription",
];
/** Request caps of one probe (all briefs together). */
export const PROBE_LIMITS = { searches: 20, downloads: 10 };
/** Request cap and page size of one recording. */
export const RECORD_LIMITS = { searches: 20, perPage: 15 };

const LABEL = { pexels: "Pexels", pixabay: "Pixabay" };
const PROVIDERS = ["pexels", "pixabay"];

/** Keys of the step env by provider (trimmed; a missing key is absent). */
export function stockKeys(env) {
  const out = {};
  for (const p of PROVIDERS) {
    const v = String(env[STOCK_KEY_INPUTS[p]] ?? "").trim();
    if (v) out[p] = v;
  }
  return out;
}

/** Text with every key value (and its URL-encoded form) replaced by «***». */
export function scrubKeys(text, keys) {
  let out = String(text);
  for (const k of Object.values(keys ?? {})) {
    if (!k || k.length < 4) continue;
    for (const v of new Set([k, encodeURIComponent(k)])) out = out.split(v).join("***");
  }
  return out;
}

/** Workflow-command data escaping (%, CR, LF). */
const escapeData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** `::level title=…::text` (multi-line text kept as %0A). */
export function annotation(level, title, text) {
  return `::${level} title=${title}::${escapeData(text)}`;
}

/** Splits `total` requests between needs one by one (round robin), never above a need. */
export function allocate(needs, total) {
  const out = needs.map(() => 0);
  let left = total;
  for (let moved = true; left > 0 && moved; ) {
    moved = false;
    for (let i = 0; i < needs.length && left > 0; i++) {
      if (out[i] < needs[i]) {
        out[i]++;
        left--;
        moved = true;
      }
    }
  }
  return out;
}

/** A refused request: the cap of the probe, not a stock failure. */
export class ProbeLimit extends Error {
  constructor(kind) {
    super(`probe limit: ${kind}`);
    this.name = "ProbeLimit";
    this.kind = kind;
  }
}

/** «HTTP 401», «RATE_LIMITED», «TIMEOUT»… of a stock error: codes and numbers only. */
export function errorCode(e) {
  const code = typeof e?.code === "string" ? e.code : "ERROR";
  const http = /\((\d{3})\)/.exec(String(e?.message ?? ""))?.[1];
  return code === "HTTP" && http ? `HTTP ${http}` : code;
}

const emptyProviderStats = () => ({ searches: 0, found: 0, downloads: 0, bytes: 0, errors: [] });

/**
 * The stock client of one brief: the brief's quota of searches and downloads (ProbeLimit beyond it), the providers in
 * `order`, every result counted into `stats` (shared by the probe) and `own` (this brief).
 */
export function meteredStock(inner, { quota, order, stats, own }) {
  const count = (provider) => {
    stats.providers[provider] ??= emptyProviderStats();
    return stats.providers[provider];
  };
  return {
    providers: order.filter((p) => inner.providers.includes(p)),
    async search(provider, q, perPage, signal) {
      if (quota.searches <= 0) {
        own.limited++;
        throw new ProbeLimit("search");
      }
      quota.searches--;
      stats.searches++;
      own.searches++;
      try {
        const hits = await inner.search(provider, q, perPage, signal);
        count(provider).searches++;
        count(provider).found += hits.length;
        own.found += hits.length;
        return hits;
      } catch (e) {
        count(provider).errors.push(errorCode(e));
        own.errors++;
        throw e;
      }
    },
    async download(hit, signal) {
      if (quota.downloads <= 0) {
        own.limited++;
        throw new ProbeLimit("download");
      }
      quota.downloads--;
      stats.downloads++;
      try {
        const bytes = await inner.download(hit, signal);
        count(hit.provider).downloads++;
        count(hit.provider).bytes += bytes.byteLength;
        return bytes;
      } catch (e) {
        count(hit.provider).errors.push(errorCode(e));
        own.errors++;
        throw e;
      }
    },
  };
}

/** The TypeScript modules the probe and the recording use (tsx is registered by `main`; vitest imports TS itself). */
export async function loadAgents() {
  const at = (p) => import(pathToFileURL(join(ROOT, p)).href);
  const [builder, planner, modules, scenarios] = await Promise.all([
    at("packages/agents/src/builder/index.ts"),
    at("packages/agents/src/planner/index.ts"),
    at("packages/modules/src/index.ts"),
    at("packages/agents/test/design-mvp-scenarios.ts"),
  ]);
  return { ...builder, ...planner, ...modules, DESIGN_SCENARIOS: scenarios.DESIGN_SCENARIOS };
}

/** The plan the photos stage gets for a brief: the planner's plan finalized and compiled, the recorded design merged. */
export function probePlan(agents, brief) {
  const sc = agents.DESIGN_SCENARIOS.find((s) => s.brief === brief);
  if (!sc) throw new Error(`бриф ${brief}: нет записанного плана (design-mvp-scenarios.ts)`);
  const reg = agents.DEFAULT_REGISTRY;
  const c = agents.compilePlan(agents.finalizePlan(sc.plan, reg), reg);
  if (!c.ok) throw new Error(`бриф ${brief}: план не собирается`);
  return agents.mergeDesign(c.plan, sc.design, reg);
}

/** Briefs of `--briefs` (comma list of 3–5 mvp ids), else PROBE_BRIEFS. */
export function probeBriefs(arg) {
  const v = String(arg ?? "").trim();
  if (!v) return PROBE_BRIEFS;
  if (!/^[a-z0-9-]+(,[a-z0-9-]+)*$/.test(v)) throw new Error("briefs: id брифов mvp через запятую");
  const list = [...new Set(v.split(","))];
  if (list.length < 3 || list.length > 5) throw new Error("briefs: от 3 до 5 брифов");
  if (!list.every((b) => b.startsWith("mvp-"))) throw new Error("briefs: только брифы mvp");
  return list;
}

/**
 * The probe: per brief its share of the request caps (allocate by photo places and search groups), the providers
 * alternating first (Pexels on even briefs, Pixabay on odd ones, so both are downloaded from), the photo library in
 * memory. Returns numbers only.
 */
export async function runProbe({
  env,
  fetch: f = fetch,
  agents,
  briefs = PROBE_BRIEFS,
  limits = PROBE_LIMITS,
  now = Date.now,
}) {
  const keys = stockKeys(env);
  const result = {
    keys: PROVIDERS.filter((p) => keys[p]),
    briefs: [],
    providers: {},
    searches: 0,
    downloads: 0,
    limits,
    ms: 0,
  };
  for (const p of result.keys) result.providers[p] = emptyProviderStats();
  if (result.keys.length === 0) return { ...result, verdict: "no_keys" };
  const inner = agents.createStockClient({ fetch: f, keys });
  const plans = briefs.map((b) => probePlan(agents, b));
  // photoSlots' default cap is MAX_PLAN_PHOTOS, the one the stage uses.
  const slots = plans.map((p) => agents.photoSlots(p));
  const groups = slots.map((s) => new Set(s.map((x) => `${x.type}|${x.orientation}`)).size);
  const searchQuota = allocate(
    groups.map((g) => g * result.keys.length),
    limits.searches,
  );
  const downloadQuota = allocate(
    slots.map((s) => s.length),
    limits.downloads,
  );
  const t0 = now();
  for (const [i, plan] of plans.entries()) {
    const own = { searches: 0, found: 0, errors: 0, limited: 0 };
    const order = i % 2 === 0 ? PROVIDERS : [...PROVIDERS].reverse();
    const stock = meteredStock(inner, {
      quota: { searches: searchQuota[i], downloads: downloadQuota[i] },
      order,
      stats: result,
      own,
    });
    const store = async (hit) => ({ id: randomUUID(), width: hit.width, height: hit.height });
    const b0 = now();
    const r = await agents.runPhotosStage({ plan, host: { stock, store }, now });
    const byProvider = {};
    for (const ph of r.plan.design.photos ?? []) byProvider[ph.provider] = (byProvider[ph.provider] ?? 0) + 1;
    result.briefs.push({
      id: briefs[i],
      niche: plan.niche,
      slots: r.slots,
      picked: r.picked,
      byProvider,
      found: own.found,
      searches: own.searches,
      errors: own.errors,
      limited: own.limited,
      ms: now() - b0,
    });
  }
  result.ms = now() - t0;
  return { ...result, verdict: probeVerdict(result) };
}

/** ok — every keyed provider searched and downloaded without errors; partial — photos but problems; fail — none. */
export function probeVerdict(r) {
  if (r.keys.length === 0) return "no_keys";
  const picked = r.briefs.reduce((s, b) => s + b.picked, 0);
  if (picked === 0) return "fail";
  const healthy = r.keys.every((p) => {
    const s = r.providers[p] ?? emptyProviderStats();
    return s.searches > 0 && s.errors.length === 0;
  });
  return healthy && r.keys.length === PROVIDERS.length ? "ok" : "partial";
}

const VERDICT_TEXT = {
  ok: "стоки работают",
  partial: "есть замечания",
  fail: "фото не подобраны",
  no_keys: "ключей нет — проверка не проводилась",
};
const LEVEL = { ok: "notice", partial: "warning", fail: "error", no_keys: "error" };

const sec = (ms) => `${(ms / 1000).toFixed(1)} с`;
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} МБ`;
const clean = (s) =>
  String(s ?? "")
    .replace(/[\r\n|`<>]/g, " ")
    .slice(0, 60);

/** One problem list «HTTP 401 ×3, TIMEOUT ×1». */
export const errorList = (errors) => {
  const n = new Map();
  for (const e of errors) n.set(e, (n.get(e) ?? 0) + 1);
  return [...n].map(([e, k]) => `${e} ×${k}`).join(", ");
};

/** Lines of the probe result (numbers, niches of the recorded plans, provider names and error codes only). */
export function probeLines(r) {
  const lines = [`Проба этапа фото: ${VERDICT_TEXT[r.verdict]}`];
  lines.push(
    `Ключи: ${PROVIDERS.map((p) => `${LABEL[p]} — ${r.keys.includes(p) ? "есть" : "нет"}`).join(", ")}`,
  );
  if (r.verdict === "no_keys") return lines;
  for (const p of r.keys) {
    const s = r.providers[p] ?? emptyProviderStats();
    const state =
      s.errors.length === 0
        ? s.searches > 0
          ? "работает"
          : "не спрашивали"
        : s.searches > 0
          ? `ошибки: ${errorList(s.errors)}`
          : `не работает: ${errorList(s.errors)}`;
    lines.push(
      `${LABEL[p]}: поисков ${s.searches}, найдено ${s.found}, скачано ${s.downloads} (${mb(s.bytes)}) — ${state}`,
    );
  }
  for (const b of r.briefs) {
    const by = Object.entries(b.byProvider)
      .sort(([a], [c]) => (a < c ? -1 : 1))
      .map(([p, n]) => `${p} ${n}`)
      .join(", ");
    const missing = b.slots - b.picked;
    const why = b.limited > 0 ? "лимит пробы" : b.errors > 0 ? "ошибка стока" : "не нашлось подходящих";
    lines.push(
      `${b.id} · ${clean(b.niche)}: мест ${b.slots}, выбрано ${b.picked}${by ? ` (${by})` : ""}` +
        `${missing > 0 ? `, без фото ${missing} — ${why}` : ""}; поисков ${b.searches}, найдено ${b.found}; ${sec(b.ms)}`,
    );
  }
  const slots = r.briefs.reduce((s, b) => s + b.slots, 0);
  const picked = r.briefs.reduce((s, b) => s + b.picked, 0);
  lines.push(
    `Итого: выбрано ${picked} из ${slots} мест; поисков ${r.searches} из ${r.limits.searches}, ` +
      `скачиваний ${r.downloads} из ${r.limits.downloads}; ${sec(r.ms)}`,
  );
  return lines;
}

/** The probe annotation (notice / warning / error by the verdict). */
export function probeAnnotation(r) {
  return annotation(LEVEL[r.verdict], "Стоки: проба этапа фото", probeLines(r).join("\n"));
}

/**
 * A comment in the issue STOCK_ISSUE_TITLE (created once, found by title among all issues). Returns the comment URL,
 * or null without a token. Throws on an API error (the caller turns it into a warning).
 */
export async function postIssueComment({ token, repo, body, fetch: f = fetch, title = STOCK_ISSUE_TITLE }) {
  if (!token || !repo) return null;
  const api = async (method, path, payload) => {
    const r = await f(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (!r.ok) throw new Error(`GitHub API ${method} ${path.split("?")[0]}: HTTP ${r.status}`);
    return r.json();
  };
  const list = await api("GET", "/issues?state=all&per_page=100&sort=created&direction=asc");
  let issue = list.find((i) => i.title === title && !i.pull_request);
  if (!issue)
    issue = await api("POST", "/issues", {
      title,
      body: "Проверки ключей стоков (Pexels, Pixabay) из GitHub Actions: workflow «stock», по комментарию на пробу. Только числа — без ключей, авторов и ссылок на фото (docs/ops/eval-d76.md «Стоки из CI»).",
    });
  const c = await api("POST", `/issues/${issue.number}/comments`, { body });
  return c.html_url ?? null;
}

/** The issue comment of a probe: the run, then the same lines as the annotation. */
export function probeComment(r, { runUrl } = {}) {
  return [
    `### Проба стоков${runUrl ? ` · [задание](${runUrl})` : ""}`,
    "",
    ...probeLines(r).map((l) => `- ${l}`),
  ].join("\n");
}

/** `check`: both key verdicts (preflight) as one annotation; exit 1 when a key is missing or refused. */
export async function runCheck({ env, fetch: f = fetch, log = console.log }) {
  const keys = stockKeys(env);
  const verdicts = await stockKeyVerdicts(env, { fetch: f });
  log(scrubKeys(stockAnnotation(verdicts), keys));
  return verdicts.some((v) => v.verdict === "invalid" || v.verdict === "missing") ? 1 : 0;
}

/**
 * `record`: the Pexels answers of `queries` ([text, orientation]) into `dir`/pexels.recorded.json through the record
 * fetch (sanitizeStockAnswer). The written file is checked for the keys before anything else sees it.
 */
export async function runRecord({
  env,
  fetch: f = fetch,
  agents,
  dir = STOCK_DIR,
  queries,
  limits = RECORD_LIMITS,
  log = console.log,
}) {
  const keys = stockKeys(env);
  const title = "Стоки: запись фикстур";
  if (!keys.pexels) {
    log(annotation("error", title, "нет ключа Pexels (PEXELS_API_KEY) — записывать нечего"));
    return { code: 1, recorded: 0, photos: 0, errors: [] };
  }
  const secrets = Object.values(keys);
  const client = agents.createStockClient({
    fetch: agents.recordingStockFetch(f, dir, { secrets }),
    keys: { pexels: keys.pexels },
  });
  let recorded = 0;
  let photos = 0;
  const errors = [];
  for (const [text, orientation] of queries.slice(0, limits.searches)) {
    try {
      photos += (await client.search("pexels", { text, orientation }, limits.perPage)).length;
      recorded++;
    } catch (e) {
      errors.push(errorCode(e));
    }
  }
  const file = agents.recordedFile(dir, "pexels");
  const written = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (secrets.some((k) => written.includes(k) || written.includes(encodeURIComponent(k))))
    throw new Error("в записи остался ключ — запись отменена");
  const asked = Math.min(queries.length, limits.searches);
  const text =
    `Pexels: записано запросов ${recorded} из ${asked}, фото в ответах ${photos}` +
    `${errors.length ? `; ошибки: ${errorList(errors)}` : ""}. ` +
    "Pixabay не записывается: по условиям API ответы кешируются на 24 часа, а не хранятся.";
  log(annotation(recorded === 0 ? "error" : errors.length ? "warning" : "notice", title, text));
  return { code: recorded === 0 ? 1 : 0, recorded, photos, errors };
}

/** Registers tsx (the TypeScript packages of the workspace), as tools/eval/run.mjs does. */
export async function registerTsx() {
  let loader;
  for (const base of [import.meta.url, pathToFileURL(join(ROOT, "apps", "runtime", "package.json")).href]) {
    try {
      loader = createRequire(base).resolve("tsx");
      break;
    } catch {}
  }
  if (!loader) throw new Error("не найден tsx: выполните pnpm install");
  const { register } = await import(pathToFileURL(join(dirname(loader), "esm", "api", "index.mjs")).href);
  register();
}

const argOf = (argv, name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};

/** CLI; returns the exit code. `agents` (tests) skips tsx and the module loading. */
export async function main(argv, { env = process.env, fetch: f = fetch, log = console.log, agents } = {}) {
  const keys = stockKeys(env);
  const ts = async () => {
    if (agents) return agents;
    await registerTsx();
    return loadAgents();
  };
  const out = (line) => log(scrubKeys(line, keys));
  const [action, ...rest] = argv;
  if (action === "check") return runCheck({ env, fetch: f, log: out });
  if (action === "probe") {
    const briefs = probeBriefs(argOf(rest, "briefs") ?? env.STOCK_PROBE_BRIEFS);
    const r = await runProbe({ env, fetch: f, agents: await ts(), briefs });
    out(probeAnnotation(r));
    try {
      const url = await postIssueComment({
        token: env.GITHUB_TOKEN,
        repo: env.GITHUB_REPOSITORY,
        fetch: f,
        body: scrubKeys(probeComment(r, { runUrl: env.RUN_URL }), keys),
      });
      if (url) out(`комментарий в issue «${STOCK_ISSUE_TITLE}»: ${url}`);
    } catch (e) {
      out(annotation("warning", "Стоки: issue", `комментарий не опубликован: ${e.message}`));
    }
    return ["ok", "partial"].includes(r.verdict) ? 0 : 1;
  }
  if (action === "record") {
    const a = await ts();
    const { QUERIES } = await import(pathToFileURL(join(STOCK_DIR, "gen.mjs")).href);
    const dir = argOf(rest, "dir") ?? STOCK_DIR;
    return (await runRecord({ env, fetch: f, agents: a, dir, queries: QUERIES, log: out })).code;
  }
  out(annotation("error", "Стоки", "действие: check | probe | record"));
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keys = stockKeys(process.env);
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.log(annotation("error", "Стоки", scrubKeys(e instanceof Error ? e.message : String(e), keys)));
      process.exitCode = 1;
    },
  );
}
