#!/usr/bin/env node
// Operations of the self-managed PostgreSQL of the pilot (docs/ops/deploy.md «Пилот», platform/deploy.yaml#pilot):
// WAL-G continuous archiving to S3 is configured on the server itself (archive_command); this script runs next to it.
//   monitor        sidecar loop: WAL archive lag (oldest .ready segment), archiver failures, age of the last base
//                  backup and of the last successful restore drill → structured log + optional alert webhook,
//                  GET /healthz (200 | 503) and GET /metrics (Prometheus text) on WIZARD_PG_OPS_PORT
//   basebackup     wal-g backup-push of PGDATA, then deletes what is older than the retention window
//   restore-drill  restore point under SHARE locks with exact row counts of the verified schemas → wait for its WAL
//                  segment in the archive → wal-g backup-fetch LATEST into a throwaway directory → replay to the
//                  restore point → promote → compare row counts table by table → report; the throwaway PG is removed
//   bootstrap      init container: an empty data directory is restored from the archive (latest base backup + all
//                  WAL), an empty archive means first bring-up (initdb by the image), an unreachable archive stops
//   data-sync      loop: the shared .data volume (revision sources, encrypted connector secrets) → encrypted S3 copy
//   data-restore   one-off: the encrypted copy back into .data
// No dependencies: psql, pg_ctl, postgres and wal-g from the image (infra/docker/postgres.Dockerfile). Log lines follow
// the platform logger shape ({ts, level, svc, msg, …} with allowlisted fields only, packages/pii log.ts): level error
// is the alert path (docs/ops/deploy.md «Алерты пилота»). Values reach SQL only as psql variables; identifiers only
// through format('%I').
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SVC = "pg-ops";
export const OPS_SCHEMA = "wizard_ops";
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** Settings from the environment (the chart sets them; defaults match platform/deploy.yaml#pilot.postgres). */
export function config(env = process.env) {
  const num = (k, d) => {
    const v = Number(env[k] ?? d);
    if (!Number.isFinite(v) || v < 0) throw new Error(`bad ${k}`);
    return v;
  };
  const schemas = (env.WIZARD_DRILL_SCHEMAS ?? "platform").split(",").filter(Boolean);
  for (const s of schemas) if (!IDENT.test(s)) throw new Error(`bad schema ${s}`);
  return {
    pgBin: env.PG_BIN ?? "/usr/lib/postgresql/16/bin",
    walg: env.WALG_BIN ?? "wal-g",
    pgdata: env.PGDATA ?? "/var/lib/postgresql/data/pgdata",
    maxArchiveLagSec: num("WIZARD_ARCHIVE_MAX_LAG_SEC", 300),
    maxBackupAgeH: num("WIZARD_BACKUP_MAX_AGE_H", 26),
    maxDrillAgeH: num("WIZARD_DRILL_MAX_AGE_H", 192),
    retentionDays: num("WIZARD_BACKUP_RETENTION_DAYS", 14),
    intervalSec: num("WIZARD_PG_OPS_INTERVAL_SEC", 60),
    port: num("WIZARD_PG_OPS_PORT", 9187),
    drillDir: env.WIZARD_DRILL_DIR ?? "/drill",
    drillPort: num("WIZARD_DRILL_PORT", 5499),
    drillTimeoutSec: num("WIZARD_DRILL_TIMEOUT_SEC", 3600),
    // bootstrap: how long `wal-g backup-list` may take before the archive counts as unreachable (a silent network
    // hang kept the first live pod in Init for 15 minutes with nothing in its log, 2026-10-03).
    archiveProbeTimeoutSec: num("WIZARD_ARCHIVE_PROBE_TIMEOUT_SEC", 120),
    archiveWaitSec: num("WIZARD_DRILL_ARCHIVE_WAIT_SEC", 300),
    schemas,
    alertUrl: env.WIZARD_OPS_ALERT_URL ?? "",
    alertChatId: env.WIZARD_OPS_ALERT_CHAT_ID ?? "",
    envName: env.WIZARD_ENV ?? "",
    runAs: env.PG_OPS_RUN_AS ?? "",
  };
}

// ---------------------------------------------------------------- process helpers

/** argv through `runuser -u <user> --` when PG_OPS_RUN_AS is set (local tests as root; never in the image). */
export function asUser(cfg, cmd, args) {
  return cfg.runAs ? ["runuser", ["-u", cfg.runAs, "--", cmd, ...args]] : [cmd, args];
}

function run(cfg, cmd, args, { allowError = false, ...opts } = {}) {
  const [c, a] = asUser(cfg, cmd, args);
  const r = spawnSync(c, a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error && !allowError) throw r.error;
  return r;
}

function must(r, what) {
  if (r.status !== 0)
    throw new OpsError(what, (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" "));
  return r.stdout;
}

export class OpsError extends Error {
  constructor(step, detail) {
    super(`${step}: ${detail}`);
    this.step = step;
  }
}

/**
 * psql with ON_ERROR_STOP; `conn` is {} (PG* environment) or {host, port, user, db}. Returns stdout trimmed.
 * Values only as psql variables (:'name').
 */
export function psql(cfg, conn, sql, vars = {}) {
  const args = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"];
  if (conn.host) args.push("-h", conn.host);
  if (conn.port) args.push("-p", String(conn.port));
  if (conn.user) args.push("-U", conn.user);
  if (conn.db) args.push("-d", conn.db);
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  return must(run(cfg, "psql", args, { input: sql }), "psql").trim();
}

const psqlJson = (cfg, conn, sql, vars) => JSON.parse(psql(cfg, conn, sql, vars) || "null");

// ---------------------------------------------------------------- logging and alerts

const LOG_FIELDS = new Set(["msg", "level", "count", "rows", "durationMs", "reason", "step", "kind", "env"]);

/** One JSON log line in the platform logger shape; unknown fields are dropped, strings capped. */
export function logLine(level, msg, fields = {}, now = new Date()) {
  const line = { ts: now.toISOString(), level, svc: SVC, msg };
  for (const [k, v] of Object.entries(fields)) {
    if (!LOG_FIELDS.has(k) || v === undefined) continue;
    line[k] = typeof v === "string" ? v.slice(0, 300) : v;
  }
  return JSON.stringify(line);
}

/** Russian alert text for the webhook (Telegram-compatible body {chat_id?, text}). */
export function alertText(msg, fields, envName) {
  const where = envName ? ` (${envName})` : "";
  const what = {
    walg_archive_lag: "архив WAL отстаёт",
    walg_archive_failing: "архивирование WAL падает",
    walg_backup_stale: "нет свежей базовой копии",
    walg_backup_failed: "базовая копия не создана",
    pg_restore_drill_failed: "учение восстановления не прошло",
    pg_restore_drill_stale: "учение восстановления давно не проходило",
    pg_unreachable: "PostgreSQL недоступен",
    pg_bootstrap_failed: "PostgreSQL не стартует: архив WAL-G недоступен",
    pg_restored_from_archive: "PostgreSQL восстановлен из архива после потери диска — проверьте данные",
    data_backup_failing: "копия тома .data в S3 не обновляется",
  }[msg];
  return `Wizard${where}: ${what ?? msg}. ${fields.reason ?? ""}`.trim();
}

export function createReporter(cfg, out = (s) => process.stdout.write(`${s}\n`), post = fetch) {
  return {
    info(msg, fields) {
      out(logLine("info", msg, fields));
    },
    async error(msg, fields) {
      out(logLine("error", msg, fields));
      if (!cfg.alertUrl) return;
      const body = { text: alertText(msg, fields, cfg.envName) };
      if (cfg.alertChatId) body.chat_id = cfg.alertChatId;
      try {
        const r = await post(cfg.alertUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) out(logLine("warn", "ops_alert_not_delivered", { code: r.status }));
      } catch (e) {
        out(logLine("warn", "ops_alert_not_delivered", { reason: e instanceof Error ? e.name : "error" }));
      }
    },
  };
}

// ---------------------------------------------------------------- run journal (wizard_ops.ops_runs)

const JOURNAL_DDL = `CREATE SCHEMA IF NOT EXISTS ${OPS_SCHEMA};
CREATE TABLE IF NOT EXISTS ${OPS_SCHEMA}.ops_runs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  ok boolean NOT NULL,
  at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  detail text NOT NULL DEFAULT ''
);`;

/** Records the outcome of a base backup or a drill in the live database (read by `monitor`). */
export function journal(cfg, conn, kind, ok, detail = "") {
  psql(
    cfg,
    conn,
    `${JOURNAL_DDL}
INSERT INTO ${OPS_SCHEMA}.ops_runs (kind, ok, detail) VALUES (:'kind', :'ok'::boolean, :'detail');`,
    { kind, ok: ok ? "true" : "false", detail: detail.slice(0, 300) },
  );
}

// ---------------------------------------------------------------- monitor

/** Archiver state, WAL segments waiting for archiving and the journal, as one JSON object. */
export function archiveStatus(cfg, conn = {}) {
  return psqlJson(
    cfg,
    conn,
    `${JOURNAL_DDL}
WITH ready AS (
  SELECT (pg_catalog.pg_stat_file('pg_wal/archive_status/' || f.name)).modification AS at
  FROM pg_catalog.pg_ls_dir('pg_wal/archive_status') AS f(name)
  WHERE f.name LIKE '%.ready'
)
SELECT pg_catalog.json_build_object(
  'now', pg_catalog.date_part('epoch', pg_catalog.now()),
  'archiveMode', pg_catalog.current_setting('archive_mode'),
  'archiveTimeout', pg_catalog.current_setting('archive_timeout'),
  'inRecovery', pg_catalog.pg_is_in_recovery(),
  'ready', (SELECT pg_catalog.count(*) FROM ready),
  'oldestReady', (SELECT pg_catalog.date_part('epoch', pg_catalog.min(ready.at)) FROM ready),
  'archivedCount', a.archived_count,
  'lastArchivedWal', a.last_archived_wal,
  'lastArchived', pg_catalog.date_part('epoch', a.last_archived_time),
  'failedCount', a.failed_count,
  'lastFailed', pg_catalog.date_part('epoch', a.last_failed_time),
  'lastBackupOk', (SELECT pg_catalog.date_part('epoch', pg_catalog.max(r.at)) FROM ${OPS_SCHEMA}.ops_runs AS r
                   WHERE r.kind = 'basebackup' AND r.ok),
  'lastDrillOk', (SELECT pg_catalog.date_part('epoch', pg_catalog.max(r.at)) FROM ${OPS_SCHEMA}.ops_runs AS r
                  WHERE r.kind = 'restore-drill' AND r.ok)
)
FROM pg_catalog.pg_stat_archiver AS a;`,
  );
}

/**
 * Health of continuous archiving from archiveStatus(): lag = age of the oldest completed WAL segment not yet archived
 * (0 when none waits; the open segment is closed by archive_timeout, so committed data is at most lag +
 * archive_timeout old in the archive). Base backup and drill ages are checked once the server has a history
 * (`since`: start of monitoring, so a fresh cluster does not alert before its first backup is due).
 */
export function evaluate(s, cfg, since = s.now) {
  const problems = [];
  const lagSec = s.ready > 0 && s.oldestReady ? Math.max(0, s.now - s.oldestReady) : 0;
  if (s.archiveMode !== "on" && s.archiveMode !== "always") {
    problems.push({ msg: "walg_archive_failing", reason: `archive_mode=${s.archiveMode}` });
  }
  if (lagSec > cfg.maxArchiveLagSec) {
    problems.push({ msg: "walg_archive_lag", reason: `${s.ready} сегм., ${Math.round(lagSec)} с` });
  }
  if (s.lastFailed && (!s.lastArchived || s.lastFailed > s.lastArchived) && s.ready > 0) {
    problems.push({ msg: "walg_archive_failing", reason: `ошибок ${s.failedCount}` });
  }
  const ageH = (t) => (s.now - t) / 3600;
  const backupRef = s.lastBackupOk ?? since;
  if (ageH(backupRef) > cfg.maxBackupAgeH) {
    problems.push({
      msg: "walg_backup_stale",
      reason: s.lastBackupOk ? `${Math.round(ageH(s.lastBackupOk))} ч` : "ни одной",
    });
  }
  const drillRef = s.lastDrillOk ?? since;
  if (ageH(drillRef) > cfg.maxDrillAgeH) {
    problems.push({
      msg: "pg_restore_drill_stale",
      reason: s.lastDrillOk ? `${Math.round(ageH(s.lastDrillOk))} ч` : "ни одного",
    });
  }
  return { ok: problems.length === 0, lagSec, ready: s.ready, problems };
}

/** Prometheus text of the last evaluation (scraped by VictoriaMetrics through the pod annotations). */
export function metricsText(s, ev) {
  const g = (name, help, v) =>
    v === null || v === undefined ? "" : `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${v}\n`;
  if (!s) return g("wizard_pg_up", "PostgreSQL answers the monitor", 0);
  return [
    g("wizard_pg_up", "PostgreSQL answers the monitor", 1),
    g("wizard_pg_archive_lag_seconds", "Age of the oldest WAL segment waiting for archiving", ev.lagSec),
    g("wizard_pg_archive_ready_segments", "WAL segments waiting for archiving", s.ready),
    g("wizard_pg_archive_failed_total", "Failed archive_command runs since stats reset", s.failedCount),
    g("wizard_pg_last_basebackup_timestamp_seconds", "Last successful base backup", s.lastBackupOk),
    g("wizard_pg_last_restore_drill_timestamp_seconds", "Last successful restore drill", s.lastDrillOk),
    g("wizard_pg_ops_healthy", "1 when no archive/backup/drill problem", ev.ok ? 1 : 0),
  ].join("");
}

/** Alerts at most once per `everySec` per problem kind; a recovery is logged once. */
export function createThrottle(everySec = 3600) {
  const last = new Map();
  return (problems, now) => {
    const fire = [];
    const active = new Set(problems.map((p) => p.msg));
    for (const p of problems) {
      const t = last.get(p.msg);
      if (t === undefined || now - t >= everySec) {
        fire.push(p);
        last.set(p.msg, now);
      }
    }
    const recovered = [...last.keys()].filter((k) => !active.has(k));
    for (const k of recovered) last.delete(k);
    return { fire, recovered };
  };
}

async function monitor(cfg, rep) {
  const throttle = createThrottle();
  const since = Date.now() / 1000;
  let state = { s: null, ev: { ok: false, lagSec: 0, problems: [] } };
  const tick = async () => {
    try {
      const s = archiveStatus(cfg);
      const ev = evaluate(s, cfg, since);
      state = { s, ev };
      const { fire, recovered } = throttle(ev.problems, s.now);
      for (const p of fire) await rep.error(p.msg, { reason: p.reason, count: ev.ready });
      for (const k of recovered) rep.info(`${k}_recovered`, {});
      rep.info("pg_ops_tick", { count: ev.ready, durationMs: Math.round(ev.lagSec * 1000) });
    } catch (e) {
      state = { s: null, ev: { ok: false, lagSec: 0, problems: [] } };
      const { fire } = throttle([{ msg: "pg_unreachable" }], Date.now() / 1000);
      if (fire.length)
        await rep.error("pg_unreachable", { reason: e instanceof OpsError ? e.step : "error" });
    }
  };
  createServer((req, res) => {
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(metricsText(state.s, state.ev));
    } else if (req.url === "/healthz") {
      res.writeHead(state.ev.ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: state.ev.ok, lagSec: Math.round(state.ev.lagSec) }));
    } else {
      res.writeHead(404).end();
    }
  }).listen(cfg.port, "0.0.0.0");
  await tick();
  setInterval(tick, cfg.intervalSec * 1000);
}

