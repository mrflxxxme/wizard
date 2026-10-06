// Markdown report of the D67 measurement (product.yaml#decisions.D67_mvp_readiness): per brief — class, publish
// readiness, failed checks and why, minutes, ₽, «Запросы на развитие»; the total X of 10, the median of minutes, the
// sum of ₽ and the verdict against the threshold ≥ 7 of 10. Plain Russian for the founder (D28, D48); no values of
// secrets or personal data reach it (the eval account is a service one, the briefs are synthetic).
import { D67_THRESHOLD, RUB_PER_CREDIT } from "./driver.mjs";

const COVERAGE_RU = { covered: "в модулях", uncovered: "вне модулей", unknown: "план не прочитан" };

const CLASS_RU = { site: "сайт с заявками", booking: "запись", crm: "CRM", other: "вне классов" };
const STATUS_RU = {
  ready: "готова к публикации",
  not_ready: "проверки не пройдены",
  build_failed: "сборка не удалась",
  interview_failed: "интервью не дошло до карточки",
  skipped: "не запускался (бюджет)",
  error: "ошибка замера",
  pending: "не запускался",
  running: "не завершён",
};
const PUBLISH_RU = {
  review_pending: "ждёт ревью основателя",
  published: "опубликована",
  failed: "публикация остановлена проверками",
  refused: "публикация не принята",
  not_publishable: "до публикации не дошла",
  skipped: "G2 не запускался",
};

/** A run measured against the strict threshold of beta v2 (driver threshold d76). */
export const isD76 = (doc) => doc?.threshold === "d76" || doc?.kind === "d76";

const rub = (n) => `${Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ")} ₽`;
const cell = (s) =>
  String(s ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();

/** Median of numbers (null for an empty list). */
export function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (a.length === 0) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 10) / 10;
}

/**
 * Brief verdicts with the database facts of the operator (costs per system, «Запросы на развитие» rows; null — the
 * table does not exist yet). A beyond brief counts when its system is ready, or when the refusal is honest and
 * recorded; without the table an honest answer in the card or chat counts provisionally (marked).
 */
