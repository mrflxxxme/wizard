#!/usr/bin/env node
// B2-03 (D76, docs/plans/2026-10-06-beta-v2.md): the «Бета v2» progress page and the daily Telegram digest.
//   node tools/progress/b2.mjs --html <out.html>   self-contained page (no external scripts or fonts)
//   node tools/progress/b2.mjs --digest [--send]   3–5 line digest on stdout; --send also posts it to Telegram
// Options: --root <repo> (default: this repository), --ref <git ref> (default: main → origin/main → HEAD).
// Sources: specs/backlog.yaml (tasks of milestone B2), git log of main (subjects «B2-NN: …» are merged work) and the
// optional docs/progress/b2-extra.json kept by the orchestrator (deploys, spend by day, probes, founder asks, notes).
// Env: B2_PAGE_URL (link in the digest), WIZARD_OPS_ALERT_TELEGRAM_TOKEN and WIZARD_OPS_ALERT_CHAT_ID (for --send).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseYamlFiles } from "../specs/validate.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MILESTONE = "B2";
/** Development budget of beta v2 for probes and the final eval, ₽ (decision 18), and the alert share. */
export const BUDGET_RUB = 1000;
export const ALERT_SHARE = 0.7;
export const TELEGRAM_API = "https://api.telegram.org";
const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = "Europe/Moscow";

/** Streams of the plan (section 4) by the backlog's parallel_group. */
export const STREAMS = [
  { group: "b2-0", key: "0", title: "Поток 0 — разблокировка и прозрачность" },
  { group: "b2-a", key: "A", title: "Поток A — конвейер" },
  { group: "b2-b", key: "B", title: "Поток B — дизайн" },
  { group: "b2-c", key: "C", title: "Поток C — приёмка" },
];
const STATUS_LABEL = { done: "готово", in_progress: "в работе", todo: "не начата" };
const bucket = (status) => (status === "done" || status === "in_progress" ? status : "todo");

// ---------------- Inputs ----------------

/** All backlog tasks (dependencies may point outside B2). */
export function loadBacklog(root = ROOT) {
  const p = join(root, "specs", "backlog.yaml");
  const r = parseYamlFiles([p])[p];
  if (!r || "error" in r) throw new Error(`specs/backlog.yaml: ${r?.error ?? "не прочитан"}`);
  return r.ok?.tasks ?? [];
}

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** docs/progress/b2-extra.json with every list present (a missing file is an empty one). */
export function loadExtra(root = ROOT) {
  const p = join(root, "docs", "progress", "b2-extra.json");
  const raw = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  return normalizeExtra(raw);
}

export function normalizeExtra(raw = {}) {
  return {
    deploys: arr(raw.deploys),
    spend: arr(raw.spend),
    probes: arr(raw.probes),
    waitingOnFounder: arr(raw.waitingOnFounder).map(String),
    notes: arr(raw.notes).map(String),
  };
}

const git = (root, args) =>
  spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });

/** Merged B2 work on main: commits whose subject starts with «B2-NN» (claim commits are left out). */
export function readCommits(root = ROOT, { ref } = {}) {
  const refs = ref ? [ref] : ["main", "origin/main", "HEAD"];
  const found = refs.find(
    (r) => git(root, ["rev-parse", "--verify", "--quiet", `${r}^{commit}`]).status === 0,
  );
  if (!found) return [];
  const r = git(root, ["log", found, "-E", `--grep=^${MILESTONE}-[0-9]+`, "--format=%H%x1f%cI%x1f%s"]);
  if (r.status !== 0) return [];
  return parseCommits(r.stdout);
}

export function parseCommits(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const [sha, date, subject] = line.split("\x1f");
    const m = new RegExp(`^(${MILESTONE}-\\d+)\\b`).exec(subject ?? "");
    if (!m || /захват|\bclaim/i.test(subject)) continue;
    out.push({ sha, date, subject, task: m[1] });
  }
  return out;
}

// ---------------- Model ----------------

