// Result files and reports (specs/quality/eval.yaml#report, #thresholds). Pure functions shared by both modes.

export function parseArgs(argv) {
  return Object.fromEntries(
    argv.map((a) => {
      const s = a.replace(/^--/, "");
      const i = s.indexOf("=");
      return i === -1 ? [s, true] : [s.slice(0, i), s.slice(i + 1)];
    }),
  );
}

/** "<ISO date-time>" usable in a file name: 2026-09-30T12-00-00-000Z. */
export const resultStamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, "-");

/**
 * Result file base name (eval.yaml#report.outputs): live → <YYYY-MM-DD>-harness (committed report, one per day);
 * otherwise <stamp>-harness-fixture|-record|-dry (local only, see tools/eval/.gitignore).
 */
export function harnessBaseName(started, { llmMode, dryRun }) {
  if (!dryRun && llmMode === "live") return `${started.toISOString().slice(0, 10)}-harness`;
  return `${resultStamp(started)}-harness-${dryRun ? "dry" : llmMode}`;
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const share = (xs) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);
const pct = (x) => `${Math.round(x * 100)}%`;
const f1 = (x) => (x === null || x === undefined ? "—" : x.toFixed(1));
const f2 = (x) => (x === null || x === undefined ? "—" : x.toFixed(2));
const tok = (t) => `${t.input} / ${t.cached} / ${t.output}`;

/** Aggregates of harness runs per model (skipped runs excluded). */
export function aggregateHarness(runs) {
  const models = [...new Set(runs.map((r) => r.model))];
  return models.map((model) => {
    const rs = runs.filter((r) => r.model === model && !r.skipped);
    const previews = rs.map((r) => r.first_preview_minutes).filter((x) => x !== null);
    const ratios = rs.map((r) => r.estimate_ratio).filter((x) => x !== null);
    return {
      model,
      tier: rs[0]?.tier ?? null,
      n: rs.length,
      g0_pass: share(rs.map((r) => r.g0_pass)),
      // null when G1 was not run for any of them (--gates=G0).
      g0g1_pass: rs.some((r) => !r.g1_skipped)
        ? share(rs.filter((r) => !r.g1_skipped).map((r) => r.g0g1_pass))
        : null,
      coverage: avg(rs.map((r) => r.coverage)),
      tokens: {
        input: Math.round(avg(rs.map((r) => r.tokens.input))),
        cached: Math.round(avg(rs.map((r) => r.tokens.cached))),
        output: Math.round(avg(rs.map((r) => r.tokens.output))),
      },
      cost_rub: sum(rs.map((r) => r.cost_rub)),
      credits: avg(rs.map((r) => r.credits)),
      minutes: avg(rs.map((r) => r.minutes)),
      first_preview_minutes: previews.length ? avg(previews) : null,
      questions_asked: avg(rs.map((r) => r.questions_asked)),
      estimate_ratio: ratios.length ? avg(ratios) : null,
      escalations: sum(rs.map((r) => r.escalations)),
      budget_exceeded: rs.filter((r) => r.budget_exceeded).length,
      pii_leaks: sum(rs.map((r) => r.pii_leaks)),
      fallback_rate: avg(rs.map((r) => r.fallback_rate)),
      fixture_miss: rs.filter((r) => r.fixture_miss).length,
    };
  });
}

/**
 * Hard thresholds (eval.yaml#thresholds.hard) that apply to this result: pii_leaks = 0 always; in fixture mode no
 * FIXTURE_MISS and G0/G1 passed on the demo fixtures (forum, bakery).
 */
export function hardViolations(result) {
  const out = [];
  for (const r of result.runs.filter((x) => !x.skipped)) {
    if (r.pii_leaks > 0) out.push(`${r.model} / ${r.brief}: pii_leaks = ${r.pii_leaks}`);
    if (result.llm_mode === "fixture" && r.fixture_miss) out.push(`${r.model} / ${r.brief}: FIXTURE_MISS`);
    const demo = result.llm_mode === "fixture" && !result.dry_run && r.fixture?.startsWith("demo/");
    if (demo && !r.g0_pass)
      out.push(`${r.model} / ${r.brief}: демо-фикстура ${r.fixture} не дошла до G0 passed`);
    else if (demo && !r.g1_skipped && !r.g0g1_pass)
      out.push(`${r.model} / ${r.brief}: демо-фикстура ${r.fixture} не дошла до G0+G1 passed`);
  }
  return out;
}

