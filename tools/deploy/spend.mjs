#!/usr/bin/env node
// V3-01 (product.yaml#decisions.D77_v3 (18б), docs/plans/2026-10-08-v3.md §4–5): the spend journal of the v3
// development, docs/progress/v3-spend.json — the plan by waves (12 000 ₽ in all) and one entry per paid run. A paid run
// (eval, a probe of a stage, an end-to-end build) does not start without its pre-registration: purpose, hypothesis,
// expected ₽ and the cap (preregister); the cap stops the run (capGuard); more than 1 000 ₽ at once or a run that may
// take its wave over the plan needs the founder's «да» (founder_ok=yes). `pilot.mjs eval` checks all that before the
// run and prints «потрачено X ₽ из плана Y ₽ волны …» into the report, the annotations and the issue comment, with the
// entry ready for the journal; the orchestrator keeps the journal with this tool:
//   node tools/deploy/spend.mjs register --wave A --purpose … --hypothesis … --expect-rub 30 --cap-rub 50
//        [--founder-ok yes] [--actual-rub 27.5] [--result …] [--run-id …] [--date 2026-10-08]
//   node tools/deploy/spend.mjs register --entry spend-entry.json   (or the JSON itself: «Запись для журнала» of the
//        measurement report; the file is next to the report in the artifact)
//   node tools/deploy/spend.mjs close --id v3-003 --actual-rub 27.5 [--result …] [--run-id …]
//   node tools/deploy/spend.mjs summary [--wave A]
// Option --file <journal> (default: docs/progress/v3-spend.json of this repository).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const JOURNAL = join(ROOT, "docs", "progress", "v3-spend.json");
/** Items of the plan (§5) in report order; the measurement workflow offers the ones run on the platform. */
export const WAVES = ["A", "B", "C", "checkpoint", "final", "retry", "competitors"];
/** Waves a measurement on the platform belongs to (eval-pilot.yml input `wave`). */
export const EVAL_WAVES = ["A", "B", "C", "checkpoint", "final", "retry"];
const WAVE_NAMES = {
  checkpoint: "«Чекпоинты основателя»",
  final: "«Финальный замер»",
  retry: "«Повтор упавших брифов»",
  competitors: "«Конкуренты»",
};
/** A cap above this, ₽ at once, needs the founder's «да» (D77 (18б)). */
export const FOUNDER_OK_OVER_RUB = 1000;
/** Upper bound of one cap: the platform's monthly cap of the time of V3 (config.ts WIZARD_LLM_MONTHLY_CAP_RUB). */
export const MAX_CAP_RUB = 15000;
/** Length limit of the purpose, the hypothesis and the result (one line each). */
const TEXT_MAX = 500;

const rub = (n) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;
const num = (v) =>
  typeof v === "number"
    ? v
    : typeof v === "string" && v.trim()
      ? Number(v.trim().replace(",", "."))
      : Number.NaN;
const yes = (v) =>
  v === true ||
  ["yes", "да", "true", "1"].includes(
    String(v ?? "")
      .trim()
      .toLowerCase(),
  );
/** One line without control characters (annotations and the journal), cut to TEXT_MAX. */
export const oneLine = (v) =>
  String(v ?? "")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim()
    .slice(0, TEXT_MAX);
/** Name of a wave in Russian text: «волны A», «волны «Финальный замер»». */
export const waveName = (wave) => WAVE_NAMES[wave] ?? wave;
/** yyyy-mm-dd of `now` in Moscow (UTC+3, no DST). */
export const moscowDate = (now) => new Date(now.getTime() + 3 * 3600_000).toISOString().slice(0, 10);

/** Σ actual ₽ of the closed entries of a wave (all waves when `wave` is null). */
export function spentRub(journal, wave = null) {
  return (journal?.entries ?? [])
    .filter((e) => wave === null || e.wave === wave)
    .reduce((s, e) => s + (Number.isFinite(e.actualRub) ? e.actualRub : 0), 0);
}

/** What a wave may already have taken: the actual ₽ of closed entries, the cap of the open ones. */
export function committedRub(journal, wave) {
  return (journal?.entries ?? [])
    .filter((e) => e.wave === wave)
    .reduce((s, e) => s + (Number.isFinite(e.actualRub) ? e.actualRub : e.capRub), 0);
}

/**
 * The pre-registration of a paid run: {wave, purpose, hypothesis, expectRub, capRub, founderOk?}, the values as they
 * come from the workflow inputs or the command line. Missing or malformed fields, a cap over 1 000 ₽ or (with the
 * journal) over the wave plan without founder_ok=yes → an Error in Russian naming every problem; the run must not
 * start. Returns the normalised fields of the entry.
 */
