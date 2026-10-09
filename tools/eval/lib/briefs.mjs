// Briefs tools/eval/briefs/<id>.json (specs/quality/eval.yaml#briefs).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BRIEFS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "briefs");
export const BRIEF_ID = /^(ev|gd|hz)-[0-9]{2}-[a-z0-9-]+$/;
/** D67 readiness set (eval.yaml#briefs.mvp): short owner-style briefs run on the pilot server (tools/eval/server). */
export const MVP_ID = /^mvp-[0-9]{2}-[a-z0-9-]+$/;
export const MVP_CLASSES = ["site", "booking", "crm", "other"];
export const SEGMENT_BY_PREFIX = { ev: "events", gd: "made_to_order", hz: "horizontal", mv: "mvp", v3: "v3" };
/**
 * V3-18: briefs of the v3 measurement on the pilot server (checkpoint 1, D77_v3 (12) classes; tools/eval/server/v3.mjs):
 * owner-style texts, the grill interview answered by `answers` (topic → an option stem, "delegate" or {text}), «Дальше
 * решай сам» after `rest_after` questions, an optional ТЗ file `tz`, the direction to pick. Taken by loadBriefs("v3").
 */
export const V3_ID = /^v3-[0-9]{2}-[a-z0-9-]+$/;
/** D77_v3 (12): business sites (multi-page, blog), services with booking and a client cabinet, CRM/admin, shop. */
export const V3_CLASSES = ["site", "booking", "crm", "shop"];
/** Topics of the v3 grill interview (packages/agents interview-v3 V3_TOPICS) — keys of a v3 brief's `answers`. */
export const V3_TOPICS = ["goals", "audience", "scenarios", "data", "roles", "integrations", "content", "constraints"];
export const isV3Brief = (id) => V3_ID.test(String(id ?? ""));
/** D67: 10 briefs, 2–3 per class of D65 and 2 outside the classes. */
export const MVP_SET = { total: 10, site: 3, booking: 3, crm: 2, other: 2 };
export const isMvpBrief = (id) => MVP_ID.test(String(id ?? ""));
/** eval.yaml#briefs.set for M0. */
export const M0_SET = { total: 12, ev: 5, gd: 3, hz: 4, canaries: 4 };
/** eval.yaml#briefs.set for M2 (L4-28): 30 briefs, ≥ 10 horizontal (outside the two proving grounds). */
export const M2_SET = { total: 30, hz: 10 };

/** Object keys of originals: eval/partners/<ref>/<briefId>.<ext> (the eval-live workflow writes eval/live/…). */
export const PARTNER_PREFIX = "eval/partners";
/** Pseudonymous partner id; names and contacts of partners never reach the repository. */
export const PARTNER_REF = /^P[0-9]{2}$/;
export const ORIGINAL_EXT = /^\.(txt|md|json|pdf|docx|rtf|odt)$/;

export const partnerKey = (ref, briefId, ext) => `${PARTNER_PREFIX}/${ref}/${briefId}${ext}`;

/** Problems of a brief's `partner` block (Russian; [] when absent or valid). */
export function partnerProblems(b) {
  if (b.partner === undefined) return [];
  const p = b.partner;
  const out = [];
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["partner: объект {ref, original}"];
  if (!PARTNER_REF.test(p.ref ?? "")) out.push(`partner.ref "${p.ref}" не подходит под ${PARTNER_REF}`);
  const o = p.original ?? {};
  const ext = extname(String(o.key ?? ""));
  if (!ORIGINAL_EXT.test(ext) || o.key !== partnerKey(p.ref, b.id, ext))
    out.push(
      `partner.original.key: ожидается ${PARTNER_PREFIX}/${p.ref}/${b.id}.<txt|md|json|pdf|docx|rtf|odt>`,
    );
  if (!/^[0-9a-f]{64}$/.test(o.sha256 ?? "")) out.push("partner.original.sha256: 64 hex-символа");
  if (!Number.isInteger(o.bytes) || o.bytes <= 0) out.push("partner.original.bytes: целое > 0");
  if (typeof b.text === "string" && createHash("sha256").update(b.text).digest("hex") === o.sha256)
    out.push("text брифа совпадает с оригиналом партнёра — нужен синтетический пересказ");
  return out;
}

/** Fields of a D67 brief: class, optional free_answer and the beyond-capabilities expectation. */
function mvpProblems(b) {
  const out = [];
  if (!MVP_CLASSES.includes(b.class)) out.push(`class: одно из ${MVP_CLASSES.join(", ")}`);
  if (b.free_answer !== undefined && (typeof b.free_answer !== "string" || b.free_answer.length > 500))
    out.push("free_answer: строка ≤ 500 символов");
  if (b.beyond !== undefined) {
    const stems = b.beyond?.gap_stems;
    if (b.class !== "other") out.push("beyond: только у брифов класса other");
    if (!Array.isArray(stems) || !stems.length || stems.some((x) => typeof x !== "string" || !x))
      out.push("beyond.gap_stems: непустой массив строк");
  }
  return out;
}

