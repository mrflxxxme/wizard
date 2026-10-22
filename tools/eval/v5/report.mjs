// V5-02: the report of a run — summary JSON, a markdown digest and the ribbon of pairs for the founder (HTML).
// The ribbon is for the founder only: it opens the key (which side is Wizard) after the verdicts; judges never get it.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { TARGET_SHARE, WIDTHS } from "./lib.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)} %`);
const RESULT = { not_worse: "не хуже эталона", worse: "хуже эталона", no_snapshot: "снимок не получен", skipped_by_cap: "пропущена (потолок трат)", no_verdict: "судьи не ответили" };

export function renderMarkdown(s, pairs) {
  const lines = [
    `# Стенд оценки V5 — ${s.set === "slice" ? "срез" : "полный набор"} (${s.mode}, seed ${s.seed})`,
    "",
    s.warning ? `> ${s.warning}` : "",
    `- Доля пар «не хуже эталона»: **${pct(s.share)}** (${s.notWorse} из ${s.judged} оценённых; цель ${pct(TARGET_SHARE)} — замер, не условие)`,
    `- Стоимость прогона: **${s.costRub} ₽**${s.stoppedByCap ? " (остановлен потолком трат)" : ""}`,
    `- Судьи: ${s.perJudge.map((j) => `${j.model} — не хуже в ${j.notWorse} из ${j.answered}`).join("; ")}`,
    s.noSnapshot.length ? `- Снимок не получен: ${s.noSnapshot.map((n) => `${n.brief} (${n.missing.join(", ")})`).join("; ")}` : "",
    "",
    "| Бриф | Эталон | Итог | Голоса судей |",
    "|---|---|---|---|",
    ...pairs.map((p) => `| ${p.briefId} | ${p.refId} | ${RESULT[p.result]} | ${p.verdicts.map((v) => `${v.model}: ${v.pick ?? "—"}`).join(", ") || "—"} |`),
  ];
  return `${lines.filter((l, i) => l !== "" || lines[i - 1] !== "").join("\n")}\n`;
}

/** Copies the snapshots next to the page and writes index.html: one row per pair, Wizard and reference labelled. */
export function writeRibbon(dir, s, pairs) {
  mkdirSync(join(dir, "img"), { recursive: true });
  const img = (pair, side, w) => {
    const shot = pair.sides[side][w];
    if (!shot) return `<div class="miss">снимок не получен</div>`;
    const name = `${pair.id}-${side}-${w}${shot.path ? extname(shot.path) : ".png"}`;
    writeFileSync(join(dir, "img", name), Buffer.from(shot.data, "base64"));
    return `<img src="img/${name}" alt="${side} ${w}" loading="lazy">`;
  };
  const rows = pairs
    .map(
      (p) => `<section class="pair ${p.result}">
<h2>${esc(p.title)} <small>${esc(p.briefId)} · ${RESULT[p.result]}</small></h2>
<p class="brief">${esc(p.brief)}</p>
<div class="cols">${["wizard", "ref"]
        .map(
          (side) => `<figure><figcaption>${side === "wizard" ? "Wizard" : `Эталон (${esc(p.refId)})`}</figcaption>${WIDTHS.map((w) => img(p, side, w)).join("")}</figure>`,
        )
        .join("")}</div>
<ul>${p.verdicts.map((v) => `<li><b>${esc(v.model)}</b>: ${v.pick ? { wizard: "Wizard", ref: "эталон", tie: "ничья" }[v.pick] : esc(v.error ?? "нет ответа")} — ${esc(v.reason)}</li>`).join("")}</ul>
</section>`,
    )
    .join("\n");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Лента пар V5</title>
<style>:root{color-scheme:light dark;--bg:#fff;--fg:#14171f;--line:#d5d9e2}@media (prefers-color-scheme:dark){:root{--bg:#14171f;--fg:#eef0f5;--line:#333a4a}}body{margin:0 auto;padding:16px;max-width:1500px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}.pair{border-top:1px solid var(--line);padding:16px 0}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0}figcaption{font-weight:600}img{max-width:100%;border:1px solid var(--line);margin:4px 0;display:block}.miss{padding:24px;border:1px dashed var(--line)}.worse h2{color:#b3261e}.not_worse h2{color:#1b7f3b}small{font-weight:400;opacity:.7}@media (max-width:700px){.cols{grid-template-columns:1fr}}</style></head><body>
<h1>Лента пар V5</h1><p>Доля «не хуже эталона»: <b>${pct(s.share)}</b> (${s.notWorse} из ${s.judged}). Стоимость: <b>${s.costRub} ₽</b>. Режим: ${esc(s.mode)}, seed ${esc(s.seed)}.${s.warning ? ` <i>${esc(s.warning)}</i>` : ""}</p>
${rows}</body></html>`;
  writeFileSync(join(dir, "index.html"), html);
}

export function writeReport(dir, s, pairs) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify({ ...s, results: pairs.map((p) => ({ pair: p.id, brief: p.briefId, ref: p.refId, key: p.key, result: p.result, verdicts: p.verdicts })) }, null, 2)}\n`);
  writeFileSync(join(dir, "report.md"), renderMarkdown(s, pairs));
  writeRibbon(dir, s, pairs);
}
