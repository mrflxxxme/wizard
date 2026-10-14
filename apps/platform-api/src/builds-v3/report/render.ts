// V4-04: the report as Markdown — the admin page and the body of the issue of a failed founder build.
import type { BuildReport, ReportCall, ScenarioTiming } from "./types.js";

const cell = (s: string | number | null | undefined): string =>
  String(s ?? "—")
    .replace(/\|/g, "/")
    .replace(/\s+/g, " ")
    .slice(0, 200);

/** `base` — the report's URL (…/admin/runs/<id>/report): screenshots and records are linked under it. */
export function renderReportMd(r: BuildReport, base: string): string {
  const out: string[] = [];
  const verdict = r.status === "succeeded" ? "✅ собрана" : `❌ ${r.status}`;
  out.push(`## Сборка ${r.systemName ? `«${r.systemName}»` : (r.systemId ?? "")}: ${verdict}`, "");
  if (r.failure) out.push(`**Причина:** ${r.failure.code ?? "?"} — ${r.failure.message ?? ""}`, "");
  out.push(
    `Прогон \`${r.runId}\`, ${r.minutes} мин, ${r.rub.toFixed(2)} ₽. Отчёт: ${base}`,
    "",
    "### Этапы",
    "| Этап | Итог | ₽ | Мин | Вызовы | Запасной путь | Заметка |",
    "|---|---|---|---|---|---|---|",
  );
  for (const s of r.stages)
    out.push(
      `| ${s.stage} | ${s.status} | ${s.rub.toFixed(2)} | ${s.minutes} | ${s.calls ?? "—"} | ${s.fallback ? "да" : "—"} | ${cell(s.note)} |`,
    );
  out.push("", "### Сценарии брифа");
  if (!r.scenarios.length) out.push("Сценариев нет.");
  for (const s of r.scenarios) {
    out.push(`- **${s.id}** — ${s.status}${s.problems.length ? `: ${s.problems.join("; ")}` : ""}`);
    if (s.timing) out.push(`  - время: ${timingLine(s.timing)}`);
    for (const n of s.notes ?? []) out.push(`  - ${n}`);
    for (const h of s.http.filter((x) => x.status >= 400 || x.failure).slice(0, 10))
      out.push(`  - ${h.method} ${h.url} → ${h.failure ?? h.status}${h.body ? ` \`${cell(h.body)}\`` : ""}`);
    const ok = s.http.filter((x) => x.status > 0 && x.status < 400).length;
    if (s.http.length) out.push(`  - ответов HTTP: ${s.http.length}, успешных ${ok}`);
  }
  out.push("", "### Гейты");
  for (const g of r.gates)
    out.push(
      `- ${g.level} (ревизия ${g.revision}): ${g.passed ? "пройден" : "не пройден"}${g.failed.length ? ` — ${g.failed.map((c) => `${c.id}: ${c.message}`).join("; ")}` : ""}`,
    );
  if (!r.gates.length) out.push("Отчётов гейтов нет.");
  out.push("", "### Критик и техревью");
  out.push(
    r.critic
      ? `- Критик: оценки ${r.critic.scores.join(" → ") || "—"}${r.critic.stop ? `, остановка: ${r.critic.stop}` : ""}`
      : "- Критик не запускался.",
  );
  out.push(
    r.techreview
      ? `- Техревью: ${r.techreview.status ?? "—"}${r.techreview.blockers.length ? `, блокеры: ${r.techreview.blockers.join("; ")}` : ""}`
      : "- Техревью не запускалось.",
  );
  out.push("", "### Снимки");
  if (!r.shots.length) out.push("Снимков нет.");
  for (const s of r.shots) out.push(`- ${s.width}: ${base}/files/${s.key}`);
  out.push(
    "",
    "### Вызовы моделей",
    "Токены — в тысячах: вход (из него кэш) / выход (из него рассуждения).",
    "| Шаг | Тип | Модель | Итог | ₽ | с | Токены |",
    "|---|---|---|---|---|---|---|",
  );
  for (const c of r.calls.slice(0, 60))
    out.push(
      `| ${cell(c.step)} | ${c.callType} | ${c.model} (${c.tier}) | ${c.status}${c.errorCode ? ` ${c.errorCode}` : ""} | ${c.rub.toFixed(2)} | ${c.latencyMs === null ? "—" : Math.round(c.latencyMs / 1000)} | ${tokensCell(c.tokens)} |`,
    );
  if (r.calls.length > 60) out.push(`… и ещё ${r.calls.length - 60}`);
  if (r.records) out.push("", `Записи вызовов (V4-03, jsonl): ${base}/files/${r.records}`);
  if (r.gaps.length) out.push("", `Не собрано: ${r.gaps.join("; ")}`);
  return `${out.join("\n")}\n`;
}

const kilo = (n: number) => (n / 1000).toFixed(1).replace(".", ",");

/** «12,3 (кэш 8,0) / 2,1 (рассужд. 1,2)»: tokens of a call in thousands; a part that is 0 is left out. */
function tokensCell(t: ReportCall["tokens"] | undefined): string {
  if (!t || (t.input === 0 && t.output === 0)) return "—";
  const input = t.cached ? `${kilo(t.input)} (кэш ${kilo(t.cached)})` : kilo(t.input);
  const output = t.reasoning ? `${kilo(t.output)} (рассужд. ${kilo(t.reasoning)})` : kilo(t.output);
  return `${input} / ${output}`;
}

const sec = (ms: number) => `${Math.round(ms / 1000)} с`;

/** «всего 95 с: сборка 52 с, проверка 31 с (G0 6 с, G1 18 с, обещания 7 с), ремонт 12 с + проверка 9 с». */
function timingLine(t: ScenarioTiming): string {
  const check = `проверка ${sec(t.checkMs)} (G0 ${sec(t.g0Ms)}, G1 ${sec(t.g1Ms)}, обещания ${sec(t.promisesMs)})`;
  const repair = t.repairMs ? `, ремонт ${sec(t.repairMs)} + проверка ${sec(t.repairCheckMs)}` : "";
  return `всего ${sec(t.totalMs)}: сборка ${sec(t.composeMs)}, ${check}${repair}`;
}
