// V5-02 (grill-12 (5), D80 (1)): the stand that compares Wizard's site with a reference on the same brief — 10 briefs,
// pairs of first-screen snapshots (1440 and 390 px), three vision judges who never learn which side is the reference.
// Pure functions: no network, the judges come in from outside (fixture stub or tools/eval/v5/live-judge.ts).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const V5_DIR = join(ROOT, "tools", "eval", "v5");
/** Snapshots of the references (poehali.dev) taken by shoot-refs.mjs; <id>/{1440,390}.png. */
export const REFS_DIR = join(ROOT, "tools", "fixtures", "eval", "v5", "refs");
export const WIDTHS = [1440, 390];
/** Judges (D80 (1): 3 models of three families, vision, allowlist of models.yaml); checked against the registry in tests. */
export const JUDGES = ["glm-5v-turbo", "kimi-k3", "qwen3.6-35b"];
/** The spend ceilings, ₽ (grill-12 (3)): 5 000 for the wave, 1 500 for this workflow. */
export const WORKFLOW_CAP_RUB = 1500;
export const DEFAULT_SEED = "v5-02";
/** Default spend cap of one live run: the full set of 10 pairs × 3 judges costs far less than the ceiling. */
export const DEFAULT_CAP_RUB = 300;
/** Share of «not worse than the reference» pairs the founder aims at (D80 (1)); a measurement, not a condition (D81 (1)). */
export const TARGET_SHARE = 0.4;

export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export const loadBriefs = () => readJson(join(V5_DIR, "briefs.json")).briefs;
export const loadRefs = () => readJson(join(V5_DIR, "references.json")).refs;

/** Brief ids of the run: the full 10 or the slice of 3 for a PR. */
export function selectBriefs(set = "full", briefs = loadBriefs()) {
  if (set === "full") return briefs;
  if (set === "slice") return briefs.filter((b) => b.slice);
  throw new Error(`набор: full | slice (получено ${set})`);
}

/** Deterministic PRNG from a text seed (sha256 → mulberry32). */
export function seededRandom(seed) {
  let a = createHash("sha256").update(String(seed)).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(items, rnd) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Where the snapshots of a reference lie: planks name their own files, poehali shots sit in REFS_DIR. */
export function refShotPath(ref, width, refsDir = REFS_DIR) {
  if (ref.shots?.[width]) return join(ROOT, ref.shots[width]);
  return join(refsDir, ref.id, `${width}.png`);
}

const mimeOf = (p) => (p.endsWith(".jpg") || p.endsWith(".jpeg") ? "image/jpeg" : "image/png");
/** A 1×1 PNG: the stand of fixture mode when Wizard's snapshot is not taken yet (never judged by a model). */
const PLACEHOLDER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * The pairs of the run, in a random order drawn from `seed`; which side is Wizard is random per pair. `key` is the
 * answer sheet and never goes to a judge. A pair whose snapshot is missing is `missing` («снимок не получен») and
 * stays out of the share; in fixture mode (`placeholders`) a missing Wizard snapshot is a placeholder.
 */
export function buildPairs({ briefs, refs, seed = DEFAULT_SEED, wizardDir, refsDir = REFS_DIR, placeholders = false }) {
  const rnd = seededRandom(seed);
  const pairs = shuffle(briefs, rnd).map((brief, i) => {
    const ref = refs.find((r) => r.brief === brief.id);
    if (!ref) throw new Error(`у брифа ${brief.id} нет эталона в references.json`);
    const wizardIsA = rnd() < 0.5;
    const load = (path) => (path && existsSync(path) ? { mime: mimeOf(path), data: readFileSync(path).toString("base64"), path } : null);
    const sides = { wizard: {}, ref: {} };
    const missing = [];
    for (const w of WIDTHS) {
      const wp = wizardDir ? join(wizardDir, brief.id, `${w}.png`) : null;
      sides.wizard[w] = load(wp) ?? (placeholders ? { mime: "image/png", data: PLACEHOLDER.toString("base64"), path: null } : null);
      sides.ref[w] = load(refShotPath(ref, w, refsDir));
      if (!sides.wizard[w]) missing.push(`wizard-${w}`);
      if (!sides.ref[w]) missing.push(`ref-${w}`);
    }
    const [a, b] = wizardIsA ? ["wizard", "ref"] : ["ref", "wizard"];
    return {
      id: `p${String(i + 1).padStart(2, "0")}`,
      briefId: brief.id,
      brief: brief.text,
      title: brief.title,
      refId: ref.id,
      images: missing.length ? null : { A: sides[a], B: sides[b] },
      sides,
      key: { A: a, B: b },
      missing,
    };
  });
  return pairs;
}

export const JUDGE_SYSTEM =
  "Ты — арт-директор. Тебе показывают два сайта на один бриф: по два снимка первого экрана (десктоп 1440 px и телефон 390 px). Какие они, откуда и кто их сделал — неизвестно, оценивай только то, что видишь.";

/** What a judge sees: the brief, the side labels A/B and the images. No source, no file path, no pair id. */
export function judgeInput(pair) {
  if (!pair.images) throw new Error(`у пары ${pair.id} нет снимков`);
  const attachments = [];
  for (const side of ["A", "B"])
    for (const w of WIDTHS) {
      const img = pair.images[side][w];
      attachments.push({ mime: img.mime, data: img.data, name: `${side}-${w}` });
    }
  const text = [
    `Бриф клиента: ${pair.brief}`,
    "",
    "Вложения: A-1440, A-390 — сайт A; B-1440, B-390 — сайт B.",
    "Какой сайт лучше решает бриф: визуальный вкус, иерархия, читаемость, ощущение доверия, мобильная версия?",
    'Ответь одним JSON без пояснений вокруг: {"winner":"A"|"B"|"tie","reason":"одна фраза"}.',
  ].join("\n");
  return { system: JUDGE_SYSTEM, text, attachments };
}

/** The model's text → "A" | "B" | "tie" | null (null: unreadable, the pair is not counted for this judge). */
export function parseVerdict(text) {
  const m = String(text ?? "").match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const w = JSON.parse(m[0]).winner;
    return w === "A" || w === "B" || w === "tie" ? w : null;
  } catch {
    return null;
  }
}

