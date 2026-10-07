// Service account of the D67 measurement, created by the operator of the release directly in the platform database
// (sign-in on the pilot is by a code from a letter, the eval has no mailbox). Tables of specs/platform/db.yaml:
// users (consents accepted), a personal org on the pilot plan (founder review stays on: nothing reaches prod), its
// owner membership, pilot credits in the ledger (bucket topup, key pilot_grant:eval:<runid>, billing.yaml#plans.pilot
// .grants.manual) and a session stored as sha256 of the token and of the CSRF value
// (apps/platform-api/src/auth/sessions.ts). The raw token is generated here, by the operator, and never reaches the
// database or the log. Values reach psql as validated literals of \set lines on stdin, never as command arguments.
import { createHash, randomBytes } from "node:crypto";
import { RUB_PER_CREDIT } from "./driver.mjs";

export const RUNID = /^[a-z0-9][a-z0-9-]{3,39}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** apps/platform-api/src/auth/accounts.ts OFFER_VERSION — the offer the eval account «accepted». */
export const OFFER_VERSION = "draft-2026-09";
/**
 * D70 limit of a pilot org is 5 builds and 20 edits per 30 days; the measurement needs ≥ 15 builds (10 briefs, fixes,
 * repeats of failed ones). Until the /admin «raise the limit» mechanism exists the eval org is covered by credits.
 */
export const EVAL_MIN_BUILDS = 15;
export const SESSION_DAYS = 2;

export const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** Run id of a measurement: <yyyymmdd>-<6 hex>, lower case (part of the e-mail and of the ledger key). */
export function newRunId(now = new Date(), rand = randomBytes) {
  return `${now.toISOString().slice(0, 10).replaceAll("-", "")}-${rand(3).toString("hex")}`;
}

/** Raw session token and CSRF value (43 url-safe characters each, as randomToken of platform-api). */
export function newEvalSession(rand = randomBytes) {
  const token = rand(32).toString("base64url");
  const csrf = rand(32).toString("base64url");
  return { token, csrf, tokenHash: sha256Hex(token), csrfHash: sha256Hex(csrf) };
}

/** Labels of the measurements in the org name (D67 of the MVP, D76 of beta v2). */
export const EVAL_LABELS = ["D67", "D76"];

/** Address and org name of a measurement: eval+<runid>@<domain>, «Замер D67 · <runid>» (label D76 for beta v2). */
export function evalIdentity(runid, domain = "borntobuild.ru", label = "D67") {
  if (!RUNID.test(runid)) throw new Error(`runid: ${RUNID}`);
  if (!DOMAIN.test(domain)) throw new Error(`домен почты замера: ${domain}`);
  if (!EVAL_LABELS.includes(label)) throw new Error(`метка замера: ${EVAL_LABELS.join(" | ")}`);
  return { email: `eval+${runid}@${domain}`, orgName: `Замер ${label} · ${runid}` };
}

/** Credits of the eval org: 1.5 × the ₽ budget in credits (holds reserve the card cap), at least 15 builds × 60. */
export function evalCredits(maxCostRub) {
  return Math.max(EVAL_MIN_BUILDS * 60, Math.ceil((maxCostRub / RUB_PER_CREDIT) * 1.5));
}

const setLine = (name, value, re) => {
  const v = String(value);
  if (!re.test(v)) throw new Error(`seed: недопустимое значение ${name}`);
  return `\\set ${name} '${v}'`;
};

/**
 * psql script (stdin, `psql -X -q -A -t -v ON_ERROR_STOP=1 -1 -f -`) creating the account; prints one JSON line
 * {userId, orgId, sessionId, email}. Fully qualified names, values only as psql variables.
 */