export function evaluate(doc, db = {}) {
  const d76 = isD76(doc);
  const costs = db.costs ?? {};
  const gapsTable = db.gaps !== undefined && db.gaps !== null;
  const items = doc.results.map((r) => {
    const exact = r.systemId ? costs[r.systemId] : undefined;
    const costRub = exact ? exact.rub : r.costRubEstimate;
    const recorded = gapsTable && r.systemId ? (db.gaps[r.systemId] ?? []) : [];
    const mentioned = r.beyond
      ? [
          ...(r.gaps?.reported ?? []).map((g) => [g.missing, g.offered].filter(Boolean).join(" — ")),
          ...(r.gaps?.outOfScope ?? []),
          ...(r.gaps?.mentions ?? []),
        ].filter((t) => r.beyond.gapStems.some((s) => t.toLowerCase().includes(s.toLowerCase())))
      : [];
    let counted = r.ready;
    let via = r.ready ? "ready" : null;
    if (d76) {
      // D76: covered — ready; uncovered — a working system and what is out of scope recorded (or nothing out of scope).
      const coverage = r.plan?.coverage ?? "unknown";
      const need = (r.plan?.outOfScope ?? []).length > 0;
      const reported = (r.gaps?.reported ?? []).length > 0;
      counted = false;
      via = null;
      if (coverage === "covered" && r.ready) [counted, via] = [true, "ready"];
      else if (coverage === "uncovered" && r.ready) {
        if (!need) [counted, via] = [true, "ready"];
        else if (recorded.length > 0) [counted, via] = [true, "gap_recorded"];
        else if (!gapsTable && reported) [counted, via] = [true, "gap_mentioned"];
      }
      return {
        ...r,
        costRub,
        costExact: !!exact,
        developmentRequests: recorded,
        gapMentioned: mentioned,
        gapCount: Math.max(recorded.length, r.gaps?.reported?.length ?? 0),
        stages: (r.systemId && db.metrics?.[r.systemId]?.stages) || null,
        coverage,
        counted,
        countedVia: via,
      };
    }
    if (!counted && r.beyond && recorded.length > 0) {
      counted = true;
      via = "gap_recorded";
    } else if (!counted && r.beyond && !gapsTable && mentioned.length > 0) {
      counted = true;
      via = "gap_mentioned";
    }
    return {
      ...r,
      costRub,
      costExact: !!exact,
      developmentRequests: recorded,
      gapMentioned: mentioned,
      gapCount: Math.max(recorded.length, r.gaps?.reported?.length ?? 0),
      stages: (r.systemId && db.metrics?.[r.systemId]?.stages) || null,
      counted,
      countedVia: via,
    };
  });
  const ran = items.filter((x) => x.status !== "skipped" && x.status !== "pending");
  const ready = items.filter((x) => x.counted).length;
  const staged = items.filter((x) => x.stages?.tasks?.total);
  const threshold = d76 ? items.length : Math.ceil((D67_THRESHOLD.ready / D67_THRESHOLD.of) * items.length);
  const group = (c) => {
    const xs = items.filter((x) => x.coverage === c);
    return { total: xs.length, counted: xs.filter((x) => x.counted).length };
  };
  const coverage = d76 ? { covered: group("covered"), uncovered: group("uncovered"), unknown: group("unknown") } : null;
  return {
    items,
    total: items.length,
    ran: ran.length,
    ready,
    threshold,
    coverage,
    passed: d76
      ? items.length > 0 && ready === items.length
      : items.length >= D67_THRESHOLD.of
        ? ready >= D67_THRESHOLD.ready
        : ready >= threshold,
    medianMinutes: median(items.map((x) => x.minutes)),
    costRub: Math.round(items.reduce((s, x) => s + (x.costRub ?? 0), 0) * 100) / 100,
    costExact: items.filter((x) => x.systemId).every((x) => x.costExact),
    credits: Math.round(items.reduce((s, x) => s + (x.creditsUsed ?? 0), 0) * 1000) / 1000,
    gaps: items.reduce((s, x) => s + x.gapCount, 0),
    gapsTable,
    firstPass: staged.length
      ? {
          briefs: staged.length,
          passed: staged.reduce((s, x) => s + (x.stages.tasks.firstPass ?? 0), 0),
          total: staged.reduce((s, x) => s + x.stages.tasks.total, 0),
        }
      : null,
  };
}

/** «Этапы: …» of one brief from build_metrics.stages (agents/builder.yaml#harness.metrics); null without metrics. */
export function stagesLine(st) {
  if (!st || typeof st !== "object") return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const parts = [];
  if (st.brief) {
    const k = n(st.brief.tasks);
    const [m10, m100] = [k % 10, k % 100];
    const word = m10 === 1 && m100 !== 11 ? "задача" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "задачи" : "задач";
    parts.push(`ТЗ — ${k} ${word}`);
  }
  if (st.tasks) parts.push(`с первого хода — ${n(st.tasks.firstPass)} из ${n(st.tasks.total)}`);
  if (st.verify) parts.push(`исправления — ${n(st.verify.fixTasks)}`);
  if (st.review)
    parts.push(
      st.review.skipped
        ? "рецензент — пропущен"
        : `рецензент — ok ${n(st.review.ok)}, критично ${n(st.review.critical)}, мелочи ${n(st.review.minor)}`,
    );
  return parts.length ? `Этапы: ${parts.join("; ")}` : null;
}

function checksLine(item) {
  const out = [];
  for (const level of ["G0", "G1", "G2"]) {
    const g = item.gates?.[level];
    if (!g) continue;
    for (const c of g.blockers) out.push(`${level} · ${c.id}: ${c.message}`);
  }
  return out;
}

/** D76 verdict lines: covered briefs all ready, uncovered ones all at a working system with recorded requests. */
function d76Summary(e) {
  const c = e.coverage;
  const verdict = e.passed ? "строгий порог D76 пройден" : "строгий порог D76 не пройден";
  const L = [
    `**Итог: ${verdict} — засчитано ${e.ready} из ${e.total}.**`,
    "",
    `- Брифы в модулях (план без дописывания и без «не входит»): готовы ${c.covered.counted} из ${c.covered.total} — нужно все.`,
    `- Брифы вне модулей: дошли до рабочей системы с записанными «Запросами на развитие» ${c.uncovered.counted} из ${c.uncovered.total} — нужно все.`,
  ];
  if (c.unknown.total)
    L.push(`- План системы не прочитан у ${c.unknown.total} брифов: покрытие модулями неизвестно, такие брифы не засчитываются.`);
  return L;
}