/** Markdown report: per-model table (eval.yaml#report.outputs) and the per-brief table. */
export function renderHarnessReport(result) {
  const L = [];
  const flags = [result.llm_mode, result.dry_run ? "DRY-RUN" : null].filter(Boolean).join(", ");
  L.push(`## Eval harness — ${result.started_at} (${flags})`);
  L.push("");
  L.push(
    `Брифов: ${result.briefs.length}, моделей: ${result.models.length}. Полный путь: оркестратор → карточка → строитель → G0 → G1 (без G2 до M2).`,
  );
  if (result.gates === "G0")
    L.push(
      "> G1 не запускался (--gates=G0): сгенерированный код вне песочницы не исполняется, g0g1_pass не измеряется.",
    );
  if (result.max_cost_rub !== null && result.max_cost_rub !== undefined)
    L.push(`> Бюджет прогона: ${result.max_cost_rub} ₽ (eval.yaml#live_cadence.budget).`);
  if (result.dry_run)
    L.push(
      "> DRY-RUN: брифы без своей фикстуры воспроизводят демо-фикстуру (forum/bakery) — проверяется механика и pii_leaks, а не качество.",
    );
  L.push("");
  L.push(
    "| Модель | Уровень | g0_pass | g0g1_pass | coverage | ₽ | credits (ср.) | мин (ср.) | вопросы (ср.) | pii_leaks |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const a of aggregateHarness(result.runs)) {
    L.push(
      `| ${a.model} | ${a.tier ?? ""} | ${pct(a.g0_pass)} | ${a.g0g1_pass === null ? "—" : pct(a.g0g1_pass)} | ${a.coverage.toFixed(2)} | ${a.cost_rub.toFixed(2)} | ${f2(a.credits)} | ${f1(a.minutes)} | ${f1(a.questions_asked)} | ${a.pii_leaks} |`,
    );
  }
  L.push("");
  L.push("| Бриф | Модель | Фикстура | g0_pass | g0g1_pass | tokens (вход / кэш / выход) | ₽ | мин | Итог |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of result.runs) {
    if (r.skipped) {
      L.push(`| ${r.brief} | ${r.model} | — | — | — | — | — | — | пропущен: ${r.skipped} |`);
      continue;
    }
    L.push(
      `| ${r.brief} | ${r.model} | ${r.fixture ?? "live"} | ${r.g0_pass ? "✓" : "✗"} | ${r.g1_skipped ? "—" : r.g0g1_pass ? "✓" : "✗"} | ${tok(r.tokens)} | ${r.cost_rub.toFixed(2)} | ${r.minutes.toFixed(2)} | ${r.outcome} |`,
    );
  }
  const v = hardViolations(result);
  L.push("");
  L.push(
    v.length
      ? `**Жёсткие пороги нарушены:**\n${v.map((x) => `- ${x}`).join("\n")}`
      : "Жёсткие пороги: соблюдены.",
  );
  const reg = result.regression;
  if (reg && (reg.regressions.length || reg.compared.length || reg.notes.length)) {
    L.push("");
    if (reg.regressions.length)
      L.push(
        `**Регрессия к baseline (eval.yaml#regression):**\n${reg.regressions.map((x) => `- ${x}`).join("\n")}`,
      );
    else if (reg.compared.length)
      L.push(
        `Регрессия к baseline: нет (${reg.compared.map((c) => `${c.modelId} ${c.metric} ${pct(c.cur)} / ${pct(c.base)}${c.subset ? " по подмножеству" : ""}`).join("; ")}).`,
      );
    for (const n of reg.notes) L.push(`- ${n}`);
  }
  return `${L.join("\n")}\n`;
}
