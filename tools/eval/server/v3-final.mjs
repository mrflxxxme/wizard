// V3-40: the report of the final v3 measurement by the exit criteria of docs/plans/2026-10-08-v3.md §6 —
// docs/progress/v3-final-<date>.md. Inputs: the run documents of the final measurement (the first run and the retries of
// the failed briefs only, `briefs` of eval-pilot; a later run of a brief replaces its earlier result), their collect
// output, the spend journal docs/progress/v3-spend.json, the blind comparison (tools/eval/blind aggregate) and the
// diversity (tools/eval/blind/diversity.mjs, the template gate's metric). What has no data yet is «ожидает», never a
// pass. Plain Russian for the founder; no secrets, no personal data (the eval account is a service one).
import { spentRub, waveLine } from "../../deploy/spend.mjs";
import { BLIND_TARGETS, blindLines } from "../blind/aggregate.mjs";
import { V3_CLASSES, V3_FINAL_SET } from "../lib/briefs.mjs";
import { screenshotGrid } from "./report.mjs";
import { V3_TARGETS } from "./v3.mjs";
import { evaluateV3 } from "./v3-report.mjs";

/** §5–6: the development budget of v3 (the spend journal), ₽. */
export const V3_DEV_BUDGET_RUB = 12000;
const CLASS_RU = { site: "сайт бизнеса", booking: "услуги и запись", crm: "CRM и админка", shop: "магазин" };
const STATUS_RU = {
  ready: "готова",
  not_ready: "собрана, но не готова",
  build_failed: "сборка не удалась",
  interview_failed: "интервью не дошло до брифа",
  skipped: "не запускался",
  error: "ошибка замера",
  pending: "не запускался",
  running: "не завершён",
};
const rub = (n) => `${Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ")} ₽`;
const pct = (x) => `${Math.round(x * 100)} %`;
const mark = (ok) => (ok === null || ok === undefined ? "⏳" : ok ? "✅" : "❌");
const cell = (s) =>
  String(s ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
const all = (xs) => (xs.some((x) => x === false) ? false : xs.some((x) => x === null) ? null : true);

/**
 * The run documents of the final measurement as one: `runs` — [{doc, db}] in any order (sorted by startedAt). For each
 * brief the latest result of a run that actually drove it (a retry replaces the first attempt); the facts of the
 * databases merged by system. → {doc, db, attempts: [{runId, startedAt, costRub, briefs}]} — the attempts keep the
 * spend of every run, the failed attempts included.
 */
export function mergeRuns(runs) {
  const list = [...runs].sort((a, b) => String(a.doc.startedAt).localeCompare(String(b.doc.startedAt)));
  if (!list.length) throw new Error("нет ни одного прогона финального замера");
  const byBrief = new Map();
  for (const { doc } of list)
    for (const r of doc.results ?? [])
      if (!byBrief.has(r.id) || !["skipped", "pending"].includes(r.status)) byBrief.set(r.id, r);
  const db = { costs: {}, gaps: null, metrics: {}, invalid: {}, photos: {} };
  const v3 = { calls: {}, hooks: {}, similarity: {}, events: {}, t1Forbidden: null };
  let fingerprints = null;
  for (const { db: d = {} } of list) {
    Object.assign(db.costs, d.costs ?? {});
    Object.assign(db.metrics, d.metrics ?? {});
    Object.assign(db.invalid, d.invalid ?? {});
    Object.assign(db.photos, d.photos ?? {});
    if (d.gaps) db.gaps = { ...(db.gaps ?? {}), ...d.gaps };
    if (d.v3) {
      for (const k of ["calls", "hooks", "similarity", "events"]) Object.assign(v3[k], d.v3[k] ?? {});
      if (d.v3.t1Forbidden !== null && d.v3.t1Forbidden !== undefined)
        v3.t1Forbidden = (v3.t1Forbidden ?? 0) + d.v3.t1Forbidden;
      if (d.v3.fingerprints) fingerprints = { ...(fingerprints ?? {}), ...d.v3.fingerprints };
    }
  }
  if (fingerprints) v3.fingerprints = fingerprints;
  db.v3 = v3;
  const first = list[0].doc;
  const last = list.at(-1).doc;
  const doc = {
    ...last,
    threshold: "v3-final",
    startedAt: first.startedAt,
    finishedAt: last.finishedAt,
    stopped: list.map((x) => x.doc.stopped).find(Boolean) ?? null,
    results: [...byBrief.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const attempts = list.map(({ doc: d, db: x = {} }) => ({
    runId: d.runId ?? null,
    startedAt: d.startedAt ?? null,
    costRub: evaluateV3(d, x).costRub,
    briefs: (d.results ?? []).filter((r) => !["skipped", "pending"].includes(r.status)).map((r) => r.id),
  }));
  return { doc, db, attempts };
}

/**
 * The verdicts of §6: `doc`/`db` (mergeRuns), `journal` (the spend journal), `extraRub` — spend of the run not closed
 * in the journal yet, `blind` — the summary of tools/eval/blind aggregate (null — no raters yet), `diversity` —
 * measureDiversity (null or pending — not computed).
 */
export function evaluateV3Final({ doc, db = {}, journal = null, extraRub = 0, blind = null, diversity = null }) {
  const e = evaluateV3(doc, db);
  const byClass = Object.fromEntries(V3_CLASSES.map((c) => [c, e.items.filter((x) => x.class === c)]));
  const setOk =
    e.total === V3_FINAL_SET.total && V3_CLASSES.every((c) => byClass[c].length === V3_FINAL_SET.perClass);
  const scenariosOk = e.items.filter((x) => x.scenarios && x.scenarios.total > 0 && x.scenarios.mustNotPassed === 0);
  const techOk = e.items.filter((x) => x.techreview.verdict === "без блокеров");
  const failed = e.items.filter((x) => !x.ready).map((x) => x.id);
  const functional = setOk && e.ready === e.total;
  const time = all([e.targets.median, e.targets.cap]);
  const money = all([e.targets.avgRub, e.targets.maxRub]);
  const spent = journal ? spentRub(journal) + extraRub : null;
  const open = (journal?.entries ?? []).filter((x) => !Number.isFinite(x.actualRub));
  const devBudget = spent === null ? null : spent <= V3_DEV_BUDGET_RUB;
  const blindOk = blind ? blind.passed.blind : null;
  const metricOk = diversity?.status === "done" ? diversity.passed : null;
  const complaintsOk = blind ? blind.passed.template : null;
  const diverse = all([metricOk, complaintsOk]);
  // The founder's floor of the design (10.10.2026): the critic's score of every built site ≥ 30.
  const scored = e.items.filter((x) => x.critic?.kept !== null && x.critic?.kept !== undefined);
  const lowDesign = scored.filter((x) => x.critic.kept < DESIGN_FLOOR);
  const design = scored.length === 0 ? null : lowDesign.length === 0;
  const criteria = { functional, design, blind: blindOk, diversity: diverse, time, money, devBudget };
  const values = Object.values(criteria);
  return {
    e,
    byClass,
    setOk,
    scenariosOk: scenariosOk.length,
    techOk: techOk.length,
    failed,
    spent,
    open,
    criteria,
    metricOk,
    complaintsOk,
    scored,
    lowDesign,
    verdict: values.some((v) => v === false) ? "failed" : values.some((v) => v === null) ? "pending" : "passed",
  };
}

/** The founder's floor of the critic's score (0–100) of a built site (10.10.2026). */
export const DESIGN_FLOOR = 30;

const CRITERIA_RU = {
  functional: "функционально",
  design: "дизайн (оценка критика)",
  blind: "слепое сравнение",
  diversity: "разнообразие",
  time: "время",
  money: "деньги",
  devBudget: "расход разработки",
};

/**
 * The report text (Markdown) and the verdicts. `input` — as evaluateV3Final plus `attempts` (mergeRuns); `meta` —
 * {date, platform, shotsBase (the folder of the screenshots relative to the report), notes}.
 */
export function renderV3Final(input, meta = {}) {
  const f = evaluateV3Final(input);
  const { e } = f;
  const doc = input.doc;
  const date = meta.date ?? String(doc.startedAt ?? "").slice(0, 10);
  const attempts = input.attempts ?? [];
  const L = [];
  L.push(`# Финальный замер v3 — ${date}`, "");
  L.push(
    `Критерии выхода v3 — docs/plans/2026-10-08-v3.md §6. Платформа: ${meta.platform ?? doc.base ?? "—"} · прогонов: ${attempts.length || 1}${attempts.length > 1 ? ` (первый и повторы упавших брифов: ${attempts.map((a) => `\`${a.runId ?? "—"}\``).join(", ")})` : ` (\`${doc.runId ?? "—"}\`)`} · брифов: ${e.total}.`,
    "",
  );
  const bad = Object.entries(f.criteria)
    .filter(([, v]) => v === false)
    .map(([k]) => CRITERIA_RU[k]);
  const wait = Object.entries(f.criteria)
    .filter(([, v]) => v === null)
    .map(([k]) => CRITERIA_RU[k]);
  L.push(
    f.verdict === "passed"
      ? "**Итог: ✅ критерии §6 (1–4) выполнены.** Дальше — V3-41: проход основателя и нетехнических тестировщиков, «да» основателя."
      : f.verdict === "failed"
        ? `**Итог: ❌ не выполнено — ${bad.join(", ")}.**${wait.length ? ` Ещё ждут данных: ${wait.join(", ")}.` : ""}`
        : `**Итог: ⏳ ждёт данных — ${wait.join(", ")}.** Остальное выполнено.`,
    "",
  );
  // The table of the criteria.
  const classLine = V3_CLASSES.map(
    (c) => `${CLASS_RU[c]} ${f.byClass[c].filter((x) => x.ready).length}/${f.byClass[c].length}`,
  ).join(", ");
  const blind = input.blind;
  const div = input.diversity;
  const divFact =
    div?.status === "done"
      ? div.max
        ? `наибольшее сходство ${pct(div.max.score)} (${div.max.a} и ${div.max.b}, порог ${pct(div.max.threshold)}); выше порога: ${div.over.length}`
        : "пар внутри ниш нет"
      : `метрика не посчитана${div?.why ? `: ${div.why}` : ""}`;
  const complaints = blind
    ? `«один шаблон» у сайтов Wizard: ${blind.template.ww.length}`
    : "«один шаблон» — ожидает оценщиков";
  L.push("| № | Критерий (§6) | Цель | Факт | Итог |", "|---|---|---|---|---|");
  L.push(
    `| 1 | Функционально | 12 брифов, по 3 на класс; сценарии брифа проходят, техревью без блокеров | готовы ${e.ready} из ${e.total} (${classLine}); сценарии прошли у ${f.scenariosOk}, техревью без блокеров у ${f.techOk}${f.setOk ? "" : "; набор неполный"} | ${mark(f.criteria.functional)} |`,
    `| 1 | Дизайн | оценка критика каждой системы ≥ ${DESIGN_FLOOR} из 100 (пол основателя) | ${f.scored.length ? `от ${Math.min(...f.scored.map((x) => x.critic.kept))} до ${Math.max(...f.scored.map((x) => x.critic.kept))}; ниже ${DESIGN_FLOOR}: ${f.lowDesign.length ? f.lowDesign.map((x) => `${x.id} (${x.critic.kept})`).join(", ") : "нет"}` : "оценок нет"} | ${mark(f.criteria.design)} |`,
    `| 2 | Слепое сравнение | Wizard ≥ ${pct(BLIND_TARGETS.wizardShare)} пар; основатель и 3–5 оценщиков | ${blind ? `${blind.wc.wizardWins} из ${blind.wc.voted} пар (${blind.wc.share === null ? "—" : pct(blind.wc.share)}), оценщиков ${blind.ratersCount}` : "ожидает оценщиков"} | ${mark(f.criteria.blind)} |`,
    `| 3 | Разнообразие | сходство сайтов внутри ниши ниже порога гейта шаблонности; ни одного «один шаблон» | ${cell(`${divFact}; ${complaints}`)} | ${mark(f.criteria.diversity)} |`,
    `| 4 | Время | медиана ≤ ${V3_TARGETS.medianMin} мин, максимум ≤ ${V3_TARGETS.capMin} мин (от брифа до конца сборки) | медиана ${e.medianMinutes ?? "—"} мин, максимум ${e.maxMinutes ?? "—"} мин | ${mark(f.criteria.time)} |`,
    `| 4 | Деньги | средняя сборка ≤ ${V3_TARGETS.targetRub} ₽, ни одна > ${V3_TARGETS.capRub} ₽ | средняя ${e.avgRub === null ? "—" : rub(e.avgRub)}, максимум ${e.maxRub === null ? "—" : rub(e.maxRub)}${e.costExact ? "" : " (оценка по кредитам)"} | ${mark(f.criteria.money)} |`,
    `| — | Расход разработки v3 | ≤ ${rub(V3_DEV_BUDGET_RUB)} по журналу трат | ${f.spent === null ? "журнал не прочитан" : `${rub(f.spent)}${f.open.length ? `; открытых записей ${f.open.length} с потолком ${rub(f.open.reduce((s, x) => s + (x.capRub ?? 0), 0))}` : ""}`} | ${mark(f.criteria.devBudget)} |`,
    "| 5 | Эргономика | основатель и 3–4 нетехнических знакомых, ≥ 3 из 4 «заплатил бы» | V3-41, после этого замера | — |",
    "",
  );

  // 1. Per class.
  L.push("## Функционально: брифы по классам", "");
  L.push(
    "| Класс | Бриф | Итог | От брифа, мин | ₽ | Сценарии ✓/всего | Техревью | Критик |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const c of V3_CLASSES)
    for (const x of f.byClass[c])
      L.push(
        `| ${CLASS_RU[c]} | ${cell(x.id)} | ${x.ready ? "✅" : "❌"} ${cell(STATUS_RU[x.status] ?? x.status)} | ${x.fromBriefMinutes ?? x.minutes ?? "—"} | ${x.systemId ? `${Math.round(x.costRub)}${x.costExact ? "" : "≈"}` : "—"} | ${x.scenarios ? `${x.scenarios.passed}/${x.scenarios.total}` : "—"} | ${cell(x.techreview.verdict)} | ${x.critic?.kept ?? "—"} |`,
      );
  L.push("");
  if (f.failed.length)
    L.push(
      `Не готовы: ${f.failed.join(", ")}. Повтор — только их: eval-pilot, threshold \`v3-final\`, briefs \`${f.failed.map((id) => id.split("-").slice(0, 2).join("-")).join(",")}\`, волна \`retry\`; затем этот отчёт заново по обоим прогонам (\`node tools/eval/server/cli.mjs final --results <первый>.json,<повтор>.json …\`).`,
      "",
    );

  // 3. Diversity.
  L.push("## Разнообразие", "");
  L.push(
    "Метрика — гейт шаблонности сборки (V3-14, packages/gates `siteSimilarity`: структура, DOM-формы и перцептивные хеши снимков 390 и 1440 px) по отпечаткам, которые сохранила сборка. Ниша замера — класс брифов (плюс пары, которые сам гейт отнёс к одной нише); у пары берётся большее из двух направлений сравнения.",
    "",
  );
  if (div?.status === "done") {
    L.push("| Пара | Ниша | Сходство | Порог | Сравнение | Итог |", "|---|---|---|---|---|---|");
    for (const p of div.pairs)
      L.push(
        `| ${cell(`${p.a} — ${p.b}`)} | ${cell(p.class ? CLASS_RU[p.class] : p.niche)} | ${pct(p.score)} | ${pct(p.threshold)} | ${p.mode === "full" ? "структура, DOM, снимки" : "только структура"} | ${p.over ? "❌ шаблон" : "✅"} |`,
      );
    if (div.missing?.length) L.push("", `Без отпечатка (не сравнивались): ${div.missing.join(", ")}.`);
    L.push("");
  } else L.push(`Не посчитано: ${div?.why ?? "нет данных"}.`, "");
  const gate = e.items.filter((x) => x.template.similarity !== null);
  if (gate.length)
    L.push(
      `Гейт при сборке (сходство с памятью недавних сайтов ниши и организации): ${gate.map((x) => `${x.id} ${pct(x.template.similarity)}${x.template.redesign ? " (стиль сменён)" : ""}`).join("; ")}.`,
      "",
    );

  // 2. Blind comparison.
  L.push("## Слепое сравнение", "");
  if (blind) L.push(...blindLines(blind), "");
  else
    L.push(
      "Ожидает оценщиков. Снимки конкурента по тем же брифам кладутся в `competitor/<бриф>/390.png` и `1440.png` с `meta.json` {\"service\": \"…\"}; страница для оценщиков — `node tools/eval/blind/cli.mjs build`, итог — `aggregate` (docs/ops/eval-pilot.md, «Финальный замер v3»).",
      "",
    );

  // Spend.
  L.push("## Расход", "");
  const sys = e.items.filter((x) => x.systemId).reduce((s, x) => s + x.costRub, 0);
  const tries = attempts.reduce((s, a) => s + (a.costRub ?? 0), 0);
  L.push(
    `- Системы замера (последняя попытка каждого брифа): ${rub(sys)}; все прогоны замера с повторами: ${rub(tries || e.costRub)}.`,
  );
  if (input.journal)
    for (const w of ["final", "retry", "competitors"]) {
      const line = waveLine(input.journal, w, w === (meta.wave ?? "final") ? (input.extraRub ?? 0) : 0);
      L.push(`- ${line[0].toUpperCase()}${line.slice(1)}.`);
    }
  if (f.spent !== null)
    L.push(
      `- Всего по v3: ${rub(f.spent)} из ${rub(V3_DEV_BUDGET_RUB)}${input.extraRub ? ` (с этим прогоном, ещё не закрытым в журнале: ${rub(input.extraRub)})` : ""}.`,
    );
  L.push("");
  const grid = screenshotGrid(
    e.items.map((x) => ({
      ...x,
      screenshots: (x.screenshots ?? []).map((s) => ({
        ...s,
        src: meta.shotsBase ? `${meta.shotsBase}/${String(s.src).split("/").at(-1)}` : s.src,
      })),
    })),
  );
  L.push(...grid);
  const notes = [...(meta.notes ?? [])];
  if (notes.length) L.push("## Что учесть", "", ...notes.map((n) => `- ${n}`), "");
  return { text: L.join("\n"), summary: f };
}