/** Per brief: the plan (modules, what is out of scope and its replacement), goal scenarios and the phone check. */
function d76Brief(x) {
  const L = [];
  const p = x.plan;
  if (!p || p.coverage === "unknown") L.push("- План системы: не прочитан.");
  else {
    L.push(`- План системы: ${COVERAGE_RU[p.coverage]}; модули: ${p.modules.join(", ") || "—"}.`);
    if (p.custom.length) L.push(`- Дописывание: ${p.custom.join("; ")}.`);
    for (const o of p.outOfScope) L.push(`- Не входит: ${o.what}${o.replacement ? ` — замена: ${o.replacement}` : ""}.`);
  }
  const b = x.browser;
  if (!b?.ran) L.push("- Проверки в браузере (сценарии целей, 390 px) не запускались — готовность не засчитана.");
  else {
    L.push(
      `- Сценарии целей в браузере: прошли ${b.goals.passed} из ${b.goals.total}; страницы на 390 px: ${b.mobile === "pass" ? "без прокрутки вбок" : "есть прокрутка вбок"}.`,
    );
    for (const f of b.goals.failed) L.push(`  - ${f.id}: ${f.message}`);
  }
  return L;
}

/** Grid of site screenshots (3 per row): what each system of the measurement looks like, side by side. */
export function screenshotGrid(items) {
  const shots = items.flatMap((x) =>
    (x.screenshots ?? []).filter((s) => s?.src).map((s) => ({ id: x.id, label: s.label ?? x.id, src: s.src })),
  );
  if (shots.length === 0) return [];
  const L = ["## Сетка скриншотов", "", "| | | |", "|---|---|---|"];
  for (let i = 0; i < shots.length; i += 3) {
    const row = shots.slice(i, i + 3).map((s) => `![${cell(s.label)}](${s.src})<br>${cell(s.id)} · ${cell(s.label)}`);
    while (row.length < 3) row.push(" ");
    L.push(`| ${row.join(" | ")} |`);
  }
  L.push("");
  return L;
}