export function preregister(input, journal = null) {
  const problems = [];
  const purpose = oneLine(input.purpose);
  const hypothesis = oneLine(input.hypothesis);
  const wave = String(input.wave ?? "").trim();
  const expectRub = num(input.expectRub);
  const capRub = num(input.capRub);
  const founderOk = yes(input.founderOk);
  if (!purpose) problems.push("не указана цель (purpose)");
  if (!hypothesis) problems.push("не указана гипотеза (hypothesis)");
  if (!WAVES.includes(wave)) problems.push(`не выбрана волна (wave: ${WAVES.join(", ")})`);
  if (!Number.isFinite(expectRub) || expectRub < 0)
    problems.push("не указаны ожидаемые ₽ (expect_rub): число рублей от 0");
  if (!Number.isInteger(capRub) || capRub < 1 || capRub > MAX_CAP_RUB)
    problems.push(
      `не указан потолок (cap_rub): целое число рублей от 1 до ${MAX_CAP_RUB.toLocaleString("ru-RU")}`,
    );
  else if (expectRub > capRub) problems.push(`ожидаемые ${rub(expectRub)} больше потолка ${rub(capRub)}`);
  if (!problems.length && !founderOk) {
    if (capRub > FOUNDER_OK_OVER_RUB)
      problems.push(
        `потолок ${rub(capRub)} больше ${rub(FOUNDER_OK_OVER_RUB)} за раз — нужно «да» основателя (founder_ok=yes)`,
      );
    const plan = journal?.plan?.[wave];
    const taken = committedRub(journal, wave);
    if (Number.isFinite(plan) && taken + capRub > plan)
      problems.push(
        `с потолком ${rub(capRub)} волна ${waveName(wave)} может выйти за план: занято ${rub(taken)} из ${rub(plan)} — нужно «да» основателя (founder_ok=yes)`,
      );
  }
  if (problems.length)
    throw new Error(`Платный прогон не начат — нужна запись в журнале трат v3: ${problems.join("; ")}.`);
  return { wave, purpose, hypothesis, expectRub, capRub, ...(founderOk ? { founderOk: true } : {}) };
}

/** Autostop of a run: (spent ₽ so far) → the reason to stop once the cap is reached, otherwise null. */
export function capGuard(capRub) {
  return (spent) =>
    Number.isFinite(spent) && spent >= capRub
      ? `потолок прогона ${rub(capRub)} достигнут (потрачено ≈ ${rub(spent)})`
      : null;
}

/** «потрачено X ₽ из плана Y ₽ волны A», X with `extraRub` of a run not in the journal yet. */
export function waveLine(journal, wave, extraRub = 0) {
  return `потрачено ${rub(spentRub(journal, wave) + extraRub)} из плана ${rub(journal?.plan?.[wave] ?? 0)} волны ${waveName(wave)}`;
}

/** The line of every report and every message to the founder: the wave and the whole v3 budget. */
export function spendLine(journal, wave, extraRub = 0) {
  return `${waveLine(journal, wave, extraRub)}; всего по v3 — ${rub(spentRub(journal) + extraRub)} из ${rub(journal?.budgetRub ?? 0)}`;
}

/** The summary of the journal: one line per wave, the total and the open entries. */
export function summaryText(journal) {
  const open = (journal.entries ?? []).filter((e) => !Number.isFinite(e.actualRub));
  return [
    "Траты v3 (docs/progress/v3-spend.json):",
    ...WAVES.map((w) => `- ${waveLine(journal, w)}`),
    `Всего: потрачено ${rub(spentRub(journal))} из ${rub(journal.budgetRub)} бюджета v3; записей ${journal.entries.length}, открытых ${open.length}${open.length ? ` (${open.map((e) => e.id).join(", ")})` : ""}.`,
  ].join("\n");
}

/** Problems of a journal (Russian); empty — valid. */
export function journalProblems(j) {
  const p = [];
  if (!j || typeof j !== "object") return ["журнал — не объект JSON"];
  if (!(Number.isFinite(j.budgetRub) && j.budgetRub > 0)) p.push("budgetRub: нужен бюджет в рублях");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(j.since ?? "")) p.push("since: нужна дата вида 2026-10-08");
  for (const w of WAVES)
    if (!(Number.isFinite(j.plan?.[w]) && j.plan[w] >= 0)) p.push(`plan.${w}: нужен план волны в рублях`);
  if (!Array.isArray(j.entries)) return [...p, "entries: нужен список записей"];
  const ids = new Set();
  for (const [i, e] of j.entries.entries()) {
    const at = `entries[${i}]`;
    if (!/^v3-\d{3,}$/.test(e?.id ?? "") || ids.has(e.id))
      p.push(`${at}.id: нужен уникальный id вида v3-001`);
    ids.add(e?.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e?.date ?? "")) p.push(`${at}.date: нужна дата`);
    if (!WAVES.includes(e?.wave)) p.push(`${at}.wave: неизвестная волна`);
    if (!e?.purpose || !e?.hypothesis) p.push(`${at}: нужны цель и гипотеза`);
    if (!(Number.isFinite(e?.expectRub) && e.expectRub >= 0)) p.push(`${at}.expectRub: нужно число от 0`);
    if (!(Number.isInteger(e?.capRub) && e.capRub >= 1)) p.push(`${at}.capRub: нужен потолок в рублях`);
    if (e?.actualRub !== undefined && !(Number.isFinite(e.actualRub) && e.actualRub >= 0))
      p.push(`${at}.actualRub: нужно число от 0`);
  }
  return p;
}

