// Briefs tools/eval/briefs/<id>.json (specs/quality/eval.yaml#briefs).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BRIEFS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "briefs");
export const BRIEF_ID = /^(ev|gd|hz)-[0-9]{2}-[a-z0-9-]+$/;
export const SEGMENT_BY_PREFIX = { ev: "events", gd: "made_to_order", hz: "horizontal" };
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

/** Format problems of one brief (Russian, for test and CLI messages). */
export function briefProblems(b, file) {
  const out = [];
  if (!BRIEF_ID.test(b.id ?? "")) out.push(`id "${b.id}" не подходит под ${BRIEF_ID}`);
  if (file && file !== `${b.id}.json`) out.push(`имя файла ${file} ≠ ${b.id}.json`);
  const prefix = String(b.id).slice(0, 2);
  if (b.segment !== SEGMENT_BY_PREFIX[prefix])
    out.push(`segment "${b.segment}" ≠ ${SEGMENT_BY_PREFIX[prefix]}`);
  if (typeof b.title !== "string" || !b.title || b.title.length > 100) out.push("title: 1–100 символов");
  if (typeof b.text !== "string" || b.text.length < 300 || b.text.length > 1500)
    out.push("text: 300–1500 символов");
  for (const k of ["roles", "entities", "must_have_features", "acceptance_criteria"])
    if (!Array.isArray(b.expected?.[k]) || !b.expected[k].length)
      out.push(`expected.${k}: непустой массив строк`);
  if (b.canaries !== undefined) {
    if (!Array.isArray(b.canaries) || !b.canaries.length) out.push("canaries: непустой массив строк");
    else for (const c of b.canaries) if (!b.text.includes(c)) out.push(`канарейка "${c}" не входит в text`);
  }
  if (b.answers !== undefined && (typeof b.answers !== "object" || Array.isArray(b.answers)))
    out.push("answers: объект {forkId: optionId}");
  out.push(...partnerProblems(b));
  return out;
}

/** All briefs sorted by id; `want` = comma list or array of ids (unknown ids throw). */
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
  if (want === undefined || want === true || want === "all") return all;
  const ids = Array.isArray(want) ? want : String(want).split(",").filter(Boolean);
  const unknown = ids.filter((id) => !all.some((b) => b.id === id));
  if (unknown.length) throw new Error(`неизвестные брифы: ${unknown.join(", ")}`);
  return all.filter((b) => ids.includes(b.id));
}
