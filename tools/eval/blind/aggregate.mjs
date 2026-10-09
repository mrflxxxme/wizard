// V3-40: the sum of the raters' answers of the blind comparison (docs/plans/2026-10-08-v3.md §6 (2)–(3)): the share of
// the Wizard–competitor pairs Wizard won (the majority of the raters of a pair chose the Wizard site; ≥ 70 %), the
// number of raters (the founder and 3–5 independent ones), the «one template» complaints — of two Wizard sites of one
// class (must be none), of two competitor sites and across the sources (for reference).
import { VOTES_KIND, VOTES_VERSION } from "./page.mjs";

/** §6: Wizard wins ≥ 70 % of the pairs; the founder and at least 3 raters. */
export const BLIND_TARGETS = { wizardShare: 0.7, minRaters: 4 };

const CLASS_RU = { site: "сайт бизнеса", booking: "услуги и запись", crm: "CRM и админка", shop: "магазин" };
const pct = (x) => (x === null ? "—" : `${Math.round(x * 100)} %`);

/** Problems of one votes file against the key (Russian; [] — fine). */
export function votesProblems(v, key) {
  const out = [];
  if (!v || typeof v !== "object") return ["не JSON-объект"];
  if (v.kind !== VOTES_KIND || v.version !== VOTES_VERSION) out.push("не файл ответов слепого сравнения");
  if (v.layoutId !== key.layoutId) out.push(`ответы к другой странице (${v.layoutId ?? "—"} ≠ ${key.layoutId})`);
  if (typeof v.rater !== "string" || !v.rater.trim()) out.push("не указан оценщик");
  if (!Array.isArray(v.votes)) out.push("нет ответов");
  return out;
}

/**
 * The summary of the answers: `key` — the key of layout.mjs, `files` — [{name, data}] of the downloaded answers (a
 * rater counted once: the latest file by savedAt; files of another page are skipped with a warning).
 */
export function aggregateVotes(key, files) {
  const warnings = [];
  const raters = new Map();
  for (const f of files) {
    const problems = votesProblems(f.data, key);
    if (problems.length) {
      warnings.push(`${f.name}: ${problems.join("; ")} — пропущен`);
      continue;
    }
    const name = f.data.rater.trim();
    const id = name.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
    const prev = raters.get(id);
    if (prev) {
      warnings.push(`оценщик «${name}» прислал несколько файлов — взят последний`);
      if (String(prev.savedAt ?? "") > String(f.data.savedAt ?? "")) continue;
    }
    raters.set(id, { name, savedAt: f.data.savedAt ?? null, votes: f.data.votes });
  }
  const byPair = new Map(key.pairs.map((p) => [p.id, p]));
  const tally = new Map(key.pairs.map((p) => [p.id, { A: 0, B: 0, same: 0, template: [], comments: [] }]));
  for (const r of raters.values())
    for (const v of r.votes) {
      const t = tally.get(v?.pair);
      if (!t) continue;
      if (v.better === "A" || v.better === "B" || v.better === "same") t[v.better] += 1;
      if (v.sameTemplate === true) t.template.push(r.name);
      if (typeof v.comment === "string" && v.comment.trim()) t.comments.push(`${r.name}: ${v.comment.trim().slice(0, 300)}`);
    }

  const wc = key.pairs.filter((p) => p.kind === "wc");
  const votes = { wizard: 0, competitor: 0, same: 0 };
  const results = [];
  for (const p of wc) {
    const t = tally.get(p.id);
    const wizSide = p.A.source === "wizard" ? "A" : "B";
    const comSide = wizSide === "A" ? "B" : "A";
    votes.wizard += t[wizSide];
    votes.competitor += t[comSide];
    votes.same += t.same;
    const voted = t.A + t.B + t.same;
    const winner =
      voted === 0 ? null : t[wizSide] > t[comSide] ? "wizard" : t[comSide] > t[wizSide] ? "competitor" : "tie";
    results.push({
      pair: p.id,
      class: p.class,
      briefId: p[wizSide].briefId,
      service: p[comSide].service,
      wizard: t[wizSide],
      competitor: t[comSide],
      same: t.same,
      winner,
      comments: t.comments,
    });
  }
  const voted = results.filter((r) => r.winner !== null);
  const wins = voted.filter((r) => r.winner === "wizard").length;
  const share = voted.length ? wins / voted.length : null;
  const perClass = {};
  for (const r of results) {
    const c = (perClass[r.class] ??= { wins: 0, of: 0 });
    if (r.winner !== null) c.of += 1;
    if (r.winner === "wizard") c.wins += 1;
  }
  const complaints = (kind) =>
    key.pairs
      .filter((p) => p.kind === kind && tally.get(p.id).template.length > 0)
      .map((p) => ({
        pair: p.id,
        class: p.class,
        briefs: [p.A.briefId, p.B.briefId],
        raters: tally.get(p.id).template,
      }));
  const template = { ww: complaints("ww"), cc: complaints("cc"), wc: complaints("wc") };
  const ratersCount = raters.size;
  const enoughRaters = ratersCount >= BLIND_TARGETS.minRaters;
  const services = [...new Set(wc.map((p) => (p.A.source === "competitor" ? p.A : p.B).service))].sort();
  return {
    kind: "wizard-blind-summary",
    layoutId: key.layoutId,
    seed: key.seed,
    raters: [...raters.values()].map((r) => r.name).sort((a, b) => a.localeCompare(b, "ru")),
    ratersCount,
    enoughRaters,
    services,
    wc: {
      pairs: wc.length,
      voted: voted.length,
      wizardWins: wins,
      competitorWins: voted.filter((r) => r.winner === "competitor").length,
      ties: voted.filter((r) => r.winner === "tie").length,
      share: share === null ? null : Math.round(share * 1000) / 1000,
      votes,
      results,
    },
    perClass,
    template,
    passed: {
      blind: ratersCount === 0 || share === null ? null : enoughRaters && share >= BLIND_TARGETS.wizardShare,
      template: ratersCount === 0 ? null : template.ww.length === 0,
    },
    warnings,
  };
}