// ---------------------------------------------------------------- base backup

/** RFC 3339 UTC time `days` before `now` (argument of `wal-g delete before FIND_FULL`). */
export function retentionCutoff(now, days) {
  return new Date(now.getTime() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function basebackup(cfg, rep, now = new Date()) {
  const t0 = Date.now();
  try {
    must(run(cfg, cfg.walg, ["backup-push", cfg.pgdata]), "backup-push");
    // Keeps the full backup preceding the cutoff and every WAL after it: any point of the last N days stays restorable.
    must(
      run(cfg, cfg.walg, [
        "delete",
        "before",
        "FIND_FULL",
        retentionCutoff(now, cfg.retentionDays),
        "--confirm",
      ]),
      "delete",
    );
    journal(cfg, {}, "basebackup", true);
    rep.info("walg_backup_ok", { durationMs: Date.now() - t0 });
    return 0;
  } catch (e) {
    const step = e instanceof OpsError ? e.step : "error";
    try {
      journal(cfg, {}, "basebackup", false, step);
    } catch {
      // the database may be the reason; the log line below is the signal
    }
    await rep.error("walg_backup_failed", { step, reason: String(e.message ?? e).slice(0, 200) });
    return 1;
  }
}

// ---------------------------------------------------------------- restore drill

/** Row counts of every base table of `schemas` as JSON {"schema.table": n} (SQL fragment, no locks). */
export function countsSql(schemas) {
  const list = schemas.map((s) => `'${s}'`).join(", "); // validated identifiers
  return `SELECT COALESCE(pg_catalog.json_object_agg(t.table_schema || '.' || t.table_name, (
    pg_catalog.xpath('/row/c/text()', pg_catalog.query_to_xml(
      pg_catalog.format('SELECT pg_catalog.count(*) AS c FROM %I.%I', t.table_schema, t.table_name), false, true, ''))
  )[1]::text::bigint ORDER BY t.table_schema, t.table_name), '{}'::json)
FROM information_schema.tables AS t
WHERE t.table_schema IN (${list}) AND t.table_type = 'BASE TABLE'`;
}

/**
 * Live side of the drill, one transaction: SHARE locks on every verified table (writers wait, never fail; lock_timeout
 * bounds the wait), exact counts, then a named restore point while the locks are held — so the restored database at
 * that point must have exactly these counts.
 */
export function snapshot(cfg, conn, name) {
  const list = cfg.schemas.map((s) => `'${s}'`).join(", ");
  const out = psqlJson(
    cfg,
    conn,
    `BEGIN;
SET LOCAL lock_timeout = '10s';
DO $lock$
DECLARE r record;
BEGIN
  FOR r IN SELECT t.table_schema, t.table_name FROM information_schema.tables AS t
           WHERE t.table_schema IN (${list}) AND t.table_type = 'BASE TABLE'
           ORDER BY t.table_schema, t.table_name LOOP
    EXECUTE pg_catalog.format('LOCK TABLE %I.%I IN SHARE MODE', r.table_schema, r.table_name);
  END LOOP;
END
$lock$;
WITH rp AS (SELECT pg_catalog.pg_create_restore_point(:'name') AS lsn)
SELECT pg_catalog.json_build_object(
  'counts', (${countsSql(cfg.schemas)}),
  'lsn', rp.lsn::text,
  'wal', pg_catalog.pg_walfile_name(rp.lsn)
) FROM rp;
COMMIT;`,
    { name },
  );
  return out;
}

/** Table-by-table comparison of live counts at the restore point with the restored database. */
export function compareCounts(live, restored) {
  const mismatched = [];
  const missing = [];
  for (const [table, n] of Object.entries(live)) {
    if (!(table in restored)) missing.push(table);
    else if (Number(restored[table]) !== Number(n))
      mismatched.push({ table, live: n, restored: restored[table] });
  }
  const extra = Object.keys(restored).filter((t) => !(t in live));
  const rows = Object.values(live).reduce((a, n) => a + Number(n), 0);
  return {
    ok: missing.length === 0 && mismatched.length === 0 && extra.length === 0 && Object.keys(live).length > 0,
    tables: Object.keys(live).length,
    rows,
    missing,
    mismatched,
    extra,
  };
}

/** One-line reason of a failed comparison (table names only, no values). */
export function mismatchReason(c) {
  if (c.tables === 0) return "нет таблиц для сверки";
  const parts = [];
  if (c.missing.length) parts.push(`нет таблиц: ${c.missing.slice(0, 5).join(", ")}`);
  if (c.extra.length) parts.push(`лишние таблицы: ${c.extra.slice(0, 5).join(", ")}`);
  for (const m of c.mismatched.slice(0, 5)) parts.push(`${m.table} ${m.live}≠${m.restored}`);
  return parts.join("; ");
}

/** Recovery settings of the throwaway server: replay from the archive to the restore point, never archive itself. */
export function drillConf(cfg, name, sockDir) {
  const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
  return [
    "# restore drill (pg-ops.mjs) — throwaway server",
    `restore_command = ${q(`${cfg.walg} wal-fetch "%f" "%p"`)}`,
    `recovery_target_name = ${q(name)}`,
    "recovery_target_action = 'promote'",
    "archive_mode = 'off'",
    // Without hot standby the server accepts connections only after promotion, and lower settings than on the
    // primary (max_connections) are allowed.
    "hot_standby = 'off'",
    "listen_addresses = ''",
    `port = ${cfg.drillPort}`,
    `unix_socket_directories = ${q(sockDir)}`,
    "shared_buffers = '128MB'",
    "max_connections = 20",
    "",
  ].join("\n");
}

async function waitFor(check, timeoutSec, what, sleep) {
  const until = Date.now() + timeoutSec * 1000;
  for (;;) {
    const r = check();
    if (r) return r;
    if (Date.now() > until) throw new OpsError(what, `нет за ${timeoutSec} с`);
    await sleep(2000);
  }
}

export async function restoreDrill(cfg, rep, deps = {}) {
  const live = deps.live ?? {};
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const t0 = Date.now();
  const name = `wz-drill-${new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14)}`;
  // A subdirectory: the drill volume's mount point itself cannot be removed.
  const dir = join(cfg.drillDir, "run");
  const pgdata = join(dir, "pgdata");
  const sock = join(dir, "sock");
  const conn = { host: sock, port: cfg.drillPort, user: deps.user ?? process.env.PGUSER, db: deps.db };
  let started = false;
  let step = "snapshot";
  try {
    const snap = snapshot(cfg, live, name);
    deps.afterSnapshot?.();
    step = "archive";
    psql(cfg, live, "SELECT pg_catalog.pg_switch_wal();");
    await waitFor(
      () => {
        const last = psql(
          cfg,
          live,
          "SELECT COALESCE(last_archived_wal, '') FROM pg_catalog.pg_stat_archiver;",
        );
        // WAL file names of one timeline sort lexicographically.
        return last.length === 24 && last >= snap.wal ? last : null;
      },
      cfg.archiveWaitSec,
      "archive",
      sleep,
    );
    step = "fetch";
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(sock, { recursive: true });
    const chown = () => {
      if (cfg.runAs) must(spawnSync("chown", ["-R", cfg.runAs, dir], { encoding: "utf8" }), "chown");
    };
    chown();
    must(run(cfg, cfg.walg, ["backup-fetch", pgdata, "LATEST"]), "backup-fetch");
    chmodSync(pgdata, 0o700);
    writeFileSync(join(pgdata, "recovery.signal"), "");
    appendFileSync(join(pgdata, "postgresql.auto.conf"), drillConf(cfg, name, sock));
    rmSync(join(pgdata, "postmaster.pid"), { force: true });
    chown();
    step = "replay";
    // `pg_ctl -w` returns once the postmaster runs (it counts a recovering server as started). Without hot standby the
    // server accepts connections only after it reached the restore point and promoted; a recovery that stops (target
    // missing from the archive) shuts the server down, which `pg_ctl status` reports.
    started = true;
    const ctl = (args) => run(cfg, join(cfg.pgBin, "pg_ctl"), ["-D", pgdata, ...args]);
    const logFile = join(dir, "server.log");
    if (ctl(["-l", logFile, "-w", "-t", "120", "start"]).status !== 0) {
      throw new OpsError("replay", lastLogLine(logFile));
    }
    const probe = ["-X", "-A", "-t", "-h", sock, "-p", String(cfg.drillPort)];
    if (conn.user) probe.push("-U", conn.user);
    if (conn.db) probe.push("-d", conn.db);
    probe.push("-c", "SELECT pg_catalog.pg_is_in_recovery();");
    await waitFor(
      () => {
        if (ctl(["status"]).status !== 0) throw new OpsError("replay", lastLogLine(logFile));
        const r = run(cfg, "psql", probe);
        return r.status === 0 && r.stdout.trim() === "f";
      },
      cfg.drillTimeoutSec,
      "replay",
      sleep,
    );
    step = "verify";
    const restored = psqlJson(cfg, conn, `${countsSql(cfg.schemas)};`);
    const c = compareCounts(snap.counts, restored);
    stopDrill(cfg, pgdata);
    started = false;
    if (!c.ok) throw new OpsError("verify", mismatchReason(c));
    journal(cfg, live, "restore-drill", true, `${c.tables} tables`);
    rep.info("pg_restore_drill_ok", { count: c.tables, rows: c.rows, durationMs: Date.now() - t0 });
    return { ok: true, ...c };
  } catch (e) {
    const reason = e instanceof OpsError ? e.message : String(e);
    try {
      journal(cfg, live, "restore-drill", false, reason);
    } catch {
      // the log line is the signal
    }
    await rep.error("pg_restore_drill_failed", { step, reason: reason.slice(0, 250) });
    return { ok: false, step, reason };
  } finally {
    if (started) stopDrill(cfg, pgdata);
    if (!deps.keep) rmSync(dir, { recursive: true, force: true });
  }
}

function stopDrill(cfg, pgdata) {
  run(cfg, join(cfg.pgBin, "pg_ctl"), ["-D", pgdata, "-m", "immediate", "-w", "stop"]);
}

function lastLogLine(file) {
  if (!existsSync(file)) return "сервер не запустился";
  const lines = readFileSync(file, "utf8").trim().split("\n");
  const fatal = lines.filter((l) => /FATAL|PANIC/.test(l)).pop() ?? lines.pop() ?? "";
  // Drop the timestamp prefix; the message itself carries no row data.
  return fatal.replace(/^.*?(FATAL|PANIC|LOG|ERROR):\s*/, "$1: ").slice(0, 200);
}

// ---------------------------------------------------------------- bootstrap (init container)

/** Backups in the archive: `wal-g backup-list --json` → array (an empty archive prints nothing or null). */
export function parseBackupList(stdout) {
  const text = stdout.trim();
  if (text === "" || text === "null") return [];
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new OpsError("backup-list", "неожиданный ответ");
  return list;
}

/** Recovery settings of a server rebuilt after the loss of its volume: replay the whole archive, then promote. */
export function bootstrapConf(cfg) {
  return [
    "# restored from the WAL-G archive by pg-ops.mjs bootstrap",
    `restore_command = '${cfg.walg} wal-fetch "%f" "%p"'`,
    "recovery_target_timeline = 'latest'",
    "",
  ].join("\n");
}

/**
 * Init container of the PostgreSQL pod. An existing data directory starts as is. An empty one is restored from the
 * latest base backup plus every archived WAL segment (the VM was re-created: RPO ≈ archive_timeout) — and only when the
 * archive is empty does the image's entrypoint run initdb (first bring-up). An unreachable archive stops the pod:
 * starting an empty database next to an existing archive would hide the data and later overwrite it.
 */
export async function bootstrap(cfg, rep) {
  if (existsSync(join(cfg.pgdata, "PG_VERSION"))) {
    rep.info("pg_bootstrap_existing", {});
    return "existing";
  }
  const limit = cfg.archiveProbeTimeoutSec ?? 120;
  const listed = run(cfg, cfg.walg, ["backup-list", "--json"], {
    timeout: limit * 1000,
    killSignal: "SIGKILL",
    allowError: true,
  });
  if (listed.error || listed.status !== 0) {
    const stderr = (listed.stderr || "").slice(-400);
    await rep.error("pg_bootstrap_failed", {
      step: "backup-list",
      reason: listed.error
        ? `нет ответа за ${limit} с (${listed.error.code ?? listed.error.message}); ${stderr}`
        : stderr,
    });
    throw new OpsError("backup-list", "архив недоступен");
  }
  const backups = parseBackupList(listed.stdout);
  if (backups.length === 0) {
    rep.info("pg_bootstrap_initdb", {});
    return "initdb";
  }
  const t0 = Date.now();
  rmSync(cfg.pgdata, { recursive: true, force: true });
  must(run(cfg, cfg.walg, ["backup-fetch", cfg.pgdata, "LATEST"]), "backup-fetch");
  chmodSync(cfg.pgdata, 0o700);
  writeFileSync(join(cfg.pgdata, "recovery.signal"), "");
  appendFileSync(join(cfg.pgdata, "postgresql.auto.conf"), bootstrapConf(cfg));
  rmSync(join(cfg.pgdata, "postmaster.pid"), { force: true });
  if (cfg.runAs) must(spawnSync("chown", ["-R", cfg.runAs, cfg.pgdata], { encoding: "utf8" }), "chown");
  await rep.error("pg_restored_from_archive", { count: backups.length, durationMs: Date.now() - t0 });
  return "restored";
}

// ---------------------------------------------------------------- shared .data volume → S3 (rclone)

/**
 * rclone arguments of one pass: the encrypted remote `enc:` (rclone crypt over the backups bucket, configured through
 * RCLONE_CONFIG_* in the chart) receives new and changed files; nothing is deleted remotely, so a removed artifact can
 * still be restored. A quick pass looks only at files changed recently (no remote listing).
 */
export function syncArgs(src, quick) {
  const args = ["copy", src, "enc:", "--exclude", "tmp/**", "--exclude", "**/*.tmp", "--transfers", "4"];
  if (quick) args.push("--max-age", "15m", "--no-traverse");
  return args;
}

/**
 * Environment of rclone: the crypt password comes from WIZARD_DATA_BACKUP_KEY and is obscured by rclone itself
 * (stdin, never argv). Without a key nothing is uploaded: the copy is never in plain text.
 */
export function rcloneEnv(cfg, env = process.env) {
  if (env.RCLONE_CONFIG_ENC_PASSWORD) return env;
  if (!env.WIZARD_DATA_BACKUP_KEY) throw new OpsError("rclone", "нет WIZARD_DATA_BACKUP_KEY");
  const r = run(cfg, "rclone", ["obscure", "-"], { input: env.WIZARD_DATA_BACKUP_KEY, env });
  return { ...env, RCLONE_CONFIG_ENC_PASSWORD: must(r, "obscure").trim() };
}

async function dataSync(cfg, rep, env = process.env) {
  const src = env.WIZARD_DATA_DIR ?? "/app/.data";
  const renv = rcloneEnv(cfg, env);
  const every = cfg.intervalSec * 1000;
  let lastFull = 0;
  let failures = 0;
  const throttle = createThrottle();
  for (;;) {
    const quick = Date.now() - lastFull < 24 * 3600 * 1000;
    const t0 = Date.now();
    const r = run(cfg, "rclone", syncArgs(src, quick), { env: renv });
    if (r.status === 0) {
      if (!quick) lastFull = t0;
      failures = 0;
      rep.info("data_backup_ok", { kind: quick ? "quick" : "full", durationMs: Date.now() - t0 });
    } else {
      failures++;
      const { fire } = throttle(failures >= 3 ? [{ msg: "data_backup_failing" }] : [], t0 / 1000);
      if (fire.length)
        await rep.error("data_backup_failing", { count: failures, reason: (r.stderr || "").slice(-200) });
      else rep.info("data_backup_retry", { count: failures });
    }
    await new Promise((res) => setTimeout(res, every));
  }
}

// ---------------------------------------------------------------- entry

export async function main(argv = process.argv.slice(2), env = process.env) {
  const cfg = config(env);
  const rep = createReporter(cfg);
  const [cmd] = argv;
  if (cmd === "monitor") {
    await monitor(cfg, rep);
    return null; // keeps running
  }
  if (cmd === "data-sync") {
    await dataSync(cfg, rep, env);
    return null;
  }
  if (cmd === "bootstrap") {
    await bootstrap(cfg, rep);
    return 0;
  }
  if (cmd === "data-restore") {
    // One-off Job (docs/ops/deploy.md «Пилот: восстановление»): everything of the encrypted copy back into .data.
    const renv = rcloneEnv(cfg, env);
    const dest = env.WIZARD_DATA_DIR ?? "/app/.data";
    must(run(cfg, "rclone", ["copy", "enc:", dest, "--transfers", "4"], { env: renv }), "rclone");
    rep.info("data_restore_ok", {});
    return 0;
  }
  if (cmd === "basebackup") return basebackup(cfg, rep);
  if (cmd === "restore-drill") return (await restoreDrill(cfg, rep)).ok ? 0 : 1;
  throw new Error("command: monitor | basebackup | restore-drill | bootstrap | data-sync | data-restore");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => {
      if (code !== null) process.exit(code);
    },
    (e) => {
      process.stdout.write(`${logLine("error", "pg_ops_failed", { reason: String(e.message ?? e) })}\n`);
      process.exit(2);
    },
  );
}
