// Briefs of design partners (specs/quality/eval.yaml#briefs.set, L3-07): the repository holds only a synthetic
// retelling (tools/eval/briefs/<id>.json with a `partner` block); the original lives in the eval S3 bucket in RF and
// is never written inside the repository.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIEF_ID, BRIEFS_DIR, ORIGINAL_EXT, PARTNER_REF, partnerKey, partnerProblems } from "./briefs.mjs";
import { getObject, putObject, sha256Hex } from "./s3.mjs";

export { PARTNER_PREFIX, PARTNER_REF, partnerKey, partnerProblems } from "./briefs.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
const TEXT_EXT = new Set([".txt", ".md", ".json", ".rtf"]);
const CONTENT_TYPE = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".rtf": "application/rtf",
  ".odt": "application/vnd.oasis.opendocument.text",
};

/** Real path of `p` or of its nearest existing ancestor (the path itself may not exist yet). */
function realish(p) {
  let cur = resolve(p);
  const tail = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    tail.unshift(basename(cur));
    cur = up;
  }
  return join(realpathSync(cur), ...tail);
}

/** `p` is the repository root or inside it (symlinks resolved). */
export function insideRepo(p, root = REPO_ROOT) {
  const rel = relative(realpathSync(root), realish(p));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

/** Throws when `p` is inside the repository: an original there is one `git add` away from GitHub (outside RF). */
export function assertOutsideRepo(p, what, root = REPO_ROOT) {
  if (insideRepo(p, root))
    throw new Error(
      `${what} ${p} внутри репозитория: оригиналы партнёров не хранятся в репозитории даже временно (L3-07). Используйте каталог вне ${root}`,
    );
}

const words = (s) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Why the retelling is not synthetic enough (Russian; [] = ok): identical text, a verbatim fragment of ≥ 12 words,
 * or more than 30 % of its 6-word shingles taken from the original.
 */
export function retellingProblems(original, retelling) {
  const a = words(original);
  const b = words(retelling);
  if (!b.length) return ["пересказ пустой"];
  if (a.join(" ") === b.join(" ")) return ["пересказ совпадает с оригиналом"];
  const out = [];
  const grams = (ws, k) =>
    new Set(ws.slice(0, Math.max(0, ws.length - k + 1)).map((_, i) => ws.slice(i, i + k).join(" ")));
  const long = grams(a, 12);
  const verbatim = [...grams(b, 12)].find((g) => long.has(g));
  if (verbatim) out.push(`в пересказе дословный фрагмент оригинала: «${verbatim.slice(0, 80)}…»`);
  const six = grams(a, 6);
  const mine = [...grams(b, 6)];
  const shared = mine.filter((g) => six.has(g)).length / (mine.length || 1);
  if (shared > 0.3)
    out.push(`пересказ слишком близок к оригиналу: ${Math.round(shared * 100)}% шестисловий совпадают`);
  return out;
}

const briefPath = (dir, id) => join(dir, `${id}.json`);

function readBrief(dir, id) {
  if (!BRIEF_ID.test(id ?? ""))
    throw new Error(`--brief: id брифа вида ev-01-…, gd-01-…, hz-01-… (получено ${id})`);
  const file = briefPath(dir, id);
  if (!existsSync(file))
    throw new Error(
      `нет ${relative(REPO_ROOT, file) || file}: сначала напишите синтетический пересказ брифа, потом загружайте оригинал`,
    );
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Upload a partner's original from outside the repository to <bucket>/eval/partners/<ref>/<briefId>.<ext> and write
 * the `partner` block (key, sha256, bytes — no content) into the retelling brief. Returns that block.
 */
export async function uploadOriginal({ file, ref, briefId, briefsDir = BRIEFS_DIR, s3, fetch, now }) {
  if (!PARTNER_REF.test(ref ?? ""))
    throw new Error(`--partner: псевдоним партнёра P01…P99 (получено ${ref})`);
  assertOutsideRepo(file, "оригинал");
  const ext = extname(file).toLowerCase();
  if (!ORIGINAL_EXT.test(ext))
    throw new Error(`оригинал ${basename(file)}: поддерживаются .txt .md .json .pdf .docx .rtf .odt`);
  const size = statSync(file).size;
  if (size === 0 || size > MAX_ORIGINAL_BYTES) throw new Error(`оригинал ${basename(file)}: 1 байт … 20 МБ`);
  const body = readFileSync(file);
  const brief = readBrief(briefsDir, briefId);
  if (brief.partner && brief.partner.ref !== ref)
    throw new Error(`бриф ${briefId} уже привязан к партнёру ${brief.partner.ref}`);
  if (TEXT_EXT.has(ext)) {
    const problems = retellingProblems(body.toString("utf8"), brief.text);
    if (problems.length) throw new Error(`бриф ${briefId}: ${problems.join("; ")}`);
  }
  const sha256 = sha256Hex(body);
  const key = partnerKey(ref, briefId, ext);
  await putObject(s3, key, body, {
    contentType: CONTENT_TYPE[ext],
    meta: { sha256, brief: briefId, partner: ref },
    ...(fetch ? { fetch } : {}),
    ...(now ? { now } : {}),
  });
  const block = { ref, original: { key, sha256, bytes: body.length } };
  const next = { ...brief, partner: block };
  const problems = partnerProblems(next);
  if (problems.length) throw new Error(`бриф ${briefId}: ${problems.join("; ")}`);
  writeFileSync(briefPath(briefsDir, briefId), `${JSON.stringify(next, null, 2)}\n`);
  return block;
}

/**
 * Download the original of a partner brief into `out` (default: a fresh folder under the OS temp dir; never inside
 * the repository), verify its sha256 and return the file path (mode 0600).
 */
export async function fetchOriginal({ briefId, briefsDir = BRIEFS_DIR, out, s3, fetch, now }) {
  const brief = readBrief(briefsDir, briefId);
  if (!brief.partner) throw new Error(`бриф ${briefId} не от партнёра: в нём нет блока partner`);
  const problems = partnerProblems(brief);
  if (problems.length) throw new Error(`бриф ${briefId}: ${problems.join("; ")}`);
  const dir = out ?? mkdtempSync(join(tmpdir(), "wz-partner-"));
  assertOutsideRepo(dir, "каталог --out");
  const body = await getObject(s3, brief.partner.original.key, {
    ...(fetch ? { fetch } : {}),
    ...(now ? { now } : {}),
  });
  if (sha256Hex(body) !== brief.partner.original.sha256)
    throw new Error(`оригинал ${brief.partner.original.key}: sha256 не совпадает с записанным в брифе`);
  const file = join(dir, basename(brief.partner.original.key));
  writeFileSync(file, body, { mode: 0o600 });
  return file;
}

/** Files tracked by git under `root` (relative paths). */
export function trackedFiles(root = REPO_ROOT) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

/**
 * Guard (CI): repository files whose bytes equal a partner original recorded in the briefs. `files` are relative to
 * `root`; files larger than MAX_ORIGINAL_BYTES cannot be originals and are skipped.
 */
export function originalsInRepo(briefs, files, root = REPO_ROOT) {
  const want = new Map(
    briefs.filter((b) => b.partner?.original?.sha256).map((b) => [b.partner.original.sha256, b.id]),
  );
  if (!want.size) return [];
  const sizes = new Set(briefs.filter((b) => b.partner).map((b) => b.partner.original.bytes));
  const out = [];
  for (const f of files) {
    const p = join(root, f);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue; // deleted in the work tree
    }
    if (!st.isFile() || !sizes.has(st.size)) continue;
    const id = want.get(sha256Hex(readFileSync(p)));
    if (id) out.push(`${f} = оригинал партнёра для ${id}`);
  }
  return out;
}