/** The summary in Markdown for the console and the final report (Russian). */
export function blindLines(s) {
  const L = [];
  L.push(
    `- Оценщиков: ${s.ratersCount} (${s.raters.join(", ") || "—"}); нужно не меньше ${BLIND_TARGETS.minRaters} — основатель и 3–5 независимых ${s.enoughRaters ? "✅" : "❌"}.`,
    `- Конкурент: ${s.services.join(", ") || "—"}. Пар Wizard — конкурент: ${s.wc.pairs}, с ответами: ${s.wc.voted}.`,
    `- Wizard выиграл ${s.wc.wizardWins} из ${s.wc.voted} пар (${pct(s.wc.share)}; цель ≥ ${pct(BLIND_TARGETS.wizardShare)}) ${s.passed.blind === null ? "—" : s.passed.blind ? "✅" : "❌"}; конкурент — ${s.wc.competitorWins}, ничьих — ${s.wc.ties}. Голоса: за Wizard ${s.wc.votes.wizard}, за конкурента ${s.wc.votes.competitor}, «одинаково» ${s.wc.votes.same}.`,
    `- «Один шаблон» у двух сайтов Wizard: ${s.template.ww.length === 0 ? "ни одной жалобы ✅" : `${s.template.ww.length} пар ❌`}; у двух сайтов конкурента — ${s.template.cc.length}; Wizard и конкурент как один шаблон — ${s.template.wc.length}.`,
  );
  const classes = Object.entries(s.perClass);
  if (classes.length)
    L.push(
      `- По классам: ${classes.map(([c, x]) => `${CLASS_RU[c] ?? c} — ${x.wins} из ${x.of}`).join("; ")}.`,
    );
  for (const c of s.template.ww)
    L.push(`  - один шаблон: ${c.briefs.join(" и ")} (${CLASS_RU[c.class] ?? c.class}) — ${c.raters.join(", ")}`);
  const lost = s.wc.results.filter((r) => r.winner === "competitor");
  if (lost.length)
    L.push(
      `- Проиграны: ${lost.map((r) => `${r.briefId} (${r.wizard}:${r.competitor}${r.same ? `, одинаково ${r.same}` : ""})`).join("; ")}.`,
    );
  for (const w of s.warnings) L.push(`- Внимание: ${w}.`);
  return L;
}
