// V3-18: the report of the v3 measurement on the pilot server (checkpoint 1 of wave A; docs/progress/v3-a-checkpoint1-
// <date>.md + .json): per brief — the stages and their times, the preview, the total time, ₽ against the build cap,
// the brief's scenarios (passed / total / moved to «Запросы на развитие»), the techreview verdict and its blockers,
// the critic's score and cycles, the template gate (similarity, redesign), G0–G2, the model calls by type and the
// screenshots at 390 and 1280 px; the totals against D77_v3 (10)–(11) and (16). Plain Russian for the founder; no
// secrets and no personal data reach it (the eval account is a service one, the briefs are synthetic).

import { RUB_PER_CREDIT } from "./driver.mjs";
import { median, screenshotGrid } from "./report.mjs";
import { V3_STAGE_IDS, V3_TARGETS } from "./v3.mjs";

const CLASS_RU = { site: "сайт бизнеса", booking: "услуги и запись", crm: "CRM и админка", shop: "магазин" };
const STATUS_RU = {
  ready: "готова",
  not_ready: "собрана, но не готова",
  build_failed: "сборка не удалась",
  interview_failed: "интервью не дошло до брифа",
  skipped: "не запускался (бюджет или остановка замера)",
  error: "ошибка замера",
  pending: "не запускался",
  running: "не завершён",
};
const STAGE_RU = {
  brief: "бриф",
  design: "дизайн-система",
  backend: "бэкенд",
  skeleton: "каркас и превью",
  scenarios: "сценарии",
  critic: "критик",
  template_gate: "шаблонность",
  techreview: "техревью",
  gates: "проверки G0–G2",
};
const STAGE_STATUS_RU = {
  done: "готов",
  reused: "из чекпоинта",
  skipped: "пропущен",
  failed: "не удался",
  running: "не закончен",
  pending: "не начат",
};
const SCENARIO_RU = {
  passed: "готов",
  failed: "не прошёл",
  stopped: "остановлен",
  pending: "не начат",
  running: "не закончен",
};
const PUBLISH_RU = {
  review_pending: "ждёт ревью основателя",
  published: "опубликована",
  failed: "публикация остановлена проверками",
  refused: "публикация не принята",
  not_publishable: "до публикации не дошла",
  skipped: "G2 не запускался",
};
const ANSWER_RU = {
  recommended: "рекомендованный",
  option: "вариант из брифа",
  delegate: "«Решите за меня»",
  text: "свой текст",
};

const rub = (n) => `${(Math.round(n * 100) / 100).toLocaleString("ru-RU").replace(/ /g, " ")} ₽`;
const cell = (s) =>
  String(s ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
const avg = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x));
  return a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 100) / 100 : null;
};
const mark = (ok) => (ok === null ? "—" : ok ? "✅" : "❌");

/** Russian names of the critic's axes (agents critic/rubric.ts AXIS_RUBRIC). */
const AXIS_RU = {
  specificity: "конкретность",
  first_screen: "первый экран",
  typography: "типографика",
  color: "цвет",
  composition: "композиция",
  content: "содержание",
};

/** The critic's last cycle in words: the axes 0–4, the verdict and the main findings (V3-40 diagnostics). */
export function criticReviewLines(review) {
  const last = review?.cycles?.at(-1);
  if (!last) return [];
  const axes = Object.entries(last.axes ?? {})
    .map(([k, v]) => `${AXIS_RU[k] ?? k} ${v}`)
    .join(", ");
  const out = [`оси последнего круга (0–4): ${axes || "—"}; проработка: ${last.polish === "production" ? "готово" : "черновик"}`];
  for (const f of last.top ?? []) out.push(`${f.severity} ${f.sign} (${f.where})`);
  return out;
}

/** «оценка 62→78» and «циклов 2» of the critic's note (V3-13 createCriticHook) → {score, cycles}. */
export function criticOf(note) {
  const t = String(note ?? "");
  const cycles = /циклов (\d+)/.exec(t);
  const scores = /оценка ([\d.→]+)/.exec(t);
  const list = scores ? scores[1].split("→").map(Number).filter(Number.isFinite) : [];
  // A cycle that scored lower rolled its batch back: the site kept is the one the previous cycle scored.
  const kept = list.length > 1 && list.at(-1) < list.at(-2) ? list.at(-2) : (list.at(-1) ?? null);
  return { cycles: cycles ? Number(cycles[1]) : null, score: list.length ? list.at(-1) : null, scores: list, kept };
}