export function seedSql({
  runid,
  domain,
  tokenHash,
  csrfHash,
  credits,
  sessionDays = SESSION_DAYS,
  label = "D67",
}) {
  const { email, orgName } = evalIdentity(runid, domain, label);
  if (!HEX64.test(tokenHash) || !HEX64.test(csrfHash)) throw new Error("seed: нужны sha256 токена и CSRF");
  if (!Number.isInteger(credits) || credits <= 0 || credits > 100_000)
    throw new Error("seed: кредиты 1…100 000");
  if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 7)
    throw new Error("seed: сессия 1…7 дней");
  return [
    setLine("email", email, /^eval\+[a-z0-9-]+@[a-z0-9.-]+$/),
    setLine("org_name", orgName, /^Замер D(67|76) · [a-z0-9-]+$/),
    setLine("runid", runid, RUNID),
    setLine("offer_version", OFFER_VERSION, /^[a-z0-9-]+$/),
    setLine("token_hash", tokenHash, HEX64),
    setLine("csrf_hash", csrfHash, HEX64),
    setLine("credits_milli", credits * 1000, /^[0-9]+$/),
    setLine("session_days", sessionDays, /^[0-9]$/),
    `INSERT INTO platform.users (email, offer_accepted_at, offer_version, pd_consent_at)
  VALUES (:'email', now(), :'offer_version', now()) RETURNING id AS user_id \\gset`,
    // Pilot plan and founder review on: the first publication of an eval system waits in /admin and never goes live.
    // D70 pilot limit (platform.orgs.pilot_builds_limit, M2-34): the eval account needs room for every brief and a retry.
    // B2-01, B2-04: an eval org — own daily LLM cap, its spend counts against the beta v2 development budget.
    `INSERT INTO platform.orgs (name, plan, require_founder_review, pilot_builds_limit, pilot_edits_limit, kind)
  VALUES (:'org_name', 'pilot', true, ${EVAL_MIN_BUILDS}, ${EVAL_MIN_BUILDS * 2}, 'eval') RETURNING id AS org_id \\gset`,
    `INSERT INTO platform.memberships (org_id, user_id, role) VALUES (:'org_id', :'user_id', 'owner');`,
    `INSERT INTO platform.credit_ledger (org_id, kind, amount_milli, bucket, bucket_expires_at, idempotency_key, note_ru)
  VALUES (:'org_id', 'grant', :'credits_milli'::bigint, 'topup', now() + interval '30 days',
          'pilot_grant:eval:' || :'runid', 'Кредиты замера (служебная учётка ' || :'runid' || ')');`,
    `INSERT INTO platform.sessions (user_id, token_hash, csrf_hash, expires_at)
  VALUES (:'user_id', :'token_hash', :'csrf_hash', now() + make_interval(days => :'session_days'::int))
  RETURNING id AS session_id \\gset`,
    `SELECT json_build_object('userId', :'user_id', 'orgId', :'org_id', 'sessionId', :'session_id', 'email', :'email');`,
    "",
  ].join("\n");
}

