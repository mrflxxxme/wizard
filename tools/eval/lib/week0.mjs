// Week-0 decision (product.yaml#decisions.D2_w0_fallback, agents/models.yaml#week0_decision) over run.mjs results.
// Pure functions; the CLI is tools/eval/week0.mjs.

export const THRESHOLD_PP = 10;
export const DEFAULT_T1_MODEL = "glm-5.3";

const EPS = 1e-9;
const r1 = (x) => Math.round(x * 10) / 10;

/** Merge runs of one or more run.mjs result files; a later file wins for the same model × brief. */
export function mergeRuns(results) {
  const byKey = new Map();
  for (const res of results) {
    if (!Array.isArray(res?.runs))
      throw new Error("файл результатов без массива runs (ожидается вывод tools/eval/run.mjs)");
    for (const run of res.runs) {
      if (run.skipped) continue; // harness: brief without a fixture — not a result of the model
      byKey.set(`${run.model}\u0000${run.brief}`, run);
    }
  }
  return [...byKey.values()];
}

/** Per-model metrics on the given briefs: share of AppSpec valid on the first attempt and mean score (0 for invalid). */
export function modelStats(runs, model, briefs) {
  const rs = runs.filter((r) => r.model === model && briefs.includes(r.brief));
  const n = rs.length;
  const firstTry = rs.filter((r) => r.valid && r.attempts === 1).length;
  const valid = rs.filter((r) => r.valid).length;
  const score = n ? rs.reduce((a, r) => a + (r.valid ? Number(r.score?.total ?? 0) : 0), 0) / n : 0;
  return {
    model,
    tier: rs[0]?.tier ?? null,
    n,
    firstTryValid: n ? firstTry / n : 0,
    valid: n ? valid / n : 0,
    score,
  };
}

/**
 * D2_w0_fallback: T1 by default only if the T1 model beats the best T0 model (ranked by first-try validity, then score)
 * by ≥ threshold p.p. on BOTH first-try validity and score, on the same briefs, and Z.ai terms are not unconfirmed.
 */
export function decideWeek0(results, opts = {}) {
  const threshold = opts.thresholdPp ?? THRESHOLD_PP;
  const runs = mergeRuns(results);
  const t1Models = [...new Set(runs.filter((r) => r.tier === "T1").map((r) => r.model))];
  const t1 = opts.t1Model ?? (t1Models.includes(DEFAULT_T1_MODEL) ? DEFAULT_T1_MODEL : t1Models[0]);
  if (!t1 || !runs.some((r) => r.model === t1))
    throw new Error("в результатах нет прогонов T1-модели (GLM-5.3)");
  const t0Models = [...new Set(runs.filter((r) => r.tier === "T0").map((r) => r.model))].sort();
  if (!t0Models.length) throw new Error("в результатах нет прогонов T0-моделей");

  const briefsOf = (m) => new Set(runs.filter((r) => r.model === m).map((r) => r.brief));
  let briefs = [...briefsOf(t1)];
  for (const m of t0Models) {
    const b = briefsOf(m);
    briefs = briefs.filter((x) => b.has(x));
  }
  briefs.sort();
  if (!briefs.length) throw new Error("у T1 и T0-моделей нет общих брифов");

  const t0 = t0Models
    .map((m) => modelStats(runs, m, briefs))
    .sort((a, b) => b.firstTryValid - a.firstTryValid || b.score - a.score || a.model.localeCompare(b.model));
  const t1Stats = modelStats(runs, t1, briefs);
  const best = t0[0];
  const gapValidPp = r1((t1Stats.firstTryValid - best.firstTryValid) * 100);
  const gapScorePp = r1((t1Stats.score - best.score) * 100);

  const reasons = [];
  if (gapValidPp < threshold - EPS)
    reasons.push(`разрыв по валидности с первой попытки ${gapValidPp} п. п. < ${threshold}`);
  if (gapScorePp < threshold - EPS) reasons.push(`разрыв по скору ${gapScorePp} п. п. < ${threshold}`);
  if (opts.zaiTermsConfirmed === false)
    reasons.push("Z.ai не подтвердил условия работы с РФ и отсутствие хранения (E-LEGAL)");
  const tier = reasons.length ? "T0" : "T1";

  const dryRun = results.some((r) => r.dry_run === true);
  return {
    tier,
    reasons,
    threshold,
    t1: t1Stats,
    bestT0: best,
    t0,
    briefs,
    gapValidPp,
    gapScorePp,
    dryRun,
    zaiTermsConfirmed: opts.zaiTermsConfirmed ?? null,
    sources: results.map((r) => ({ started_at: r.started_at ?? null, dry_run: r.dry_run === true })),
  };
}

const pct = (x) => `${r1(x * 100)}%`;

/** Russian markdown report tools/eval/results/week0.md. */
export function renderWeek0Report(d, { generatedAt = new Date().toISOString() } = {}) {
  const L = [];
  L.push("# Eval недели 0: GLM-5.3 (T1) против лучшей T0-модели");
  L.push("");
  L.push(
    `Сформирован: ${generatedAt}. Правило: product.yaml#decisions.D2_w0_fallback, agents/models.yaml#week0_decision.`,
  );
  if (d.dryRun) {
    L.push("");
    L.push(
      "> **DRY-RUN.** Хотя бы один файл результатов получен на заглушке (`--dry-run`). Решение не применять.",
    );
  }
  L.push("");
  L.push(`Брифов (общих для всех моделей): ${d.briefs.length} — ${d.briefs.join(", ")}.`);
  L.push("");
  L.push("| Модель | Уровень | Прогонов | Валидно с первой попытки | Валидно всего | Скор |");
  L.push("|---|---|---|---|---|---|");
  for (const s of [d.t1, ...d.t0]) {
    const mark = s.model === d.bestT0.model ? " (лучшая T0)" : "";
    L.push(
      `| ${s.model}${mark} | ${s.tier} | ${s.n} | ${pct(s.firstTryValid)} | ${pct(s.valid)} | ${s.score.toFixed(3)} |`,
    );
  }
  L.push("");
  L.push(
    `Разрыв ${d.t1.model} − ${d.bestT0.model}: валидность с первой попытки **${d.gapValidPp} п. п.**, скор **${d.gapScorePp} п. п.** (порог ${d.threshold} п. п. по обоим).`,
  );
  if (d.zaiTermsConfirmed !== null)
    L.push(`Условия Z.ai (E-LEGAL): ${d.zaiTermsConfirmed ? "подтверждены" : "не подтверждены"}.`);
  L.push("");
  L.push(`## Решение: сборка по умолчанию — ${d.tier === "T0" ? "T0 (модели в РФ)" : "T1 (GLM-5.3)"}`);
  L.push("");
  if (d.reasons.length) for (const r of d.reasons) L.push(`- ${r}`);
  else
    L.push(
      `- ${d.t1.model} лучше ${d.bestT0.model} не меньше чем на ${d.threshold} п. п. по обоим показателям`,
    );
  L.push("");
  L.push(
    `Параметр: \`WIZARD_BUILD_DEFAULT_TIER=${d.tier}\` (packages/llm createRegistry; agents/models.yaml#week0_decision.switch${d.tier === "T0" ? ", t1_default: false" : ""}).`,
  );
  return `${L.join("\n")}\n`;
}