/** Everything the page and the digest show, computed once. */
export function buildModel({ tasks, extra = normalizeExtra(), commits = [], now = new Date() }) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const b2 = tasks
    .filter((t) => t.milestone === MILESTONE)
    .map((t) => {
      const deps = arr(t.deps).map((id) => ({ id, status: byId.get(id)?.status ?? "unknown" }));
      const blockedBy = deps.filter((d) => d.status !== "done").map((d) => d.id);
      const status = bucket(t.status);
      return {
        id: t.id,
        title: String(t.title ?? ""),
        owner: t.owner,
        group: t.parallel_group,
        status,
        estimate: t.estimate_days == null ? null : num(t.estimate_days),
        deps,
        blockedBy: status === "done" ? [] : blockedBy,
        ready: status === "todo" && blockedBy.length === 0,
      };
    });
  const count = (list) => ({
    total: list.length,
    done: list.filter((t) => t.status === "done").length,
    in_progress: list.filter((t) => t.status === "in_progress").length,
    todo: list.filter((t) => t.status === "todo").length,
  });
  const known = new Set(STREAMS.map((s) => s.group));
  const streams = [
    ...STREAMS,
    ...[...new Set(b2.map((t) => t.group))]
      .filter((g) => !known.has(g))
      .map((g) => ({ group: g, key: String(g), title: `Волна ${g}` })),
  ]
    .map((s) => {
      const list = b2.filter((t) => t.group === s.group);
      return { ...s, tasks: list, counts: count(list) };
    })
    .filter((s) => s.tasks.length > 0);
  const founder = (t) => t.owner === "founder";
  const next = b2.filter((t) => t.ready && !founder(t));
  const asks = extra.waitingOnFounder;
  const waiting = [
    ...b2
      .filter((t) => founder(t) && t.status !== "done" && t.blockedBy.length === 0)
      .filter((t) => !asks.some((a) => a.includes(t.id)))
      .map((t) => `${t.id}: ${t.title}`),
    ...asks,
  ];
  const spend = extra.spend
    .map((s) => {
      const row = {
        day: String(s.day ?? ""),
        client: num(s.client),
        staff: num(s.staff),
        dev: num(s.probe) + num(s.eval),
      };
      return { ...row, total: row.client + row.staff + row.dev };
    })
    .sort((a, b) => a.day.localeCompare(b.day));
  const devSpent = spend.reduce((a, s) => a + s.dev, 0);
  const remaining = b2.filter((t) => t.status !== "done").reduce((a, t) => a + (t.estimate ?? 0), 0);
  return {
    now: new Date(now),
    tasks: b2,
    counts: count(b2),
    streams,
    next,
    inProgress: b2.filter((t) => t.status === "in_progress"),
    waiting,
    commits: [...commits].sort((a, b) => String(b.date).localeCompare(String(a.date))),
    deploys: [...extra.deploys].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? ""))),
    probes: [...extra.probes].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? ""))),
    notes: extra.notes,
    spend,
    budget: { limit: BUDGET_RUB, spent: devSpent, share: devSpent / BUDGET_RUB },
    remainingDays: remaining,
  };
}

// ---------------- Formatting ----------------

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const rub = (v) => `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v)} ₽`;
const days = (v) => `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(v)} дн`;
const pct = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0);
const fmtDate = (d, withTime = false) => {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return String(d ?? "");
  const opts = { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" };
  if (withTime) Object.assign(opts, { hour: "2-digit", minute: "2-digit" });
  return new Intl.DateTimeFormat("ru-RU", opts).format(date).replace(",", "");
};
/** Russian plural: plural(5, ["задача", "задачи", "задач"]). */
const plural = (n, [one, few, many]) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
};

// ---------------- HTML ----------------

