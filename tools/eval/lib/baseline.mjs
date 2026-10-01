// Baseline and regression (specs/quality/eval.yaml#regression). Pure functions; the file is tools/eval/baseline.json.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASELINE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "baseline.json");
/** eval.yaml#regression.rule: a drop of more than 5 p.p. fails. */
export const REGRESSION_PP = 0.05;
export const REGRESSION_METRICS = ["g0_pass", "g0g1_pass"];

const sha = (s) => createHash("sha256").update(s).digest("hex");
const canon = (v) =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon(v[k])]),
        )
      : v;

/** Content hash of one brief (text, expected, answers…): editing a brief invalidates its baseline. */
export const briefKey = (b) => `${b.id}@${sha(JSON.stringify(canon(b))).slice(0, 12)}`;
/** Hash of a brief set (order-independent). */
export const briefSetHash = (briefs) => sha(briefs.map(briefKey).sort().join("\n")).slice(0, 16);
/** Baseline mode of a result: harness-fixture | harness-live | harness-record | spec_only. */
export const baselineMode = (result) =>
  result.mode === "harness" ? `harness-${result.llm_mode}` : String(result.mode);

/** Current drop vs base is a regression (strictly more than `pp`; null = not measured). */
export function isRegression(base, cur, pp = REGRESSION_PP) {
  if (base === null || base === undefined || cur === null || cur === undefined) return false;
  return base - cur > pp + 1e-9;
}

const share = (xs) => (xs.length ? xs.filter(Boolean).length / xs.length : null);

/**
 * Baseline entries of a result, one per model: shares over the evaluated (non-skipped) runs and per-brief flags,
 * so a nightly subset can be compared against a full-set baseline. g0g1_pass is null when G1 was not run.
 */
export function baselineEntries(result, briefs, meta = {}) {
  const byId = new Map(briefs.map((b) => [b.id, b]));
  const runs = result.runs.filter((r) => !r.skipped && byId.has(r.brief));
  const models = [...new Set(runs.map((r) => r.model))];
  return models.map((modelId) => {
    const rs = runs.filter((r) => r.model === modelId);
    const g1 = rs.filter((r) => !r.g1_skipped);
    const per_brief = {};
    for (const r of rs)
      per_brief[briefKey(byId.get(r.brief))] = {
        g0_pass: r.g0_pass,
        g0g1_pass: r.g1_skipped ? null : r.g0g1_pass,
      };
    return {
      mode: baselineMode(result),
      modelId,
      briefSetHash: briefSetHash(rs.map((r) => byId.get(r.brief))),
      metrics: {
        n: rs.length,
        g0_pass: share(rs.map((r) => r.g0_pass)),
        g0g1_pass: g1.length ? share(g1.map((r) => r.g0g1_pass)) : null,
      },
      per_brief,
      commit: meta.commit ?? null,
      date: (meta.date ?? result.started_at ?? new Date().toISOString()).slice(0, 10),
    };
  });
}

/** Share of `metric` over `keys` in a baseline entry's per_brief (null if any key or value is missing). */
function subsetShare(entry, keys, metric) {
  const vals = keys.map((k) => entry.per_brief?.[k]?.[metric]);
  if (!keys.length || vals.some((v) => v === undefined || v === null)) return null;
  return vals.filter(Boolean).length / vals.length;
}

/**
 * Compare a result with the baseline (same mode and modelId): the same brief set → stored aggregates; a subset
 * (nightly rotation) → shares recomputed from per_brief of a baseline covering all current briefs.
 * Returns {regressions: string[], compared: {...}[], notes: string[]} (Russian lines).
 */
export function compareToBaseline(result, briefs, baseline) {
  const out = { regressions: [], compared: [], notes: [] };
  if (result.dry_run) return out;
  for (const cur of baselineEntries(result, briefs)) {
    const same = (baseline?.entries ?? []).filter((e) => e.mode === cur.mode && e.modelId === cur.modelId);
    const keys = Object.keys(cur.per_brief);
    const exact = same.findLast((e) => e.briefSetHash === cur.briefSetHash);
    const cover = exact ?? same.findLast((e) => keys.every((k) => k in (e.per_brief ?? {})));
    if (!cover) {
      out.notes.push(
        `${cur.modelId} (${cur.mode}): нет baseline для набора ${cur.briefSetHash} — регрессия не проверялась`,
      );
      continue;
    }
    for (const metric of REGRESSION_METRICS) {
      const base = exact ? exact.metrics[metric] : subsetShare(cover, keys, metric);
      const now = cur.metrics[metric];
      if (base === null || base === undefined || now === null) continue;
      out.compared.push({ modelId: cur.modelId, mode: cur.mode, metric, base, cur: now, subset: !exact });
      if (isRegression(base, now))
        out.regressions.push(
          `${cur.modelId} (${cur.mode}): ${metric} ${pct(now)} против baseline ${pct(base)} (${cover.date}) — падение больше ${REGRESSION_PP * 100} п. п.`,
        );
    }
  }
  return out;
}

const pct = (x) => `${Math.round(x * 1000) / 10}%`;

export function loadBaseline(file = BASELINE_FILE) {
  if (!existsSync(file)) return { v: 1, entries: [] };
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Replace entries with the same (mode, modelId, briefSetHash) and write the file (eval.yaml#regression.update). */
export function updateBaseline(baseline, entries, file = BASELINE_FILE) {
  const same = (a, b) => a.mode === b.mode && a.modelId === b.modelId && a.briefSetHash === b.briefSetHash;
  const kept = (baseline.entries ?? []).filter((e) => !entries.some((n) => same(e, n)));
  const next = { v: 1, entries: [...kept, ...entries] };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
