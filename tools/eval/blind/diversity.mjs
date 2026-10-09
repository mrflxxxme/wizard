// V3-40: diversity of the final v3 measurement (docs/plans/2026-10-08-v3.md §6 (3)) — how much the sites of one niche
// repeat each other. The metric is the template gate's own (V3-14, packages/gates/src/template/similarity.ts:
// siteSimilarity over the fingerprints the build stored — structure, DOM shapes, perceptual hashes of the 390 and
// 1440 px screenshots — and its thresholds); nothing here measures similarity a second way. A niche of the
// measurement is the class of its briefs (3 per class), plus any pair the gate itself put in one niche.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The module of the template gate's metric (TypeScript of @wizard/gates). */
export const SIMILARITY_MODULE = join(ROOT, "packages", "gates", "src", "template", "similarity.ts");

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * The template gate's metric loaded through tsx (architecture.yaml#stack.dev_exec), as tools/eval/run.mjs loads the
 * harness: {siteSimilarity, thresholdOf, TEMPLATE_THRESHOLD, TEMPLATE_STRUCTURE_THRESHOLD}. Throws an Error in Russian
 * when tsx is not installed (pnpm install).
 */
export async function loadTemplateMetric() {
  let loader;
  for (const base of [import.meta.url, pathToFileURL(join(ROOT, "apps", "runtime", "package.json")).href]) {
    try {
      loader = createRequire(base).resolve("tsx");
      break;
    } catch {}
  }
  if (!loader) throw new Error("не найден tsx для метрики шаблонности: выполните pnpm install");
  const { register } = await import(pathToFileURL(join(dirname(loader), "esm", "api", "index.mjs")).href);
  register();
  const m = await import(pathToFileURL(SIMILARITY_MODULE).href);
  return {
    siteSimilarity: m.siteSimilarity,
    thresholdOf: m.thresholdOf,
    TEMPLATE_THRESHOLD: m.TEMPLATE_THRESHOLD,
    TEMPLATE_STRUCTURE_THRESHOLD: m.TEMPLATE_STRUCTURE_THRESHOLD,
  };
}

/**
 * The sites of the measurement with their stored fingerprints: `items` — results of the final run ({id, class,
 * systemId}), `fingerprints` — db.v3.fingerprints of collect ({systemId: {niche, archetype, fingerprint}}). → {sites:
 * [{id, class, niche, archetype, fingerprint}], missing: [brief ids without a fingerprint]}.
 */
export function diversitySites(items, fingerprints = {}) {
  const sites = [];
  const missing = [];
  for (const x of items) {
    const f = x.systemId ? fingerprints?.[x.systemId] : null;
    if (!f?.fingerprint?.pages) {
      missing.push(x.id);
      continue;
    }
    sites.push({
      id: x.id,
      class: x.class ?? null,
      niche: f.niche ?? null,
      archetype: f.archetype ?? null,
      fingerprint: f.fingerprint,
    });
  }
  return { sites, missing };
}

/**
 * Pairwise similarity inside each niche: every two sites of one class (or of one niche of the gate). siteSimilarity is
 * asymmetric on purpose (is the new site a copy), so a pair scores the larger of the two directions, against the
 * threshold of that direction's mode (full — with rendered views, structure — without). → {pairs (most similar first:
 * {a, b, class, niche, score, mode, threshold, over, archetypes}), max, over, passed (null — no pair to compare)}.
 */
export function diversityPairs(sites, metric) {
  const pairs = [];
  const list = [...sites].sort((x, y) => x.id.localeCompare(y.id));
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const sameClass = a.class !== null && a.class === b.class;
      const sameNiche = a.niche !== null && a.niche === b.niche;
      if (!sameClass && !sameNiche) continue;
      const ab = metric.siteSimilarity(a.fingerprint, b.fingerprint);
      const ba = metric.siteSimilarity(b.fingerprint, a.fingerprint);
      const top = ab.score >= ba.score ? ab : ba;
      const threshold = metric.thresholdOf(top.mode);
      pairs.push({
        a: a.id,
        b: b.id,
        class: sameClass ? a.class : null,
        niche: sameNiche ? a.niche : null,
        score: round3(top.score),
        mode: top.mode,
        threshold,
        over: top.score >= threshold,
        archetypes: [a.archetype, b.archetype],
      });
    }
  pairs.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  const over = pairs.filter((p) => p.over);
  return { pairs, max: pairs[0] ?? null, over, passed: pairs.length ? over.length === 0 : null };
}

/**
 * The diversity of a final run, never throwing: the fingerprints of db.v3 compared by the template gate's metric
 * (`metric`, or loaded through tsx). → {status: "done", sites, missing, ...diversityPairs} | {status: "pending", why}.
 */
export async function measureDiversity(items, db, { metric = null, load = loadTemplateMetric } = {}) {
  const fps = db?.v3?.fingerprints;
  if (!fps || Object.keys(fps).length === 0)
    return {
      status: "pending",
      why: "отпечатков сайтов нет в выгрузке замера (collect финального замера с v3fingerprints)",
    };
  const { sites, missing } = diversitySites(items, fps);
  if (sites.length < 2) return { status: "pending", why: "меньше двух сайтов с отпечатками", missing };
  let m = metric;
  if (!m)
    try {
      m = await load();
    } catch (e) {
      return { status: "pending", why: String(e?.message ?? e), missing };
    }
  return { status: "done", sites: sites.length, missing, ...diversityPairs(sites, m) };
}
