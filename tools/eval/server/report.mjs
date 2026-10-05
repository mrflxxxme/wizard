// Markdown report of the D67 measurement (product.yaml#decisions.D67_mvp_readiness): per brief — class, publish
// readiness, failed checks and why, minutes, ₽, «Запросы на развитие»; the total X of 10, the median of minutes, the
// sum of ₽ and the verdict against the threshold ≥ 7 of 10. Plain Russian for the founder (D28, D48); no values of
// secrets or personal data reach it (the eval account is a service one, the briefs are synthetic).
import { D67_THRESHOLD, RUB_PER_CREDIT } from "./driver.mjs";

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
  const costs = db.costs ?? {};
  const gapsTable = db.gaps !== undefined && db.gaps !== null;
  const items = doc.results.map((r) => {
    const exact = r.systemId ? costs[r.systemId] : undefined;
    const costRub = exact ? exact.rub : r.costRubEstimate;
    const recorded = gapsTable && r.systemId ? (db.gaps[r.systemId] ?? []) : [];
    const mentioned = r.beyond
      ? [...(r.gaps?.outOfScope ?? []), ...(r.gaps?.mentions ?? [])].filter((t) =>
          r.beyond.gapStems.some((s) => t.toLowerCase().includes(s.toLowerCase())),
        )
      : [];
    let counted = r.ready;
    let via = r.ready ? "ready" : null;
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
      counted,
      countedVia: via,
    };
  });
  const ran = items.filter((x) => x.status !== "skipped" && x.status !== "pending");
  const ready = items.filter((x) => x.counted).length;
  const threshold = Math.ceil((D67_THRESHOLD.ready / D67_THRESHOLD.of) * items.length);
  return {
    items,
    total: items.length,
    ran: ran.length,
    ready,
    threshold,
    passed: items.length >= D67_THRESHOLD.of ? ready >= D67_THRESHOLD.ready : ready >= threshold,
    medianMinutes: median(items.map((x) => x.minutes)),
    costRub: Math.round(items.reduce((s, x) => s + (x.costRub ?? 0), 0) * 100) / 100,
    costExact: items.filter((x) => x.systemId).every((x) => x.costExact),
    credits: Math.round(items.reduce((s, x) => s + (x.creditsUsed ?? 0), 0) * 1000) / 1000,
    gapsTable,
  };
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

