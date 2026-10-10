// V3-40: the payment check of shops already built (tools/deploy/pilot.mjs v3-probe --pay): the visitor's purchase on
// the draft's preview paid with the test card on the founder's ЮKassa test shop (v3-pay.mjs shopPayment) — no new
// build, no model calls. After a fix of the measurement's own automation of the ЮKassa page the same systems of the
// final measurement are checked again (10.10.2026: the click went to the page's note instead of «Новая карта»). Only
// systems of one measurement org (platform.orgs.kind = 'eval'): a session of its owner is created for the check, the
// check logs out and the session is revoked in the database after it. The raw token never reaches the database.
import { isReadyV3 } from "./v3.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** At most this many systems in one check (the three shops of the final set). */
export const PAY_PROBE_MAX = 3;
/** The session of the check lives this long (the purchase of three shops takes minutes). */
export const PAY_PROBE_SESSION_HOURS = 2;

/** «uuid,uuid» → distinct system ids (1…PAY_PROBE_MAX); anything else throws with the reason in Russian. */
export function parsePaySystems(text) {
  const ids = String(text ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!ids.length) throw new Error("--pay: id систем через запятую");
  if (ids.length > PAY_PROBE_MAX) throw new Error(`--pay: не больше ${PAY_PROBE_MAX} систем за раз`);
  for (const id of ids) if (!UUID.test(id)) throw new Error(`--pay: не id системы: ${id.slice(0, 40)}`);
  if (new Set(ids).size !== ids.length) throw new Error("--pay: система указана дважды");
  return ids;
}

/**
 * psql script (stdin, `psql -X -q -A -t -v ON_ERROR_STOP=1 -1 -f -`): when every system of `systemIds` belongs to one
 * eval org, a session of that org's owner (sha256 of the token and of the CSRF value); prints one JSON line
 * {userId, orgId, sessionId}. Otherwise prints nothing and creates nothing. Values only as psql variables.
 */
export function payProbeSessionSql({ systemIds, tokenHash, csrfHash, hours = PAY_PROBE_SESSION_HOURS }) {
  const ids = parsePaySystems(systemIds.join(","));
  if (!HEX64.test(tokenHash) || !HEX64.test(csrfHash)) throw new Error("проба оплаты: нужны sha256 токена и CSRF");
  if (!Number.isInteger(hours) || hours < 1 || hours > 6) throw new Error("проба оплаты: сессия 1…6 часов");
  return [
    `\\set systems '{${ids.join(",")}}'`,
    `\\set n '${ids.length}'`,
    `\\set token_hash '${tokenHash}'`,
    `\\set csrf_hash '${csrfHash}'`,
    `\\set hours '${hours}'`,
    `WITH sys AS (
  SELECT s.id, s.org_id FROM platform.systems s
    JOIN platform.orgs o ON o.id = s.org_id AND o.kind = 'eval'
   WHERE s.id = ANY(:'systems'::uuid[])
), one AS (
  SELECT min(sys.org_id::text)::uuid AS org_id FROM sys
  HAVING count(DISTINCT sys.org_id) = 1 AND count(*) = :'n'::int
), owner AS (
  SELECT m.user_id, m.org_id FROM platform.memberships m JOIN one ON one.org_id = m.org_id
   WHERE m.role = 'owner' LIMIT 1
), ins AS (
  INSERT INTO platform.sessions (user_id, token_hash, csrf_hash, expires_at)
  SELECT owner.user_id, :'token_hash', :'csrf_hash', now() + make_interval(hours => :'hours'::int) FROM owner
  RETURNING id, user_id
)
SELECT json_build_object('userId', ins.user_id, 'orgId', owner.org_id, 'sessionId', ins.id) FROM ins, owner;`,
    "",
  ].join("\n");
}

