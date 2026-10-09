// Live progress of the D67 measurement (the job log of GitHub Actions is readable only after the job ends): one
// comment per run in the issue «Замер D67: ход на сервере», edited at most once a minute and at the end. It carries
// brief ids, statuses, minutes, ₽ estimates and the driver's lines — synthetic eval data, no tokens, no addresses.
export const PROGRESS_ISSUE_TITLE = "Замер D67: ход на сервере";
export const PROGRESS_EVERY_MS = 60_000;
const MAX_LINES = 60;

const STATUS_RU = {
  pending: "ждёт",
  running: "идёт",
  ready: "✅ готова",
  not_ready: "❌ не готова",
  build_failed: "❌ сборка не удалась",
  interview_failed: "❌ интервью",
  error: "❌ ошибка",
  skipped: "⏭ пропущен",
};

const cell = (s) => String(s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 140);

/** Markdown of the progress comment. */
export function progressText({ runId, runUrl, startedAt, budgetRub, results, lines, stopped, finished }) {
  const spent = results.reduce((s, r) => s + (r.costRubEstimate ?? 0), 0);
  const done = results.filter((r) => !["pending", "running"].includes(r.status)).length;
  const ready = results.filter((r) => r.ready).length;
  const head = finished
    ? `**Замер закончен${stopped ? ` (остановлен: ${stopped})` : ""}.** Готовы ${ready} из ${results.length}.`
    : stopped
      ? `**Останавливается: ${stopped}.**`
      : `**Идёт.** Завершено ${done} из ${results.length}, готовы ${ready}.`;
  return [
    `### Замер \`${runId}\``,
    `${head} Расход ≈ ${Math.round(spent)} ₽ из ${budgetRub} ₽ · начало ${startedAt}${runUrl ? ` · [задание](${runUrl})` : ""}`,
    "",
    "| Бриф | Статус | Мин | ₽≈ | Что случилось |",
    "|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${cell(r.id)} | ${STATUS_RU[r.status] ?? cell(r.status)} | ${r.minutes ?? "—"} | ${Math.round(r.costRubEstimate ?? 0)} | ${cell(r.error ?? r.build?.failure?.message_ru ?? r.build?.failure?.code ?? "")} |`,
    ),
    "",
    "<details open><summary>Последние строки журнала</summary>",
    "",
    "```",
    ...lines.slice(-MAX_LINES),
    "```",
    "</details>",
  ].join("\n");
}

/**
 * Publisher to the GitHub issue (token of the job with issues: write). Returns null without a token: the measurement
 * runs as before. Errors are warnings — the progress is a convenience, never a reason to stop the measurement.
 */
export function githubProgress({ token, repo, fetch: f = fetch, now = () => Date.now(), log = () => {} }) {
  if (!token || !repo) return null;
  const api = async (method, path, body) => {
    const r = await f(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) throw new Error(`GitHub API ${method} ${path.split("?")[0]}: HTTP ${r.status}`);
    return r.status === 204 ? {} : r.json();
  };
  let commentId = null;
  let last = Number.NEGATIVE_INFINITY;
  let chain = Promise.resolve();
  let warned = false;
  const write = async (text) => {
    if (commentId === null) {
      const open = await api("GET", "/issues?state=open&per_page=100");
      let issue = open.find((i) => i.title === PROGRESS_ISSUE_TITLE && !i.pull_request);
      if (!issue)
        issue = await api("POST", "/issues", {
          title: PROGRESS_ISSUE_TITLE,
          body: "Ход замеров D67 на сервере пилота: по комментарию на запуск, обновляется раз в минуту (tools/eval/server/progress.mjs).",
        });
      commentId = (await api("POST", `/issues/${issue.number}/comments`, { body: text })).id;
      return;
    }
    await api("PATCH", `/issues/comments/${commentId}`, { body: text });
  };
  return {
    /** Publishes when a minute has passed since the last write (or `force`); never throws. */
    publish(text, { force = false } = {}) {
      if (!force && now() - last < PROGRESS_EVERY_MS) return chain;
      last = now();
      chain = chain
        .then(() => write(text))
        .catch((e) => {
          if (!warned) log(`::warning::ход замера в issue не публикуется: ${e.message}`);
          warned = true;
        });
      return chain;
    },
  };
}