/** Fields of a v3 brief (V3-18): class, answers, rest_after, tz, direction. */
function v3Problems(b) {
  const out = [];
  if (!V3_CLASSES.includes(b.class)) out.push(`class: одно из ${V3_CLASSES.join(", ")}`);
  if (b.answers !== undefined) {
    if (!b.answers || typeof b.answers !== "object" || Array.isArray(b.answers))
      out.push("answers: объект {тема: основа варианта | delegate | recommended | {text}}");
    else
      for (const [k, v] of Object.entries(b.answers)) {
        if (!V3_TOPICS.includes(k)) out.push(`answers.${k}: тема интервью — одна из ${V3_TOPICS.join(", ")}`);
        const text = v && typeof v === "object" && typeof v.text === "string" ? v.text.trim() : null;
        if (!(typeof v === "string" && v.trim()) && !(text && text.length <= 500))
          out.push(`answers.${k}: строка (основа варианта, delegate, recommended) или {text} ≤ 500 символов`);
      }
  }
  if (b.rest_after !== undefined && !(Number.isInteger(b.rest_after) && b.rest_after >= 1 && b.rest_after <= 15))
    out.push("rest_after: целое от 1 до 15 — после скольких ответов «Дальше решай сам»");
  if (b.tz !== undefined) {
    const t = b.tz;
    if (
      !t ||
      !["md", "txt"].includes(t.format) ||
      typeof t.text !== "string" ||
      t.text.length < 200 ||
      t.text.length > 8000
    )
      out.push("tz: {format: md | txt, text: 200–8000 символов} — файл ТЗ, который замер прикладывает");
  }
  if (b.direction !== undefined && ![1, 2, 3, "delegate"].includes(b.direction))
    out.push("direction: 1, 2, 3 или delegate («Решите за меня»)");
  return out;
}

/** Format problems of one brief (Russian, for test and CLI messages). */
export function briefProblems(b, file) {
  const out = [];
  const mvp = isMvpBrief(b.id);
  const v3 = isV3Brief(b.id);
  if (!mvp && !v3 && !BRIEF_ID.test(b.id ?? ""))
    out.push(`id "${b.id}" не подходит под ${BRIEF_ID}, ${MVP_ID} или ${V3_ID}`);
  if (file && file !== `${b.id}.json`) out.push(`имя файла ${file} ≠ ${b.id}.json`);
  const prefix = String(b.id).slice(0, 2);
  if (b.segment !== SEGMENT_BY_PREFIX[prefix])
    out.push(`segment "${b.segment}" ≠ ${SEGMENT_BY_PREFIX[prefix]}`);
  if (typeof b.title !== "string" || !b.title || b.title.length > 100) out.push("title: 1–100 символов");
  // D67 briefs are written the way owners type them in the chat: short, sometimes careless.
  const [minText, maxText] = mvp ? [60, 1500] : [300, 1500];
  if (typeof b.text !== "string" || b.text.length < minText || b.text.length > maxText)
    out.push(`text: ${minText}–${maxText} символов`);
  if (mvp) out.push(...mvpProblems(b));
  else if (v3) out.push(...v3Problems(b));
  else if (b.class !== undefined) out.push("class: только у брифов mvp-* и v3-*");
  for (const k of ["roles", "entities", "must_have_features", "acceptance_criteria"])
    if (!Array.isArray(b.expected?.[k]) || !b.expected[k].length)
      out.push(`expected.${k}: непустой массив строк`);
  if (b.canaries !== undefined) {
    if (!Array.isArray(b.canaries) || !b.canaries.length) out.push("canaries: непустой массив строк");
    else for (const c of b.canaries) if (!b.text.includes(c)) out.push(`канарейка "${c}" не входит в text`);
  }
  if (!v3 && b.answers !== undefined && (typeof b.answers !== "object" || Array.isArray(b.answers)))
    out.push("answers: объект {forkId: optionId}");
  out.push(...partnerProblems(b));
  return out;
}

/**
 * Briefs sorted by id; `want` = comma list or array of ids (unknown ids throw). Without `want` (or "all") — the P set
 * only: the D67 briefs mvp-* are short and run on the server (tools/eval/server), they are taken by "mvp" or by id;
 * the v3 briefs v3-* (V3-18, the v3 measurement on the server) — by "v3" or by id.
 */
export function loadBriefs(want, dir = BRIEFS_DIR) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const all = files.map((f) => {
    const b = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const problems = briefProblems(b, f);
    if (problems.length) throw new Error(`бриф ${f}: ${problems.join("; ")}`);
    return b;
  });
  if (want === undefined || want === true || want === "all")
    return all.filter((b) => !isMvpBrief(b.id) && !isV3Brief(b.id));
  if (want === "mvp") return all.filter((b) => isMvpBrief(b.id));
  if (want === "v3") return all.filter((b) => isV3Brief(b.id));
  const ids = Array.isArray(want) ? want : String(want).split(",").filter(Boolean);
  const unknown = ids.filter((id) => !all.some((b) => b.id === id));
  if (unknown.length) throw new Error(`неизвестные брифы: ${unknown.join(", ")}`);
  return all.filter((b) => ids.includes(b.id));
}