/** The report text (Markdown). `meta`: {platform, date, briefsAsked, limitsNote}. */
export function renderReport(doc, db = {}, meta = {}) {
  const e = evaluate(doc, db);
  const L = [];
  const date = meta.date ?? String(doc.startedAt ?? "").slice(0, 10);
  L.push(`# Замер D67 на сервере пилота — ${date}`, "");
  L.push(
    `Платформа: ${meta.platform ?? doc.base} · прогон \`${doc.runId ?? "—"}\` · брифов: ${e.total}, запущено: ${e.ran} · бюджет ${rub(doc.maxCostRub)} · параллельно: ${doc.concurrency}`,
    "",
  );
  const verdict = e.passed
    ? `порог D67 (не меньше ${D67_THRESHOLD.ready} из ${D67_THRESHOLD.of}) достигнут`
    : `порог D67 (не меньше ${D67_THRESHOLD.ready} из ${D67_THRESHOLD.of}) не достигнут`;
  L.push(`**Итог: ${e.ready} из ${e.total} дошли до готовности к публикации — ${verdict}.**`, "");
  L.push(
    `- Медиана времени от брифа до конца сборки: ${e.medianMinutes === null ? "—" : `${e.medianMinutes} мин`}`,
    `- Расход моделей: ${rub(e.costRub)} ${e.costExact ? "(точно, по журналу вызовов моделей)" : `(оценка по кредитам: 1 кредит ≈ ${RUB_PER_CREDIT} ₽)`}; кредитов списано по прогонам: ${e.credits}`,
    `- Готовность к публикации — G0, G1 и G2 без блокеров; то, что делает владелец (секреты интеграций), показано отдельно и готовность не снимает.${doc.g2 === "skip" ? " **В этом прогоне G2 не запускался.**" : " G2 запускается первой публикацией: на пилоте она останавливается на ревью основателя, в prod ничего не уходит."}`,
    "",
  );
  L.push("| Бриф | Класс | Итог | Не прошли | Мин | ₽ | Запросы на развитие |", "|---|---|---|---|---|---|---|");
  for (const x of e.items) {
    const failed = checksLine(x);
    const gaps = x.developmentRequests.length
      ? x.developmentRequests.map((g) => g.category ?? g.quote).join("; ")
      : x.gapMentioned.length
        ? `в ответе агента: ${x.gapMentioned[0]}`
        : x.gaps?.outOfScope?.length
          ? `вне рамок: ${x.gaps.outOfScope.join("; ")}`
          : "—";
    const mark = x.counted ? (x.countedVia === "ready" ? "✅" : "✅*") : "❌";
    L.push(
      `| ${cell(x.id)} | ${cell(CLASS_RU[x.class] ?? x.class)} | ${mark} ${cell(STATUS_RU[x.status] ?? x.status)} | ${cell(failed.length ? `${failed.length}: ${failed.map((f) => f.split(":")[0]).join(", ")}` : "—")} | ${x.minutes ?? "—"} | ${x.systemId ? `${Math.round(x.costRub)}${x.costExact ? "" : "≈"}` : "—"} | ${cell(gaps).slice(0, 200)} |`,
    );
  }
  if (e.items.some((x) => x.countedVia === "gap_mentioned"))
    L.push(
      "",
      "✅* — бриф сверх возможностей засчитан по честному ответу агента; раздела «Запросы на развитие» в базе ещё нет, запись не проверена.",
    );
  if (e.items.some((x) => x.countedVia === "gap_recorded"))
    L.push("", "✅* — бриф сверх возможностей засчитан: отказ честный и записан в «Запросы на развитие».");
  L.push("", "## По брифам", "");
  for (const x of e.items) {
    L.push(`### ${x.id} — ${x.title}`, "");
    L.push(`- Класс: ${CLASS_RU[x.class] ?? x.class}. Итог: ${STATUS_RU[x.status] ?? x.status}.`);
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
    if (x.inputs?.length)
      L.push(`- Сборка спрашивала: ${x.inputs.map((i) => `${i.decisionId ?? i.kind} → ${i.choice ?? "нет ответа"}`).join("; ")}.`);
    for (const level of ["G0", "G1", "G2"]) {
      const g = x.gates?.[level];
      if (!g) continue;
      const head = g.passed ? "пройдена" : g.blockers.length ? "не пройдена" : "ждёт действий владельца";
      L.push(`- ${level}: ${head}${g.warnings ? `, предупреждений ${g.warnings}` : ""}.`);
      for (const c of g.blockers) L.push(`  - ${c.id}: ${c.message}`);
      for (const c of g.ownerActions) L.push(`  - владельцу: ${c.id} — ${c.message}`);
    }
    if (x.publish) L.push(`- Публикация: ${PUBLISH_RU[x.publish.status] ?? x.publish.status}${x.publish.message ? ` — ${x.publish.message}` : ""}.`);
    L.push(
      `- Расход: ${x.systemId ? rub(x.costRub) : "—"}${x.costExact ? "" : " (оценка)"}, кредитов ${x.creditsUsed}.`,
    );
    if (x.developmentRequests.length)
      for (const g of x.developmentRequests)
        L.push(`- Запрос на развитие: ${[g.category, g.quote, g.offered && `замена: ${g.offered}`].filter(Boolean).join(" — ")}`);
    else if (x.gaps?.outOfScope?.length) L.push(`- Вне рамок по карточке: ${x.gaps.outOfScope.join("; ")}`);
    if (x.beyond)
      L.push(
        `- Бриф сверх возможностей: ${x.countedVia === "ready" ? "система с заменой готова" : x.countedVia === "gap_recorded" ? "честный отказ записан в «Запросы на развитие»" : x.countedVia === "gap_mentioned" ? "честный ответ агента есть, запись в разделе не проверена" : "честного ответа о недоступном не найдено"}.`,
      );
    L.push("");
  }
  const notes = [...(meta.notes ?? [])];
  if (!e.gapsTable)
    notes.push(
      "Таблицы «Запросов на развитие» в базе платформы ещё нет (M2-59): запросы взяты из карточки и ответов агента.",
    );
  if (notes.length) L.push("## Что учесть", "", ...notes.map((n) => `- ${n}`), "");
  L.push(
    "Повтор — только провалившихся брифов: `briefs` в форме запуска (через запятую). Системы замера не удаляются: готовые ждут ревью первой публикации в /admin, организация замера видна в /admin «Пилот».",
    "",
  );
  return { text: L.join("\n"), summary: e };
}