const CSS = `
:root{color-scheme:light;--page:#f6f6f3;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--muted:#6f6d68;
--line:#e1e0d9;--ring:rgba(11,11,11,.1);--todo:#dcdbd3;--progress:#2a78d6;--done:#0ca30c;--good-ink:#006300;
--warn:#fab219;--crit:#d03b3b;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--chip:#efeee9;--accent-ink:#1c5cab}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;
--ink:#fff;--ink-2:#c3c2b7;--muted:#9a988f;--line:#2c2c2a;--ring:rgba(255,255,255,.1);--todo:#383835;--progress:#3987e5;
--done:#0ca30c;--good-ink:#0ca30c;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--chip:#262624;--accent-ink:#86b6ef}}
:root[data-theme="dark"]{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink-2:#c3c2b7;--muted:#9a988f;
--line:#2c2c2a;--ring:rgba(255,255,255,.1);--todo:#383835;--progress:#3987e5;--done:#0ca30c;--good-ink:#0ca30c;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--chip:#262624;--accent-ink:#86b6ef}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:30px;line-height:1.15;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:19px;margin:0 0 12px}
h3{font-size:16px;margin:0}
p{margin:0}
.lead{color:var(--ink-2)}
.meta{color:var(--muted);font-size:13px;margin-top:6px}
section{margin-top:28px}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:14px;padding:16px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:20px}
.tile .label{color:var(--ink-2);font-size:13px}
.tile .value{font-size:26px;font-weight:600;line-height:1.2;margin-top:4px}
.tile .sub{color:var(--muted);font-size:13px;margin-top:2px}
.bar{display:flex;gap:2px;height:10px;border-radius:5px;overflow:hidden;background:var(--surface);margin:10px 0 6px}
.bar span{display:block;height:100%}
.bar span:first-child{border-radius:5px 0 0 5px}.bar span:last-child{border-radius:0 5px 5px 0}
.bar span:only-child{border-radius:5px}
.s-done{background:var(--done)}.s-in_progress{background:var(--progress)}.s-todo{background:var(--todo)}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;color:var(--ink-2);font-size:13px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.streams{display:grid;gap:12px}
.stream-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;align-items:baseline}
.stream-head .count{color:var(--ink-2);font-size:13px}
ul.tasks{list-style:none;margin:8px 0 0;padding:0}
ul.tasks li{display:grid;grid-template-columns:64px 1fr auto;gap:2px 12px;padding:10px 0;border-top:1px solid var(--line)}
.id{font-variant-numeric:tabular-nums;font-weight:600;color:var(--accent-ink)}
.title{min-width:0;overflow-wrap:anywhere}
.side{text-align:right;white-space:nowrap}
.deps{grid-column:2/4;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.deps .ok{color:var(--good-ink)}
.deps .wait{color:var(--ink-2)}
.pill{display:inline-block;font-size:12px;line-height:1;padding:5px 8px;border-radius:999px;background:var(--chip);color:var(--ink-2)}
.pill.done{color:var(--good-ink)}.pill.in_progress{color:var(--accent-ink)}
.pill i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:1px}
.est{display:block;color:var(--muted);font-size:12px;margin-top:4px}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
ul.plain{margin:0;padding-left:18px}
ul.plain li{margin:4px 0;overflow-wrap:anywhere}
.empty{color:var(--muted)}
ul.days{list-style:none;margin:8px 0 0;padding:0}
li.day{padding:10px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}
li.day:first-child{border-top:none}
.day-head{display:flex;justify-content:space-between;gap:12px}
.n{font-variant-numeric:tabular-nums;white-space:nowrap}
.day-split{color:var(--muted);font-size:13px;margin-top:4px}
.mini{display:flex;gap:2px;height:8px;margin-top:6px}
.mini span{display:block;height:100%;border-radius:2px}
.c-client{background:var(--s1)}.c-staff{background:var(--s2)}.c-dev{background:var(--s3)}
.meter{height:12px;border-radius:6px;background:var(--todo);overflow:hidden;margin:10px 0 6px;position:relative}
.meter span{display:block;height:100%;border-radius:6px}
.meter .mark{position:absolute;top:0;bottom:0;width:2px;background:var(--surface)}
.m-ok{background:var(--s1)}.m-warn{background:var(--warn)}.m-crit{background:var(--crit)}
.flag{font-size:13px;margin-top:6px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
@media (max-width:520px){h1{font-size:26px}ul.tasks li{grid-template-columns:56px 1fr}.side{grid-column:2;text-align:left}
.deps{grid-column:2}.tile .value{font-size:22px}}
`;

function bar(counts, label) {
  const parts = ["done", "in_progress", "todo"]
    .filter((k) => counts[k] > 0)
    .map(
      (k) =>
        `<span class="s-${k}" style="flex:${counts[k]}" title="${esc(STATUS_LABEL[k])}: ${counts[k]}"></span>`,
    );
  return `<div class="bar" role="img" aria-label="${esc(label)}">${parts.join("")}</div>`;
}