/** Stage times and the preview from run_events of the database (when the driver read no stream), as the driver does. */
export function traceFromEvents(events) {
  const runs = [...new Set(events.map((e) => e.runId))];
  const runId = runs.at(-1);
  const own = events.filter((e) => e.runId === runId).sort((a, b) => a.seq - b.seq);
  const t = { startedAt: null, endedAt: null, previewAt: null, stages: {} };
  for (const e of own) {
    const ts = e.ts ? new Date(e.ts) : null;
    if (!ts) continue;
    if (e.type === "run_started") t.startedAt ??= ts;
    if (e.type === "run_finished" || e.type === "run_failed") t.endedAt = ts;
    if (e.preview !== null && e.preview !== undefined && !t.previewAt) t.previewAt = ts;
    if (e.type === "build_stage" && e.stage) {
      t.stages[e.stage] ??= { id: e.stage, label: e.label ?? e.stage, status: "pending" };
      const st = t.stages[e.stage];
      if (e.status === "started") [st.status, st.startedAt] = ["running", ts];
      else {
        st.status = e.status;
        st.sec = st.startedAt ? Math.max(0, Math.round((ts - st.startedAt) / 1000)) : 0;
      }
    }
  }
  const min = (a, b) => (a && b ? Math.round(((b - a) / 60_000) * 10) / 10 : null);
  return {
    minutes: min(t.startedAt, t.endedAt),
    previewMinutes: min(t.startedAt, t.previewAt),
    stages: V3_STAGE_IDS.filter((id) => t.stages[id]).map((id) => ({
      id,
      label: t.stages[id].label,
      status: t.stages[id].status,
      sec: t.stages[id].sec ?? null,
    })),
  };
}