/** {userId, orgId, sessionId} from payProbeSessionSql's output; none → the systems are not of one measurement. */
export function parsePayProbeSeed(stdout) {
  const line = String(stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .at(-1);
  if (!line)
    throw new Error("проба оплаты: системы не найдены или не из одной учётки замера — сессия не создана");
  const o = JSON.parse(line);
  for (const k of ["userId", "orgId", "sessionId"])
    if (!UUID.test(o[k] ?? "")) throw new Error(`проба оплаты: нет ${k} в ответе psql`);
  return o;
}

/**
 * The purchase on each system in turn (`pay` — shopPayment bound to the measurement's ctx: the test shop's keys, the
 * browser); → [{systemId, name, payment}]. Never throws: a failure is the system's payment status.
 */
export async function runPayProbe({ client, systemIds, pay, log = () => {} }) {
  const out = [];
  for (const systemId of systemIds) {
    let name = null;
    try {
      name = (await client.get(`/systems/${systemId}`)).body?.name ?? null;
    } catch {}
    const say = (m) => log(`${name ?? systemId}: ${m}`);
    let payment;
    try {
      payment = await pay(client, systemId, say);
    } catch (e) {
      payment = { status: "failed", steps: [{ step: "сбой проверки", ok: false, note: String(e?.message ?? e).slice(0, 300) }] };
    }
    say(`оплата: ${payment.status}`);
    out.push({ systemId, name, payment });
  }
  return out;
}

const STATUS_RU = {
  paid: "оплачено ✅",
  failed: "не оплачено ❌",
  skipped: "не проверялась",
  refused: "отказ",
  keys_only: "только ключи",
};

/** The report of the check (Markdown) and its summary {paid, total, passed}. */
export function renderPayProbeReport(results, { date, runid, platform, notes = [] } = {}) {
  const paid = results.filter((r) => r.payment?.status === "paid").length;
  const L = [
    `# Проба оплаты магазинов v3 — ${date ?? ""}${runid ? ` (${runid})` : ""}`,
    "",
    `Платформа: ${platform ?? "—"}. Покупка посетителя на превью черновика и оплата тестовой картой в тестовом магазине ЮKassa основателя, без новой сборки и без вызовов моделей.`,
    "",
    `**Оплачено: ${paid} из ${results.length}.**`,
    "",
  ];
  for (const r of results) {
    L.push(`## ${r.name ?? r.systemId}`, "", `- Система: \`${r.systemId}\``);
    L.push(`- Оплата: ${STATUS_RU[r.payment?.status] ?? r.payment?.status ?? "—"}${r.payment?.note ? ` — ${r.payment.note}` : ""}`);
    if (r.payment?.orderStatus) L.push(`- Статус заказа: «${r.payment.orderStatus}»`);
    for (const s of r.payment?.steps ?? []) L.push(`  - ${s.ok ? "✅" : "❌"} ${s.step}${s.note ? ` — ${s.note}` : ""}`);
    L.push("");
  }
  for (const n of notes) L.push(`- ${n}`);
  return {
    text: `${L.join("\n").trimEnd()}\n`,
    summary: { paid, total: results.length, passed: results.length > 0 && paid === results.length },
  };
}

/** One annotation per system: notice when paid, error with the failed step otherwise. */
export function payProbeAnnotations(results) {
  return results.map((r) => {
    const name = r.name ?? r.systemId;
    if (r.payment?.status === "paid")
      return `::notice title=Оплата · ${name}::оплачено тестовой картой, статус заказа «${r.payment.orderStatus ?? "—"}»`;
    const bad = (r.payment?.steps ?? []).find((s) => !s.ok);
    const why = bad ? `${bad.step}${bad.note ? ` — ${bad.note}` : ""}` : (r.payment?.note ?? r.payment?.status ?? "—");
    return `::error title=Оплата · ${name}::${String(why).replace(/\r?\n/g, " ").slice(0, 600)}`;
  });
}

/**
 * The final report with the check (cli.mjs final --pay): the payment of the measurement's results replaced by the
 * check's on the same system (by id; `recheck` — the check's run, `before` — the measurement's own status) and the
 * readiness judged again by the measurement's rule (isReadyV3 with its G2 mode). Other results stay as they are.
 */
export function applyPayProbe(results, probe, { runid = null, g2 = "publish" } = {}) {
  const by = new Map((probe ?? []).map((p) => [p.systemId, p.payment]));
  return results.map((r) => {
    const p = r.systemId ? by.get(r.systemId) : undefined;
    if (!p) return r;
    const next = { ...r, payment: { ...p, recheck: runid ?? true, before: r.payment?.status ?? null } };
    if (!["ready", "not_ready"].includes(r.status)) return next;
    const ready = isReadyV3(next, g2);
    return { ...next, ready, status: ready ? "ready" : "not_ready" };
  });
}