/** One judge's pick against the key: "wizard" | "ref" | "tie". Wizard is «not worse» on wizard or tie. */
export const pickOf = (pair, winner) => (winner === "tie" ? "tie" : pair.key[winner]);
export const notWorse = (pick) => pick === "wizard" || pick === "tie";

/**
 * Judges every pair: `judge(modelId, input) → {text, costRub}`. The judge calls of a pair run in parallel; the run
 * stops starting pairs when the spend reaches `capRub`. → {pairs, spentRub, stoppedByCap}.
 */
export async function judgePairs({ pairs, judges = JUDGES, judge, capRub = DEFAULT_CAP_RUB }) {
  if (capRub > WORKFLOW_CAP_RUB) throw new Error(`потолок ${capRub} ₽ выше потолка workflow ${WORKFLOW_CAP_RUB} ₽`);
  let spentRub = 0;
  let stoppedByCap = false;
  const out = [];
  for (const pair of pairs) {
    if (pair.missing.length) {
      out.push({ ...pair, verdicts: [], result: "no_snapshot" });
      continue;
    }
    if (spentRub >= capRub) {
      stoppedByCap = true;
      out.push({ ...pair, verdicts: [], result: "skipped_by_cap" });
      continue;
    }
    const input = judgeInput(pair);
    const verdicts = await Promise.all(
      judges.map(async (model) => {
        try {
          const r = await judge(model, input);
          spentRub += r.costRub ?? 0;
          const winner = parseVerdict(r.text);
          return { model, winner, pick: winner ? pickOf(pair, winner) : null, costRub: r.costRub ?? 0, reason: reasonOf(r.text) };
        } catch (e) {
          return { model, winner: null, pick: null, costRub: 0, error: String(e?.message ?? e).slice(0, 200) };
        }
      }),
    );
    // A pair is «not worse» when most of the judges who answered say so; a tie of the panel counts for Wizard only if
    // fewer than half of the answers prefer the reference.
    const answered = verdicts.filter((v) => v.pick);
    const result = answered.length === 0 ? "no_verdict" : answered.filter((v) => notWorse(v.pick)).length * 2 > answered.length ? "not_worse" : "worse";
    out.push({ ...pair, verdicts, result });
  }
  return { pairs: out, spentRub: Math.round(spentRub * 100) / 100, stoppedByCap };
}

function reasonOf(text) {
  const m = String(text ?? "").match(/"reason"\s*:\s*"([^"]*)"/);
  return m ? m[1].slice(0, 300) : "";
}

/** The summary of a run: share of «not worse» pairs among the judged ones, per judge, cost. */
export function summarize({ pairs, spentRub, stoppedByCap, mode, seed, set, judges = JUDGES }) {
  const judged = pairs.filter((p) => p.result === "not_worse" || p.result === "worse");
  const good = judged.filter((p) => p.result === "not_worse").length;
  const perJudge = judges.map((model) => {
    const vs = pairs.flatMap((p) => p.verdicts.filter((v) => v.model === model && v.pick));
    return { model, answered: vs.length, notWorse: vs.filter((v) => notWorse(v.pick)).length };
  });
  const share = judged.length ? good / judged.length : null;
  return {
    kind: "v5-eval",
    mode,
    seed,
    set,
    pairs: pairs.length,
    judged: judged.length,
    notWorse: good,
    share,
    target: TARGET_SHARE,
    reachedTarget: share === null ? null : share >= TARGET_SHARE,
    noSnapshot: pairs.filter((p) => p.result === "no_snapshot").map((p) => ({ brief: p.briefId, missing: p.missing })),
    skippedByCap: pairs.filter((p) => p.result === "skipped_by_cap").length,
    perJudge,
    costRub: spentRub,
    stoppedByCap,
    warning: mode === "fixture" ? "fixture: судьи — заглушка, снимки Wizard — заглушки; доля механику проверяет, качество не измеряет" : null,
  };
}