/** Per brief verdicts and the facts of the database; the totals against the targets of D77_v3. */
export function evaluateV3(doc, db = {}) {
  const costs = db.costs ?? {};
  const v3 = db.v3 ?? {};
  const items = doc.results.map((r) => {
    const sid = r.systemId;
    const exact = sid ? costs[sid] : undefined;
    const costRub = exact ? exact.rub : r.costRubEstimate;
    const metrics = (sid && db.metrics?.[sid]?.stages) || null;
    const hooks = (sid && v3.hooks?.[sid]) || {};
    const calls = (sid && v3.calls?.[sid]) || [];
    // Stage times: the stream the driver read, else the run_events of the database.
    let build = r.build;
    if (sid && v3.events?.[sid]?.length && (!build?.stages?.length || build.minutes === null)) {
      const fromDb = traceFromEvents(v3.events[sid]);
      build = { ...(build ?? {}), ...fromDb, stages: build?.stages?.length ? build.stages : fromDb.stages };
    }
    const stageMetric = (id) => (metrics && typeof metrics[id] === "object" ? metrics[id] : null);
    const critic = {
      ...criticOf(stageMetric("critic")?.note),
      status: stageMetric("critic")?.status ?? hooks.critic?.status ?? null,
      note: stageMetric("critic")?.note ?? null,
      notes: hooks.critic?.notes ?? [],
      review: hooks.critic?.review ?? null,
    };
    const skeletonTemplate = hooks.skeleton?.template ?? null;
    const template = {
      status: stageMetric("template_gate")?.status ?? hooks.template_gate?.status ?? null,
      similarity: v3.similarity?.[sid]?.similarity ?? null,
      archetype: v3.similarity?.[sid]?.archetype ?? null,
      redesign: skeletonTemplate?.redesign ?? null,
      note: stageMetric("template_gate")?.note ?? skeletonTemplate?.note ?? null,
    };
    const trBlockers = hooks.techreview?.blockers ?? [];
    const techreview = {
      status: stageMetric("techreview")?.status ?? r.techreview?.status ?? null,
      blockers: trBlockers.length ? trBlockers : r.techreview?.message ? [r.techreview.message] : [],
      note: stageMetric("techreview")?.note ?? null,
      notes: hooks.techreview?.notes ?? [],
    };
    techreview.verdict =
      techreview.blockers.length > 0
        ? "блокеры — без публикации"
        : techreview.status === "done" || techreview.status === "reused"
          ? "без блокеров"
          : techreview.status === "skipped"
            ? "пропущено"
            : "не дошло";
    const sc = build?.scenarios ?? null;
    const recorded = sid && db.gaps ? (db.gaps[sid] ?? []) : [];
    return {
      ...r,
      build,
      costRub,
      costExact: !!exact,
      calls: calls.sort((a, b) => b.rub - a.rub || a.callType.localeCompare(b.callType)),
      metrics,
      critic,
      template,
      techreview,
      developmentRequests: recorded,
      scenarios: sc,
      counted: !!r.ready,
    };
  });
  const built = items.filter((x) => x.build?.minutes !== null && x.build?.minutes !== undefined);
  const previews = items.map((x) => x.build?.previewMinutes).filter(Number.isFinite);
  // D77 (10), (16): from the ready brief to the end of the build (older documents: from the start of the interview).
  const totals = items.map((x) => x.fromBriefMinutes ?? x.minutes).filter(Number.isFinite);
  const interviews = items.map((x) => x.interview?.minutes).filter(Number.isFinite);
  const rubs = items.filter((x) => x.systemId).map((x) => x.costRub);
  const e = {
    items,
    total: items.length,
    ran: items.filter((x) => !["skipped", "pending"].includes(x.status)).length,
    ready: items.filter((x) => x.ready).length,
    passed: items.length > 0 && items.every((x) => x.ready),
    costRub: Math.round(items.reduce((s, x) => s + (x.costRub ?? 0), 0) * 100) / 100,
    costExact: items.filter((x) => x.systemId).every((x) => x.costExact),
    credits: Math.round(items.reduce((s, x) => s + (x.creditsUsed ?? 0), 0) * 1000) / 1000,
    medianMinutes: median(totals),
    maxMinutes: totals.length ? Math.max(...totals) : null,
    medianBuildMinutes: median(built.map((x) => x.build.minutes)),
    medianInterviewMinutes: median(interviews),
    maxPreviewMinutes: previews.length ? Math.max(...previews) : null,
    avgRub: avg(rubs),
    maxRub: rubs.length ? Math.max(...rubs) : null,
    t1Forbidden: v3.t1Forbidden ?? null,
    gapsTable: db.gaps !== undefined && db.gaps !== null,
  };
  e.targets = {
    preview: e.maxPreviewMinutes === null ? null : e.maxPreviewMinutes <= V3_TARGETS.previewMin,
    median: e.medianMinutes === null ? null : e.medianMinutes <= V3_TARGETS.medianMin,
    cap: e.maxMinutes === null ? null : e.maxMinutes <= V3_TARGETS.capMin,
    avgRub: e.avgRub === null ? null : e.avgRub <= V3_TARGETS.targetRub,
    maxRub: e.maxRub === null ? null : e.maxRub <= V3_TARGETS.capRub,
  };
  return e;
}

/** Failed attempts of a call type: «kimi-k2.6: TIMEOUT ×2; qwen3.6-35b: HTTP_4xx · ≈ 180 с» (— without failures). */
function failuresCell(x) {
  if (!x.failures.size) return "—";
  const codes = [...x.failures.entries()].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join("; ");
  const ms = x.failMs.length ? Math.round(x.failMs.reduce((s, v) => s + v, 0) / x.failMs.length / 1000) : null;
  return cell(`${codes}${ms === null ? "" : ` · ≈ ${ms} с`}`);
}