const legend = (counts) =>
  `<div class="legend">${["done", "in_progress", "todo"]
    .map((k) => `<span><i class="s-${k}"></i>${STATUS_LABEL[k]}: ${counts[k]}</span>`)
    .join("")}</div>`;

function taskRow(t) {
  const deps = t.deps.length
    ? `<div class="deps">Зависит от: ${t.deps
        .map(
          (d) =>
            `<span class="${d.status === "done" ? "ok" : "wait"}">${esc(d.id)}${d.status === "done" ? " ✓" : ""}</span>`,
        )
        .join(", ")}</div>`
    : "";
  const label = t.status === "todo" && t.blockedBy.length ? "заблокирована" : STATUS_LABEL[t.status];
  return `<li data-id="${esc(t.id)}" data-status="${esc(t.status)}"${t.blockedBy.length ? ' data-blocked="1"' : ""}>
<span class="id">${esc(t.id)}</span><span class="title">${esc(t.title)}${t.owner === "founder" ? ' <span class="pill">основатель</span>' : ""}</span>
<span class="side"><span class="pill ${esc(t.status)}"><i class="s-${esc(t.status)}"></i>${esc(label)}</span>${t.estimate == null ? "" : `<span class="est">${esc(days(t.estimate))}</span>`}</span>${deps}</li>`;
}

const list = (items, empty) =>
  items.length ? `<ul class="plain">${items.join("")}</ul>` : `<p class="empty">${esc(empty)}</p>`;

function spendSection(m) {
  const { budget } = m;
  const share = Math.min(budget.share, 1);
  const level = budget.share >= 1 ? "crit" : budget.share >= ALERT_SHARE ? "warn" : "ok";
  const flag =
    level === "crit"
      ? "⛔ Бюджет исчерпан"
      : level === "warn"
        ? `⚠ Потрачено больше ${Math.round(ALERT_SHARE * 100)}% — алерт основателю`
        : `Алерт на ${Math.round(ALERT_SHARE * 100)}%`;
  const max = Math.max(0, ...m.spend.map((s) => s.total));
  const parts = [
    ["c-client", "client", "клиенты"],
    ["c-staff", "staff", "staff"],
    ["c-dev", "dev", "пробы и замер"],
  ];
  // One row per day: the total, a stacked bar on a shared scale, and the split in words (the values, not only colour).
  const rows = m.spend
    .map((s) => {
      const segs = parts
        .filter(([, k]) => s[k] > 0)
        .map(
          ([cls, k, name]) =>
            `<span class="${cls}" style="width:${((s[k] / max) * 100).toFixed(2)}%" title="${name}: ${esc(rub(s[k]))}"></span>`,
        )
        .join("");
      const split = parts.map(([, k, name]) => `${name} ${rub(s[k])}`).join(" · ");
      return `<li class="day"><div class="day-head"><span>${esc(fmtDate(s.day))}</span><span class="n">${esc(rub(s.total))}</span></div>
<div class="mini" role="img" aria-label="${esc(`${fmtDate(s.day)}: ${split}`)}">${segs}</div><div class="day-split">${esc(split)}</div></li>`;
    })
    .join("");
  const table = m.spend.length
    ? `<div class="legend" style="margin-top:14px">${parts.map(([cls, , name]) => `<span><i class="${cls}"></i>${name}</span>`).join("")}</div>
<ul class="days">${rows}</ul>`
    : `<p class="empty" style="margin-top:12px">Расходов пока нет.</p>`;
  return `<section id="spend"><h2>Расход на модели</h2><div class="card">
<h3>Бюджет разработки B2: ${esc(rub(budget.spent))} из ${esc(rub(budget.limit))}</h3>
<div class="meter" role="img" aria-label="Потрачено ${pct(budget.spent, budget.limit)}% бюджета"><span class="m-${level}" style="width:${(share * 100).toFixed(2)}%"></span><span class="mark" style="left:${ALERT_SHARE * 100}%"></span></div>
<p class="flag">${esc(flag)}. Считаются пробы и замер (решение 18).</p>${table}</div></section>`;
}