/** The report text (Markdown). `meta`: {platform, date, briefsAsked, limitsNote}. */
export function renderReport(doc, db = {}, meta = {}) {
  const e = evaluate(doc, db);
  const d76 = isD76(doc);
  const L = [];
  const date = meta.date ?? String(doc.startedAt ?? "").slice(0, 10);
  L.push(d76 ? `# Замер беты v2 (порог D76) — ${date}` : `# Замер D67 на сервере пилота — ${date}`, "");
  L.push(
    `Платформа: ${meta.platform ?? doc.base} · прогон \`${doc.runId ?? "—"}\` · брифов: ${e.total}, запущено: ${e.ran} · бюджет ${rub(doc.maxCostRub)} · параллельно: ${doc.concurrency}`,
    "",
  );
  if (d76) L.push(...d76Summary(e), "");
  else {
    const verdict = e.passed
      ? `порог D67 (не меньше ${D67_THRESHOLD.ready} из ${D67_THRESHOLD.of}) достигнут`
      : `порог D67 (не меньше ${D67_THRESHOLD.ready} из ${D67_THRESHOLD.of}) не достигнут`;
    L.push(`**Итог: ${e.ready} из ${e.total} дошли до готовности к публикации — ${verdict}.**`, "");
  }
  L.push(
    `- Медиана времени от брифа до конца сборки: ${e.medianMinutes === null ? "—" : `${e.medianMinutes} мин`}`,
    `- Расход моделей: ${rub(e.costRub)} ${e.costExact ? "(точно, по журналу вызовов моделей)" : `(оценка по кредитам: 1 кредит ≈ ${RUB_PER_CREDIT} ₽)`}; кредитов списано по прогонам: ${e.credits}`,
    `- Пробелов возможностей («Пока не умеем…») назвали агенты: ${e.gaps}${
      e.gaps
        ? ` — в брифах ${e.items
            .filter((x) => x.gapCount > 0)
            .map((x) => x.id.slice(0, 6))
            .join(", ")}`
        : ""
    }`,
    ...(e.firstPass
      ? [
          `- Задачи ТЗ, готовые с первого хода исполнителя: ${e.firstPass.passed} из ${e.firstPass.total}${e.firstPass.total ? ` (${Math.round((e.firstPass.passed / e.firstPass.total) * 100)} %)` : ""} — по брифам с метриками этапов: ${e.firstPass.briefs}`,
        ]
      : []),
    `- Готовность к публикации — G0, G1 и G2 без блокеров${d76 ? ", сценарии целей проходят в браузере (390 и 1280 px, светлая и тёмная темы) и все страницы на 390 px без прокрутки вбок" : ""}; то, что делает владелец (секреты интеграций), показано отдельно и готовность не снимает.${doc.g2 === "skip" ? " **В этом прогоне G2 не запускался.**" : " G2 запускается первой публикацией: на пилоте она останавливается на ревью основателя, в prod ничего не уходит."}`,
    "",
  );
  L.push(
    d76
      ? "| Бриф | План | Итог | Сценарии целей | 390 px | Не прошли | Мин | ₽ | Запросы на развитие |"
      : "| Бриф | Класс | Итог | Не прошли | Мин | ₽ | Пробелы | Запросы на развитие |",
    d76 ? "|---|---|---|---|---|---|---|---|---|" : "|---|---|---|---|---|---|---|---|",
  );
  for (const x of e.items) {
    const failed = checksLine(x);
    const gaps = x.developmentRequests.length
      ? x.developmentRequests.map((g) => g.category ?? g.quote).join("; ")
      : x.gaps?.reported?.length
        ? x.gaps.reported.map((g) => g.category ?? g.missing).join("; ")
        : x.gapMentioned.length
          ? `в ответе агента: ${x.gapMentioned[0]}`
          : x.gaps?.outOfScope?.length
            ? `вне рамок: ${x.gaps.outOfScope.join("; ")}`
            : "—";
    const mark = x.counted ? (x.countedVia === "ready" ? "✅" : "✅*") : "❌";
    if (d76) {
      const b = x.browser;
      const goals = !b?.ran ? "не запускались" : b.goals.failed.length ? `не прошли ${b.goals.failed.length} из ${b.goals.total}` : `${b.goals.passed} из ${b.goals.total}`;
      const mobile = !b?.ran ? "—" : b.mobile === "pass" ? "без поломок" : "прокрутка вбок";
      L.push(
        `| ${cell(x.id)} | ${cell(COVERAGE_RU[x.coverage])} | ${mark} ${cell(STATUS_RU[x.status] ?? x.status)} | ${cell(goals)} | ${cell(mobile)} | ${cell(failed.length ? `${failed.length}: ${failed.map((f) => f.split(":")[0]).join(", ")}` : "—")} | ${x.minutes ?? "—"} | ${x.systemId ? `${Math.round(x.costRub)}${x.costExact ? "" : "≈"}` : "—"} | ${cell(gaps).slice(0, 200)} |`,
      );
      continue;
    }
    L.push(
      `| ${cell(x.id)} | ${cell(CLASS_RU[x.class] ?? x.class)} | ${mark} ${cell(STATUS_RU[x.status] ?? x.status)} | ${cell(failed.length ? `${failed.length}: ${failed.map((f) => f.split(":")[0]).join(", ")}` : "—")} | ${x.minutes ?? "—"} | ${x.systemId ? `${Math.round(x.costRub)}${x.costExact ? "" : "≈"}` : "—"} | ${x.gapCount} | ${cell(gaps).slice(0, 200)} |`,
    );
  }
  if (e.items.some((x) => x.countedVia === "gap_mentioned"))
    L.push(
      "",
      "✅* — бриф сверх возможностей засчитан по честному ответу агента; запись в разделе «Запросы на развитие» не найдена или не прочитана.",
    );
  if (e.items.some((x) => x.countedVia === "gap_recorded"))
    L.push("", "✅* — бриф сверх возможностей засчитан: отказ честный и записан в «Запросы на развитие».");
  L.push("", "## По брифам", "");
  for (const x of e.items) {
    L.push(`### ${x.id} — ${x.title}`, "");
    L.push(`- Класс: ${CLASS_RU[x.class] ?? x.class}. Итог: ${STATUS_RU[x.status] ?? x.status}.`);
    if (d76) L.push(...d76Brief(x));
    if (x.systemId) L.push(`- Система: \`${x.systemId}\``);
    if (x.error) L.push(`- Что случилось: ${x.error}`);
    if (x.interview?.turns)
      L.push(
        `- Интервью: ходов ${x.interview.turns}, ответов кнопками ${x.interview.buttons}, ответов текстом ${x.interview.free}.`,
      );
    if (x.build)
      L.push(
        `- Сборка: ${x.build.status === "succeeded" ? "завершилась" : `не завершилась (${x.build.failure?.message_ru ?? x.build.status})`}${x.fixes ? `, «Исправить» нажато ${x.fixes} раз` : ""}; ${x.buildMinutes ?? "—"} мин сборки, ${x.minutes ?? "—"} мин от брифа.`,
      );
    const stages = stagesLine(x.stages);
    if (stages) L.push(`- ${stages}.`);
    if (x.inputs?.length)
      L.push(
        `- Сборка спрашивала: ${x.inputs.map((i) => `${i.decisionId ?? i.kind} → ${i.choice ?? "нет ответа"}`).join("; ")}.`,
      );
    for (const level of ["G0", "G1", "G2"]) {
      const g = x.gates?.[level];
      if (!g) continue;
      const head = g.passed ? "пройдена" : g.blockers.length ? "не пройдена" : "ждёт действий владельца";
      L.push(`- ${level}: ${head}${g.warnings ? `, предупреждений ${g.warnings}` : ""}.`);
      for (const c of g.blockers) L.push(`  - ${c.id}: ${c.message}`);
      for (const c of g.ownerActions) L.push(`  - владельцу: ${c.id} — ${c.message}`);
    }
    if (x.publish)
      L.push(
        `- Публикация: ${PUBLISH_RU[x.publish.status] ?? x.publish.status}${x.publish.message ? ` — ${x.publish.message}` : ""}.`,
      );
    L.push(
      `- Расход: ${x.systemId ? rub(x.costRub) : "—"}${x.costExact ? "" : " (оценка)"}, кредитов ${x.creditsUsed}.`,
    );
    if (x.developmentRequests.length)
      for (const g of x.developmentRequests)
        L.push(
          `- Запрос на развитие: ${[g.category, g.quote, g.offered && `замена: ${g.offered}`].filter(Boolean).join(" — ")}`,
        );
    for (const g of x.gaps?.reported ?? [])
      L.push(
        `- Пока не умеем${g.category ? ` (${g.category})` : ""}: ${g.missing}${g.offered ? ` — замена: ${g.offered}` : ""}`,
      );
    if (!x.developmentRequests.length && !x.gaps?.reported?.length && x.gaps?.outOfScope?.length)
      L.push(`- Вне рамок по карточке: ${x.gaps.outOfScope.join("; ")}`);
    if (x.beyond)
      L.push(
        `- Бриф сверх возможностей: ${x.countedVia === "ready" ? "система с заменой готова" : x.countedVia === "gap_recorded" ? "честный отказ записан в «Запросы на развитие»" : x.countedVia === "gap_mentioned" ? "честный ответ агента есть, запись в разделе не проверена" : "честного ответа о недоступном не найдено"}.`,
      );
    L.push("");
  }
  L.push(...screenshotGrid(e.items));
  const notes = [...(meta.notes ?? [])];
  if (!e.gapsTable)
    notes.push(
      "Раздел «Запросы на развитие» из базы прочитать не удалось: запросы взяты из карточки и ответов агента.",
    );
  if (notes.length) L.push("## Что учесть", "", ...notes.map((n) => `- ${n}`), "");
  L.push(
    "Повтор — только провалившихся брифов: `briefs` в форме запуска (через запятую). Системы замера не удаляются: готовые ждут ревью первой публикации в /admin, организация замера видна в /admin «Пилот».",
    "",
  );
  return { text: L.join("\n"), summary: e };
}