/** Model calls of one system by call type: «interview_v3 ×7 (glm-5.3) — 3.2 ₽». */
function callsLines(calls) {
  const by = new Map();
  for (const c of calls) {
    const x = by.get(c.callType) ?? {
      attempts: 0,
      ok: 0,
      fallback: 0,
      rub: 0,
      models: new Set(),
      tiers: new Set(),
      failures: new Map(),
      failMs: [],
      ms: 0,
      timed: 0,
    };
    for (const f of c.failures ?? []) x.failures.set(`${c.model}: ${f}`, (x.failures.get(`${c.model}: ${f}`) ?? 0) + 1);
    if (c.failureLatencyMs !== null && c.failureLatencyMs !== undefined) x.failMs.push(c.failureLatencyMs);
    if (c.latencyMs !== null && c.latencyMs !== undefined) {
      x.ms += c.latencyMs * c.attempts;
      x.timed += c.attempts;
    }
    x.attempts += c.attempts;
    x.ok += c.ok;
    x.fallback += c.fallback;
    x.rub += c.rub;
    x.models.add(c.model);
    x.tiers.add(c.tier);
    by.set(c.callType, x);
  }
  return [...by.entries()]
    .sort((a, b) => b[1].rub - a[1].rub)
    .map(
      ([type, x]) =>
        `| ${cell(type)} | ${x.ok} из ${x.attempts}${x.fallback ? `, резерв ${x.fallback}` : ""} | ${cell([...x.models].join(", "))} | ${[...x.tiers].join(", ")} | ${rub(x.rub)} | ${x.timed ? Math.round(x.ms / x.timed / 1000) : "—"} | ${failuresCell(x)} |`,
    );
}