/** The whole page as one HTML string. */
export function renderHtml(m) {
  const c = m.counts;
  const streams = m.streams
    .map(
      (
        s,
      ) => `<article class="card stream" data-stream="${esc(s.key)}"><div class="stream-head"><h3>${esc(s.title)}</h3>
<span class="count">${s.counts.done} из ${s.counts.total} готово · ${pct(s.counts.done, s.counts.total)}%</span></div>
${bar(s.counts, `${s.title}: готово ${s.counts.done}, в работе ${s.counts.in_progress}, не начато ${s.counts.todo}`)}${legend(s.counts)}
<ul class="tasks">${s.tasks.map(taskRow).join("")}</ul></article>`,
    )
    .join("");
  const next = list(
    m.next.map((t) => `<li><span class="id">${esc(t.id)}</span> ${esc(t.title)}</li>`),
    "Свободных задач нет: всё ждёт зависимостей или уже в работе.",
  );
  const waiting = list(
    m.waiting.map((w) => `<li>${esc(w)}</li>`),
    "Сейчас ничего не нужно.",
  );
  const merged = list(
    m.commits
      .slice(0, 30)
      .map(
        (x) =>
          `<li>${esc(fmtDate(x.date))} · <code>${esc(String(x.sha).slice(0, 7))}</code> ${esc(x.subject)}</li>`,
      ),
    "Пока ничего не влито.",
  );
  const deploys = list(
    m.deploys.map(
      (d) =>
        `<li>${esc(fmtDate(d.date))} · <code>${esc(String(d.sha ?? "").slice(0, 7))}</code> ${esc(d.note ?? "")}</li>`,
    ),
    "Выкатов беты v2 ещё не было.",
  );
  const probes = m.probes.length
    ? `<ul class="days">${m.probes
        .map(
          (p) =>
            `<li class="day"><div class="day-head"><strong>${esc(p.name)}</strong><span class="n">${p.costRub == null ? "" : esc(rub(num(p.costRub)))}</span></div><div>${esc(p.result)}</div><div class="day-split">${esc(fmtDate(p.date))}</div></li>`,
        )
        .join("")}</ul>`
    : `<p class="empty">Проб ещё не было: первая — после зелёного CI этапа.</p>`;
  const notes = m.notes.length
    ? `<section><h2>Заметки</h2><div class="card">${list(
        m.notes.map((n) => `<li>${esc(n)}</li>`),
        "",
      )}</div></section>`
    : "";
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Бета v2 — ход работ</title>
<meta name="description" content="Этапы и задачи беты v2, влитое и выкаченное, расход на модели, пробы и что ждём от основателя.">
<style>${CSS}</style>
</head>
<body>
<main>
<header>
<h1>Бета v2</h1>
<p class="lead">Ход работ: модули, план по целям, дизайн-система. План — docs/plans/2026-10-06-beta-v2.md.</p>
<p class="meta">Обновлено ${esc(fmtDate(m.now, true))} МСК · данные из specs/backlog.yaml и истории main</p>
</header>
<div class="tiles">
<div class="card tile"><div class="label">Готово</div><div class="value">${c.done} из ${c.total}</div><div class="sub">${pct(c.done, c.total)}% задач</div></div>
<div class="card tile"><div class="label">В работе</div><div class="value">${c.in_progress}</div><div class="sub">${m.next.length} ${plural(m.next.length, ["задача свободна", "задачи свободны", "задач свободно"])}</div></div>
<div class="card tile"><div class="label">Осталось по оценке</div><div class="value">${esc(days(m.remainingDays))}</div><div class="sub">агенто-дней</div></div>
<div class="card tile"><div class="label">Бюджет B2</div><div class="value">${esc(rub(m.budget.spent))}</div><div class="sub">из ${esc(rub(m.budget.limit))} · ${pct(m.budget.spent, m.budget.limit)}%</div></div>
</div>
<div class="card" style="margin-top:12px">${bar(c, `Всего: готово ${c.done}, в работе ${c.in_progress}, не начато ${c.todo}`)}${legend(c)}</div>
<section class="two">
<div class="card" id="next"><h2>Что дальше</h2>${next}</div>
<div class="card" id="founder"><h2>Ждём от основателя</h2>${waiting}</div>
</section>
<section id="streams"><h2>Потоки и задачи</h2><div class="streams">${streams}</div></section>
<section class="two">
<div class="card" id="merged"><h2>Влито в main</h2>${merged}</div>
<div class="card" id="deploys"><h2>Выкачено</h2>${deploys}</div>
</section>
${spendSection(m)}
<section id="probes"><h2>Пробы и замер</h2><div class="card">${probes}</div></section>
${notes}
</main>
</body>
</html>
`;
}

// ---------------- Digest ----------------

const short = (items, max) =>
  items.length > max ? `${items.slice(0, max).join(", ")} и ещё ${items.length - max}` : items.join(", ");
const clip = (s, max = 300) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** 3–5 plain-text lines for Telegram (no personal data: task ids, counts and ₽ only). */
export function renderDigest(m, { pageUrl = "" } = {}) {
  const c = m.counts;
  const since = m.now.getTime() - DAY_MS;
  const fresh = [
    ...new Set(m.commits.filter((x) => new Date(x.date).getTime() >= since).map((x) => x.task)),
  ].sort();
  const lines = [
    `Бета v2 на ${fmtDate(m.now)}: готово ${c.done} из ${c.total}, в работе ${c.in_progress}; бюджет моделей ${rub(m.budget.spent)} из ${rub(m.budget.limit)}.`,
    fresh.length ? `За сутки влито: ${short(fresh, 8)}.` : "За сутки ничего не влито.",
  ];
  if (m.inProgress.length)
    lines.push(
      `В работе: ${short(
        m.inProgress.map((t) => t.id),
        8,
      )}.`,
    );
  else if (m.next.length)
    lines.push(
      `Дальше: ${short(
        m.next.map((t) => t.id),
        8,
      )}.`,
    );
  if (m.waiting.length) lines.push(clip(`Ждём от основателя: ${m.waiting.join("; ")}.`));
  if (pageUrl) lines.push(`Подробно: ${pageUrl}`);
  return lines.slice(0, 5).join("\n");
}

/** Posts the digest to the alert chat. Without the bot or chat it warns and succeeds (returns false). */
export async function sendTelegram(text, env = process.env, { fetch: f = fetch, base = TELEGRAM_API } = {}) {
  const token = env.WIZARD_OPS_ALERT_TELEGRAM_TOKEN;
  const chat = env.WIZARD_OPS_ALERT_CHAT_ID;
  if (!token || !chat) {
    console.log(
      "::warning::Сводка не отправлена: нет секретов WIZARD_OPS_ALERT_TELEGRAM_TOKEN и WIZARD_OPS_ALERT_CHAT_ID",
    );
    return false;
  }
  const res = await f(`${base}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok)
    throw new Error(
      `Telegram не принял сводку: HTTP ${res.status} ${String(body.description ?? "").slice(0, 120)}`,
    );
  return true;
}

// ---------------- CLI ----------------

function parseArgs(argv) {
  const o = { send: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--html") o.html = argv[++i];
    else if (a === "--digest") o.digest = true;
    else if (a === "--send") o.send = true;
    else if (a === "--root") o.root = argv[++i];
    else if (a === "--ref") o.ref = argv[++i];
    else throw new Error(`Неизвестный аргумент: ${a}`);
  }
  if (argv.includes("--html") && !o.html) throw new Error("--html: укажите файл");
  if (!o.html && !o.digest) throw new Error("Нужен --html <файл> или --digest [--send]");
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const root = resolve(o.root ?? ROOT);
  const model = buildModel({
    tasks: loadBacklog(root),
    extra: loadExtra(root),
    commits: readCommits(root, { ref: o.ref }),
    now: new Date(),
  });
  if (o.html) {
    writeFileSync(resolve(o.html), renderHtml(model));
    console.log(`Страница «Бета v2»: ${resolve(o.html)}`);
  }
  if (o.digest) {
    const text = renderDigest(model, { pageUrl: process.env.B2_PAGE_URL ?? "" });
    console.log(text);
    if (o.send && (await sendTelegram(text))) console.log("Сводка отправлена в Telegram.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