/** The journal from `file`; a missing or invalid one is an Error in Russian (a paid run does not start then). */
export function readJournal(file = JOURNAL) {
  let j;
  try {
    j = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`журнал трат v3 не прочитан (${file}): ${e instanceof Error ? e.message : String(e)}`);
  }
  const p = journalProblems(j);
  if (p.length) throw new Error(`журнал трат v3 повреждён (${file}): ${p.join("; ")}`);
  return j;
}

export function writeJournal(file, j) {
  writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
}

/** Optional outcome fields of an entry: actualRub ≥ 0, result and runId as one line each. */
function outcome(input) {
  const out = {};
  if (input.actualRub !== undefined && input.actualRub !== "") {
    const a = num(input.actualRub);
    if (!(Number.isFinite(a) && a >= 0))
      throw new Error("actual_rub: нужен фактический расход в рублях (от 0)");
    out.actualRub = Math.round(a * 100) / 100;
  }
  if (oneLine(input.result)) out.result = oneLine(input.result);
  if (oneLine(input.runId)) out.runId = oneLine(input.runId);
  return out;
}

/** A new entry v3-NNN (pre-registered, optionally with its outcome) → {journal, entry}; the input journal is kept. */
export function register(journal, input, { now = () => new Date() } = {}) {
  const fields = preregister(input, journal);
  const n = Math.max(0, ...journal.entries.map((e) => Number(e.id.slice(3)) || 0)) + 1;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date ?? "") ? input.date : moscowDate(now());
  const entry = { id: `v3-${String(n).padStart(3, "0")}`, date, ...fields, ...outcome(input) };
  return { journal: { ...journal, entries: [...journal.entries, entry] }, entry };
}

/** The outcome of a run → {journal, entry}: actualRub (required), result, runId. */
export function close(journal, input) {
  const i = journal.entries.findIndex((e) => e.id === input.id);
  if (i < 0) throw new Error(`нет записи ${input.id ?? "(без --id)"} в журнале трат v3`);
  const o = outcome(input);
  if (o.actualRub === undefined) throw new Error("close: нужен --actual-rub — фактический расход прогона");
  const entry = { ...journal.entries[i], ...o };
  const entries = journal.entries.map((e, k) => (k === i ? entry : e));
  return { journal: { ...journal, entries }, entry };
}

const FLAGS = {
  "--file": "file",
  "--wave": "wave",
  "--purpose": "purpose",
  "--hypothesis": "hypothesis",
  "--expect-rub": "expectRub",
  "--cap-rub": "capRub",
  "--founder-ok": "founderOk",
  "--actual-rub": "actualRub",
  "--result": "result",
  "--run-id": "runId",
  "--date": "date",
  "--id": "id",
  "--entry": "entry",
};

export function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  if (!["register", "close", "summary"].includes(command))
    throw new Error("команда: register | close | summary");
  const o = { command };
  for (let i = 0; i < rest.length; i++) {
    const key = FLAGS[rest[i]];
    if (!key) throw new Error(`неизвестный аргумент ${rest[i]}`);
    o[key] = rest[++i] ?? "";
  }
  if (o.entry !== undefined) {
    let e;
    try {
      e = JSON.parse(o.entry.trim().startsWith("{") ? o.entry : readFileSync(o.entry, "utf8"));
    } catch {
      throw new Error("--entry: нужна запись JSON из отчёта замера или путь к spend-entry.json");
    }
    const { entry: _, ...flags } = o;
    return { ...e, ...flags };
  }
  return o;
}

export function main(argv = process.argv.slice(2), { log = (s) => console.log(s), now } = {}) {
  const o = parseArgs(argv);
  const file = o.file || JOURNAL;
  const journal = readJournal(file);
  if (o.command === "summary") {
    if (o.wave) {
      if (!WAVES.includes(o.wave)) throw new Error(`--wave: ${WAVES.join(" | ")}`);
      log(spendLine(journal, o.wave));
    } else log(summaryText(journal));
    return 0;
  }
  const r = o.command === "register" ? register(journal, o, now ? { now } : {}) : close(journal, o);
  writeJournal(file, r.journal);
  log(
    `${r.entry.id}: ${o.command === "register" ? "записано" : "закрыто"} — ${spendLine(r.journal, r.entry.wave)}`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