/** The report text (Markdown) and the summary for the spend journal. `meta`: {platform, date, notes}. */
export function renderV3Report(doc, db = {}, meta = {}) {
  const e = evaluateV3(doc, db);
  const date = meta.date ?? String(doc.startedAt ?? "").slice(0, 10);
  const L = [];
  L.push(
    doc.threshold === "v3-final"
      ? `# Финальный замер v3: прогон на сервере — ${date}`
      : `# Чекпоинт 1 волны A: замер v3 на сервере — ${date}`,
    "",
  );
  L.push(
    `Платформа: ${meta.platform ?? doc.base} · прогон \`${doc.runId ?? "—"}\` · брифов: ${e.total}, запущено: ${e.ran} · потолок прогона ${rub(doc.maxCostRub)} · параллельно: ${doc.concurrency}`,
    "",
  );
  L.push(
    `**Итог: готовы ${e.ready} из ${e.total}** — сборка по брифу дошла до конца, G0–G2 без блокеров, техревью без блокеров, все обязательные сценарии брифа прошли.`,
    "",
  );
  if (doc.stopped) L.push(`- Замер остановлен: ${doc.stopped}.`);
  L.push(
    `- Время (D77 (10)): превью — до ${e.maxPreviewMinutes ?? "—"} мин ${mark(e.targets.preview)} (цель ≤ ${V3_TARGETS.previewMin}); от брифа до конца сборки — медиана ${e.medianMinutes ?? "—"} мин ${mark(e.targets.median)} (≤ ${V3_TARGETS.medianMin}), максимум ${e.maxMinutes ?? "—"} мин ${mark(e.targets.cap)} (≤ ${V3_TARGETS.capMin}); медиана самой сборки ${e.medianBuildMinutes ?? "—"} мин; интервью (время владельца, вне цели) — медиана ${e.medianInterviewMinutes ?? "—"} мин.`,
    `- Деньги (D77 (11)): в среднем ${e.avgRub === null ? "—" : rub(e.avgRub)} на систему ${mark(e.targets.avgRub)} (цель ≤ ${V3_TARGETS.targetRub} ₽), максимум ${e.maxRub === null ? "—" : rub(e.maxRub)} ${mark(e.targets.maxRub)} (потолок ${V3_TARGETS.capRub} ₽); всего ${rub(e.costRub)} ${e.costExact ? "(точно, по журналу вызовов моделей)" : `(оценка по кредитам: 1 кредит ≈ ${RUB_PER_CREDIT} ₽)`}, кредитов ${e.credits}.`,
    ...(e.t1Forbidden === null
      ? []
      : [`- Вызовы T1 с типами, которым запрещены ПДн: ${e.t1Forbidden} ${mark(e.t1Forbidden === 0)}.`]),
    "",
  );
  L.push(
    "| Бриф | Класс | Итог | Превью, мин | От брифа, мин | ₽ | Сценарии ✓/всего (в запросы) | Техревью | Критик | Шаблонность | G0/G1/G2 |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const x of e.items) {
    const sc = x.scenarios;
    const g = ["G0", "G1", "G2"]
      .map((l) => (x.gates?.[l] ? (x.gates[l].passed ? "✓" : x.gates[l].blockers.length ? "✗" : "…") : "—"))
      .join("/");
    const crit =
      x.critic.score !== null
        ? `${x.critic.score}, циклов ${x.critic.cycles ?? "—"}`
        : x.critic.status === "skipped"
          ? "пропущен"
          : "—";
    const tmpl =
      x.template.similarity !== null
        ? `${Math.round(x.template.similarity * 100)} %${x.template.redesign ? ", стиль сменён" : ""}`
        : x.template.status === "skipped"
          ? "пропущен"
          : "—";
    L.push(
      `| ${cell(x.id)} | ${cell(CLASS_RU[x.class] ?? x.class)} | ${x.ready ? "✅" : "❌"} ${cell(STATUS_RU[x.status] ?? x.status)} | ${x.build?.previewMinutes ?? "—"} | ${x.fromBriefMinutes ?? x.minutes ?? "—"} | ${x.systemId ? `${Math.round(x.costRub)}${x.costExact ? "" : "≈"}` : "—"} | ${sc ? `${sc.passed}/${sc.total} (${sc.toRequests})` : "—"} | ${cell(x.techreview.verdict)} | ${cell(crit)} | ${cell(tmpl)} | ${g} |`,
    );
  }
  L.push("", "## По брифам", "");
  for (const x of e.items) {
    L.push(`### ${x.id} — ${x.title}`, "");
    L.push(`- Класс: ${CLASS_RU[x.class] ?? x.class}. Итог: ${STATUS_RU[x.status] ?? x.status}.`);
    if (x.systemId) L.push(`- Система: \`${x.systemId}\``);
    if (x.error) L.push(`- Что случилось: ${x.error}`);
    const iv = x.interview;
    if (iv?.turns)
      L.push(
        `- Интервью: вопросов ${iv.questions}, ходов ${iv.turns}${iv.minutes !== null ? `, ${iv.minutes} мин` : ""}; ответы — ${
          Object.entries(iv.by ?? {})
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${ANSWER_RU[k] ?? k} ${n}`)
            .join(", ") || "—"
        }${iv.restAt ? `; «Дальше решай сам» на ${iv.restAt}-м вопросе` : ""}${iv.retries ? `; повторов хода ${iv.retries}` : ""}.`,
      );
    if (x.tz)
      L.push(
        x.tz.uploaded
          ? `- ТЗ файлом (${x.tz.format}): бриф версии ${x.tz.version ?? "—"}, черновик ${x.tz.method === "model" ? "моделью" : "без модели"}${x.tz.gaps !== null ? `, интервью осталось уточнить ${x.tz.gaps}` : ""}.`
          : `- ТЗ файлом не принято: ${x.tz.error}.`,
      );
    if (x.brief)
      L.push(
        `- Бриф v${x.brief.version}: целей ${x.brief.goals}, сценариев ${x.brief.scenarios.must} обязательных и ${x.brief.scenarios.should} желательных, ролей ${x.brief.roles}, сущностей ${x.brief.data}, интеграций ${x.brief.integrations}, «не входит» ${x.brief.outOfScope}, допущений ${x.brief.assumptions}; карта возможностей — модули ${x.brief.capability.modules}, доработка ${x.brief.capability.custom}, «пока не умеем» ${x.brief.capability.not_yet}.`,
      );
    if (x.coverage) {
      const miss = ["roles", "entities", "features", "acceptance"].flatMap((k) => x.coverage[k].missing);
      L.push(
        `- Ожидания брифа покрыты на ${Math.round(x.coverage.score * 100)} %${miss.length ? `; не нашлось: ${miss.join("; ")}` : ""}.`,
      );
    }
    if (x.direction)
      L.push(
        x.direction.error
          ? `- Направления: ${x.direction.error}.`
          : `- Направления: ${x.direction.names.map((n) => `«${n}»`).join(", ")}${x.direction.fallback ? " (тексты из брифа, без модели)" : ""}; ${x.direction.n === null ? "«Решите за меня»" : `выбрано ${x.direction.n}-е`} → архетип ${x.direction.archetype ?? "—"}${x.direction.pinned ? ", закреплён" : ""}; ${rub(x.direction.costRub)}.`,
      );
    const b = x.build;
    if (b) {
      L.push(
        `- Сборка: ${b.status === "succeeded" ? "завершилась" : `не завершилась (${b.failure?.message_ru ?? b.status})`}; ${b.minutes ?? "—"} мин, превью через ${b.previewMinutes ?? "—"} мин; по снимку хода — ${b.spentRub === null || b.spentRub === undefined ? "—" : rub(b.spentRub)} из ${b.capRub === null || b.capRub === undefined ? "—" : rub(b.capRub)}${b.reusedRub ? ` (из чекпоинтов ${rub(b.reusedRub)})` : ""}.`,
      );
      if (b.stages?.length) {
        L.push("", "  | Этап | Статус | с | ₽ | Заметка |", "  |---|---|---|---|---|");
        for (const s of b.stages) {
          const m = x.metrics?.[s.id];
          L.push(
            `  | ${cell(STAGE_RU[s.id] ?? s.label)} | ${cell(STAGE_STATUS_RU[s.status] ?? s.status)} | ${s.sec ?? (m?.durationMs ? Math.round(m.durationMs / 1000) : "—")} | ${m?.costRub !== undefined ? rub(m.costRub) : "—"} | ${cell(m?.note ?? "")} |`,
          );
        }
        L.push("");
      }
      if (b.scenarios?.list?.length) {
        L.push(
          `- Сценарии брифа: готово ${b.scenarios.passed} из ${b.scenarios.total}, в «Запросы на развитие» ${b.scenarios.toRequests}.`,
        );
        for (const s of b.scenarios.list.filter((y) => y.status !== "passed"))
          L.push(
            `  - ${s.priority === "must" ? "обязательный" : "желательный"} «${s.title}»: ${SCENARIO_RU[s.status] ?? s.status}${s.reason ? ` — ${s.reason}` : ""}`,
          );
      }
    }
    // V3-23: the shop's payment through the founder's ЮKassa test shop (tools/eval/server/v3-pay.mjs).
    if (x.payment) {
      const P = {
        paid: "✅ заказ оплачен тестовой картой и стал «Оплачен»",
        failed: "❌ не прошла",
        skipped: "не проверялась",
        refused: "не запускалась",
        keys_only: "ключи введены, покупка не проверялась (нет браузера)",
      };
      L.push(`- Оплата ЮKassa (тестовый магазин): ${P[x.payment.status] ?? x.payment.status}${x.payment.note ? ` — ${x.payment.note}` : ""}.`);
      if (x.payment.recheck)
        L.push(
          `  - проверено пробой оплаты${typeof x.payment.recheck === "string" ? ` ${x.payment.recheck}` : ""} на той же системе после исправления автоматизации страницы ЮKassa (в прогоне замера: ${P[x.payment.before] ?? x.payment.before ?? "—"})`,
        );
      if (x.payment.keys?.keys?.length) L.push(`  - ключи через окно ключа: ${x.payment.keys.keys.join(", ")}`);
      if (x.payment.keys?.message) L.push(`  - ключи: ${x.payment.keys.message}`);
      for (const st of x.payment.steps ?? [])
        L.push(`  - ${st.ok ? "✓" : "✗"} ${st.step}${st.note ? ` (${st.note})` : ""}`);
    }
    if (x.techreview.status || x.techreview.blockers.length) {
      L.push(`- Техревью: ${x.techreview.verdict}${x.techreview.note ? ` (${x.techreview.note})` : ""}.`);
      for (const bl of x.techreview.blockers) L.push(`  - блокер: ${bl}`);
      for (const n of x.techreview.notes.slice(0, 5)) L.push(`  - ${n}`);
    }
    if (x.critic.status) {
      L.push(
        `- Критик: ${x.critic.status === "skipped" ? "пропущен (нет браузера или бюджета этапа)" : `оценка ${x.critic.scores.length ? x.critic.scores.join(" → ") : "—"}, циклов ${x.critic.cycles ?? "—"}`}${x.critic.note && x.critic.status !== "done" ? ` (${x.critic.note})` : ""}.`,
      );
      for (const n of x.critic.notes.slice(0, 3)) L.push(`  - ${n}`);
      for (const line of criticReviewLines(x.critic.review)) L.push(`  - ${line}`);
    }
    if (x.template.status === "skipped" && x.template.similarity === null)
      L.push("- Гейт шаблонности: пропущен (нет браузера для снимков сайта).");
    else if (x.template.status || x.template.similarity !== null)
      L.push(
        `- Гейт шаблонности: сходство с недавними сайтами ниши ${x.template.similarity === null ? "— (память пуста)" : `${Math.round(x.template.similarity * 100)} %`}${x.template.redesign ? `; после каркаса стиль сменён: ${x.template.redesign.from} → ${x.template.redesign.to}` : ""}${x.template.note ? ` (${x.template.note})` : ""}.`,
      );
    for (const level of ["G0", "G1", "G2"]) {
      const g = x.gates?.[level];
      if (!g) continue;
      L.push(
        `- ${level}: ${g.passed ? "пройдена" : g.blockers.length ? "не пройдена" : "ждёт действий владельца"}.`,
      );
      for (const c of g.blockers) L.push(`  - ${c.id}: ${c.message}`);
      for (const c of g.ownerActions) L.push(`  - владельцу: ${c.id} — ${c.message}`);
    }
    if (x.publish)
      L.push(
        `- Публикация: ${PUBLISH_RU[x.publish.status] ?? x.publish.status}${x.publish.message ? ` — ${String(x.publish.message).replace(/[.\s]+$/u, "")}` : ""}.`,
      );
    L.push(
      `- Расход системы: ${x.systemId ? rub(x.costRub) : "—"}${x.costExact ? "" : " (оценка)"}, кредитов ${x.creditsUsed}.`,
    );
    if (x.calls.length) {
      L.push("", "  | Тип вызова | Успешно из попыток | Модель | Уровень | ₽ | С на попытку | Отказы |", "  |---|---|---|---|---|---|---|");
      L.push(...callsLines(x.calls).map((l) => `  ${l}`), "");
    }
    for (const g of x.developmentRequests)
      L.push(
        `- Запрос на развитие: ${[g.category, g.quote, g.offered && `замена: ${g.offered}`].filter(Boolean).join(" — ")}`,
      );
    if (x.brief?.canariesKept)
      L.push(
        `- Канарейки ПДн брифа в брифе системы: ${x.brief.canariesKept} (бриф хранится в РФ; к T1 он уходит после маскирования).`,
      );
    L.push("");
  }
  L.push(...screenshotGrid(e.items));
  const notes = [...(meta.notes ?? [])];
  if (!e.gapsTable) notes.push("Раздел «Запросы на развитие» из базы прочитать не удалось.");
  if (notes.length) L.push("## Что учесть", "", ...notes.map((n) => `- ${n}`), "");
  L.push(
    "Повтор — только упавших брифов (волна retry, `briefs` через запятую). Системы замера не удаляются: первая публикация ждёт ревью основателя в /admin.",
    "",
  );
  return { text: L.join("\n"), summary: e };
}

/** Name of the checkpoint report: docs/progress/v3-a-checkpoint1-<yyyy-mm-dd>.{md,json} (the artifact keeps it so). */
export const checkpointName = (date) => `v3-a-checkpoint1-${String(date).slice(0, 10)}`;
/** V3-40: the run report of the final measurement (per brief) — docs/progress/v3-final-run-<yyyy-mm-dd>.{md,json}. */
export const finalRunName = (date) => `v3-final-run-${String(date).slice(0, 10)}`;
/** V3-40: the report by the exit criteria of the plan §6 — docs/progress/v3-final-<yyyy-mm-dd>.md (server/v3-final.mjs). */
export const finalName = (date) => `v3-final-${String(date).slice(0, 10)}`;