/** {userId, orgId, sessionId, email} from the output of seedSql (the last JSON line). */
export function parseSeedOutput(stdout) {
  const line = String(stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .at(-1);
  if (!line) throw new Error("seed: psql не вернул идентификаторы учётки");
  const o = JSON.parse(line);
  for (const k of ["userId", "orgId", "sessionId"])
    if (!UUID.test(o[k] ?? "")) throw new Error(`seed: нет ${k} в ответе psql`);
  return o;
}

/** Revokes the eval session by the hash of its token (cleanup; the systems stay for the founder). */
export function revokeSql({ tokenHash }) {
  return [
    setLine("token_hash", tokenHash, HEX64),
    `UPDATE platform.sessions SET revoked_at = now()
  WHERE token_hash = :'token_hash' AND revoked_at IS NULL RETURNING 'revoked=' || id;`,
    "",
  ].join("\n");
}

/**
 * After the run: exact model spend per system (platform.llm_calls.cost_rub of billable calls, ₽ with VAT) and the
 * «Запросы на развитие» rows of the org's systems when that table exists (M2-59 is in progress; the candidates are
 * fixed names, so the interpolated identifier never comes from input), and the stage metrics of the harness (payload
 * of the last build_metrics event of each system's create run — the latest build when there is none — so a later
 * «Исправить» run does not hide the stages of the build itself, eval.yaml stages). One line per result:
 * `costs=<json>`, `gaps=<json|null>`, `metrics=<json>`, `photos=<json>` (B2-41: stock photos of the sites),
 * `invalid=<json>` (B2-41: orch_invalid of the systems);
 * ::jsonb::text keeps each on one line (json_agg puts a newline between elements).
 */
export function collectSql({ orgId, b2Since }) {
  // B2-04: spend of every eval org (probes and measurements) since the start of the beta v2 development budget, as
  // llm-spend.ts counts it (billable live/record calls, the Moscow day of b2Since) — `b2=<json>`.
  const b2 = b2Since
    ? [
        setLine("b2_since", b2Since, /^\d{4}-\d{2}-\d{2}$/),
        `SELECT 'b2=' || json_build_object('since', :'b2_since',
         'rub', coalesce(round(sum(c.cost_rub), 2), 0)::float8)::jsonb::text
    FROM platform.llm_calls c
    JOIN platform.orgs o ON o.id = c.org_id
   WHERE c.billable AND c.mode IN ('live', 'record') AND o.kind = 'eval'
     AND c.created_at >= (:'b2_since'::date::timestamp AT TIME ZONE 'Europe/Moscow');`,
      ]
    : [];
  return [
    setLine("org_id", orgId, UUID),
    ...b2,
    `SELECT 'costs=' || coalesce(json_agg(x), '[]'::json)::jsonb::text FROM (
  SELECT c.system_id, round(sum(c.cost_rub), 2)::float8 AS rub, sum(c.credits_milli)::bigint AS credits_milli,
         count(*)::int AS calls
    FROM platform.llm_calls c
   WHERE c.org_id = :'org_id' AND c.billable
   GROUP BY c.system_id) x;`,
    `SELECT coalesce(to_regclass('platform.development_requests'), to_regclass('platform.capability_gaps'),
                to_regclass('platform.gaps'))::text AS gaps_table \\gset`,
    `\\if :{?gaps_table}`,
    `SELECT 'gaps=' || coalesce(json_agg(row_to_json(g)), '[]'::json)::jsonb::text FROM :gaps_table g
   WHERE g.system_id IN (SELECT s.id FROM platform.systems s WHERE s.org_id = :'org_id');`,
    `\\else`,
    `SELECT 'gaps=null';`,
    `\\endif`,
    `SELECT 'metrics=' || coalesce(json_agg(x), '[]'::json)::jsonb::text FROM (
  SELECT s.id AS system_id, e.payload
    FROM platform.systems s
   CROSS JOIN LATERAL (SELECT r.id FROM platform.runs r WHERE r.system_id = s.id AND r.kind = 'build'
                        ORDER BY (r.mode = 'create') DESC, r.created_at DESC, r.id DESC LIMIT 1) r
   CROSS JOIN LATERAL (SELECT ev.payload FROM platform.run_events ev
                        WHERE ev.run_id = r.id AND ev.type = 'build_metrics' ORDER BY ev.seq DESC LIMIT 1) e
   WHERE s.org_id = :'org_id') x;`,
    // B2-41: stock photos of each system's site — design.photos of the plan its latest approved revision was built
    // into (the photos stage checkpoint; the approved plan itself while that stage has not run), counted by provider.
    `SELECT to_regclass('platform.system_plans')::text AS plans_table \\gset`,
    `\\if :{?plans_table}`,
    `SELECT 'photos=' || coalesce(json_agg(x), '[]'::json)::jsonb::text FROM (
  SELECT p.system_id, p.revision, p.built,
         (SELECT coalesce(json_object_agg(q.provider, q.n), '{}'::json) FROM (
            SELECT coalesce(ph->>'provider', 'other') AS provider, count(*)::int AS n
              FROM jsonb_array_elements(p.photos) ph GROUP BY 1) q) AS providers
    FROM platform.systems s
   CROSS JOIN LATERAL (
     SELECT sp.system_id, sp.revision, v.built,
            CASE WHEN jsonb_typeof(v.photos) = 'array' THEN v.photos ELSE '[]'::jsonb END AS photos
       FROM platform.system_plans sp
      CROSS JOIN LATERAL (SELECT sp.checkpoints ? 'photos' AS built,
                                 CASE WHEN sp.checkpoints ? 'photos'
                                      THEN sp.checkpoints #> '{photos,data,plan,design,photos}'
                                      ELSE sp.plan #> '{design,photos}' END AS photos) v
      WHERE sp.system_id = s.id AND sp.approved_at IS NOT NULL
      ORDER BY sp.revision DESC LIMIT 1) p
   WHERE s.org_id = :'org_id') x;`,
    `\\endif`,
    // B2-41: answers of the models that did not pass (orch_invalid: step, fallback, issues {path, code, message ≤ 160}
    // — check paths and codes, no PII), oldest first, for the diagnosis in the report.
    `SELECT 'invalid=' || coalesce(json_agg(x ORDER BY x.ts), '[]'::json)::jsonb::text FROM (
  SELECT r.system_id, e.ts, e.payload
    FROM platform.run_events e
    JOIN platform.runs r ON r.id = e.run_id
    JOIN platform.systems s ON s.id = r.system_id
   WHERE s.org_id = :'org_id' AND e.type = 'orch_invalid'
   ORDER BY e.ts LIMIT 200) x;`,
    "",
  ].join("\n");
}

/**
 * Output of collectSql → {costs: {systemId: {rub, credits, calls}}, gaps: {systemId: [{category, quote, offered}]}|null,
 * metrics: {systemId: build_metrics payload}, invalid, photos: {systemId: {total, pexels, pixabay, revision, built}}}.
 */
export function parseCollectOutput(stdout) {
  const lines = String(stdout ?? "").split("\n");
  const value = (k) => {
    const l = lines.find((x) => x.startsWith(`${k}=`));
    return l === undefined ? undefined : JSON.parse(l.slice(k.length + 1));
  };
  const costs = {};
  for (const c of value("costs") ?? [])
    if (c.system_id)
      costs[c.system_id] = { rub: Number(c.rub), credits: Number(c.credits_milli) / 1000, calls: c.calls };
  const rows = value("gaps");
  let gaps = null;
  if (Array.isArray(rows)) {
    gaps = {};
    for (const g of rows) {
      const id = g.system_id;
      if (!id) continue;
      const pick = (...ks) => ks.map((k) => g[k]).find((v) => typeof v === "string" && v) ?? null;
      (gaps[id] ??= []).push({
        category: pick("category", "kind"),
        quote: pick("quote", "quote_scrubbed", "text")?.slice(0, 300) ?? null,
        offered: pick("offered", "offered_ru", "replacement")?.slice(0, 300) ?? null,
      });
    }
  }
  const metrics = {};
  for (const m of value("metrics") ?? [])
    if (m.system_id && m.payload && typeof m.payload === "object") metrics[m.system_id] = m.payload;
  // B2-41: orch_invalid per system — {step, fallback, issues: [{path, code?, message}]} (absent line → {}).
  const invalid = {};
  for (const x of value("invalid") ?? []) {
    const p = x?.payload;
    if (!x?.system_id || !p || typeof p !== "object") continue;
    (invalid[x.system_id] ??= []).push({
      step: typeof p.step === "string" ? p.step : null,
      fallback: typeof p.fallback === "string" ? p.fallback : "none",
      issues: (Array.isArray(p.issues) ? p.issues : []).slice(0, 10).map((i) => ({
        path: String(i?.path ?? ""),
        ...(i?.code ? { code: String(i.code) } : {}),
        message: String(i?.message ?? "").slice(0, 160),
      })),
    });
  }
  // B2-41: stock photos per system — {total, pexels, pixabay, revision, built} (absent line → {}).
  const photos = {};
  for (const x of value("photos") ?? []) {
    if (!x?.system_id) continue;
    const by = x.providers && typeof x.providers === "object" ? x.providers : {};
    const n = (k) => (Number.isFinite(Number(by[k])) ? Number(by[k]) : 0);
    photos[x.system_id] = {
      total: Object.keys(by).reduce((sum, k) => sum + n(k), 0),
      pexels: n("pexels"),
      pixabay: n("pixabay"),
      revision: Number(x.revision),
      built: !!x.built,
    };
  }
  const b2raw = value("b2");
  const b2 =
    b2raw && typeof b2raw === "object" && Number.isFinite(Number(b2raw.rub))
      ? { since: String(b2raw.since ?? ""), rub: Number(b2raw.rub) }
      : null;
  return { costs, gaps, metrics, invalid, photos, ...(b2 ? { b2 } : {}) };
}
