// Pilot PostgreSQL operations (infra/postgres/pg-ops.mjs): archive health, base backups with retention, the weekly
// restore drill. Pure parts always; the full drill against a real throwaway cluster when WALG_BIN (wal-g for
// PostgreSQL) and the PostgreSQL 16 binaries exist — WAL-G stores into a local directory (WALG_FILE_PREFIX), so nothing
// leaves the machine. As root (dev containers) the cluster runs as the "postgres" user, like scripts/db.mjs.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alertText,
  archiveStatus,
  asUser,
  basebackup,
  bootstrap,
  bootstrapConf,
  compareCounts,
  config,
  createReporter,
  createThrottle,
  drillConf,
  evaluate,
  logLine,
  metricsText,
  mismatchReason,
  parseBackupList,
  psql,
  restoreDrill,
  retentionCutoff,
  syncArgs,
} from "../../../infra/postgres/pg-ops.mjs";

const HOUR = 3600;
const base = {
  now: 1_800_000_000,
  archiveMode: "on",
  ready: 0,
  oldestReady: null,
  lastArchived: 1_800_000_000 - 30,
  lastFailed: null,
  failedCount: 0,
  lastBackupOk: 1_800_000_000 - 3 * HOUR,
  lastDrillOk: 1_800_000_000 - 50 * HOUR,
};

describe("pg-ops: evaluation and reporting", () => {
  const cfg = config({});

  it("defaults: lag 5 min, base backup 26 h, drill 8 days, 14 days retention, schema platform", () => {
    expect(cfg).toMatchObject({
      maxArchiveLagSec: 300,
      maxBackupAgeH: 26,
      maxDrillAgeH: 192,
      retentionDays: 14,
      schemas: ["platform"],
    });
    expect(() => config({ WIZARD_DRILL_SCHEMAS: "platform,x;drop" })).toThrow(/bad schema/);
    expect(() => config({ WIZARD_ARCHIVE_MAX_LAG_SEC: "-1" })).toThrow(/bad/);
  });

  it("healthy archive: nothing waits, backups and drills fresh", () => {
    expect(evaluate(base, cfg)).toEqual({ ok: true, lagSec: 0, ready: 0, problems: [] });
  });

  it("lag = age of the oldest segment waiting; > 5 min alerts; failures after the last success alert", () => {
    const waiting = { ...base, ready: 3, oldestReady: base.now - 301 };
    const ev = evaluate(waiting, cfg);
    expect(ev.lagSec).toBe(301);
    expect(ev.problems.map((p) => p.msg)).toEqual(["walg_archive_lag"]);
    expect(evaluate({ ...waiting, oldestReady: base.now - 200 }, cfg).ok).toBe(true);
    const failing = {
      ...base,
      ready: 1,
      oldestReady: base.now - 10,
      lastFailed: base.now - 5,
      failedCount: 7,
    };
    expect(evaluate(failing, cfg).problems).toEqual([{ msg: "walg_archive_failing", reason: "ошибок 7" }]);
    // An old failure followed by successful archiving is history, not a problem.
    expect(evaluate({ ...base, lastFailed: base.now - 100, failedCount: 1 }, cfg).ok).toBe(true);
    expect(evaluate({ ...base, archiveMode: "off" }, cfg).problems[0].msg).toBe("walg_archive_failing");
  });

  it("stale base backup (> 26 h) and drill (> 8 days); a fresh cluster gets the grace period from `since`", () => {
    const stale = { ...base, lastBackupOk: base.now - 27 * HOUR, lastDrillOk: base.now - 9 * 24 * HOUR };
    expect(evaluate(stale, cfg).problems.map((p) => p.msg)).toEqual([
      "walg_backup_stale",
      "pg_restore_drill_stale",
    ]);
    const fresh = { ...base, lastBackupOk: null, lastDrillOk: null };
    expect(evaluate(fresh, cfg, base.now - HOUR).ok).toBe(true);
    expect(evaluate(fresh, cfg, base.now - 27 * HOUR).problems[0]).toEqual({
      msg: "walg_backup_stale",
      reason: "ни одной",
    });
  });

  it("alerts are throttled per kind (1 h) and a recovery is reported once", () => {
    const t = createThrottle(3600);
    const p = [{ msg: "walg_archive_lag" }];
    expect(t(p, 0).fire).toHaveLength(1);
    expect(t(p, 60).fire).toHaveLength(0);
    expect(t(p, 3600).fire).toHaveLength(1);
    expect(t([], 3700).recovered).toEqual(["walg_archive_lag"]);
    expect(t([], 3800).recovered).toEqual([]);
  });

  it("log lines have the platform logger shape and only allowlisted fields; alert text is Russian", async () => {
    const line = JSON.parse(
      logLine("error", "walg_archive_lag", {
        reason: "3 сегм.",
        count: 3,
        password: "x",
        dsn: "postgres://",
      }),
    );
    expect(Object.keys(line).sort()).toEqual(["count", "level", "msg", "reason", "svc", "ts"]);
    expect(line).toMatchObject({ level: "error", svc: "pg-ops", msg: "walg_archive_lag" });
    expect(alertText("walg_archive_lag", { reason: "3 сегм., 400 с" }, "prod")).toBe(
      "Wizard (prod): архив WAL отстаёт. 3 сегм., 400 с",
    );
    const out = [];
    const posted = [];
    const rep = createReporter(
      { alertUrl: "https://alerts.example/hook", alertChatId: "-100", envName: "prod" },
      (s) => out.push(s),
      async (url, init) => {
        posted.push({ url, body: JSON.parse(init.body) });
        return { ok: true };
      },
    );
    rep.info("walg_backup_ok", { durationMs: 5 });
    await rep.error("pg_restore_drill_failed", { step: "verify", reason: "platform.users 3≠2" });
    expect(out.map((s) => JSON.parse(s).level)).toEqual(["info", "error"]);
    expect(posted).toEqual([
      {
        url: "https://alerts.example/hook",
        body: { chat_id: "-100", text: "Wizard (prod): учение восстановления не прошло. platform.users 3≠2" },
      },
    ]);
  });

  it("metrics: lag, waiting segments, last backup and drill, overall health", () => {
    const text = metricsText({ ...base, ready: 2 }, { ok: false, lagSec: 12 });
    expect(text).toContain("wizard_pg_archive_lag_seconds 12\n");
    expect(text).toContain("wizard_pg_archive_ready_segments 2\n");
    expect(text).toContain(`wizard_pg_last_basebackup_timestamp_seconds ${base.lastBackupOk}\n`);
    expect(text).toContain("wizard_pg_ops_healthy 0\n");
    expect(metricsText(null, {})).toContain("wizard_pg_up 0");
  });

  it("row-count comparison: exact per table; reasons name tables only", () => {
    const live = { "platform.users": 3, "platform.orgs": 1 };
    expect(compareCounts(live, { "platform.users": 3, "platform.orgs": 1 })).toMatchObject({
      ok: true,
      tables: 2,
      rows: 4,
    });
    const bad = compareCounts(live, { "platform.users": 2, "platform.extra": 0 });
    expect(bad.ok).toBe(false);
    expect(mismatchReason(bad)).toBe(
      "нет таблиц: platform.orgs; лишние таблицы: platform.extra; platform.users 3≠2",
    );
    expect(compareCounts({}, {}).ok).toBe(false);
  });

  it("drill server: replays to the named restore point, promotes, never archives, socket only", () => {
    const conf = drillConf({ walg: "wal-g", drillPort: 5499 }, "wz-drill-1", "/drill/run/sock");
    expect(conf).toContain(`restore_command = 'wal-g wal-fetch "%f" "%p"'`);
    expect(conf).toContain("recovery_target_name = 'wz-drill-1'");
    expect(conf).toContain("recovery_target_action = 'promote'");
    expect(conf).toContain("archive_mode = 'off'");
    expect(conf).toContain("listen_addresses = ''");
    expect(retentionCutoff(new Date("2026-10-15T03:00:00.123Z"), 14)).toBe("2026-10-01T03:00:00Z");
    expect(asUser({ runAs: "postgres" }, "psql", ["-c", "x"])).toEqual([
      "runuser",
      ["-u", "postgres", "--", "psql", "-c", "x"],
    ]);
    expect(asUser({ runAs: "" }, "psql", [])).toEqual(["psql", []]);
  });

  it("bootstrap of a lost volume replays the whole archive; backup lists; .data copy never deletes remotely", () => {
    expect(bootstrapConf({ walg: "wal-g" })).toContain("recovery_target_timeline = 'latest'");
    expect(bootstrapConf({ walg: "wal-g" })).not.toContain("recovery_target_name");
    expect(parseBackupList("")).toEqual([]);
    expect(parseBackupList("null\n")).toEqual([]);
    expect(parseBackupList('[{"backup_name":"base_000000010000000000000004"}]')).toHaveLength(1);
    expect(() => parseBackupList("{}")).toThrow(/неожиданный/);
    expect(syncArgs("/app/.data", true)).toEqual(
      expect.arrayContaining(["copy", "/app/.data", "enc:", "--max-age", "15m", "--no-traverse"]),
    );
    expect(syncArgs("/app/.data", false)).not.toContain("--max-age");
    for (const a of [syncArgs("/d", true), syncArgs("/d", false)]) {
      expect(a).not.toContain("sync");
      expect(a.join(" ")).not.toMatch(/--delete|purge/);
    }
  });
});

// ---------------------------------------------------------------- real cluster + wal-g (file storage)

const WALG = process.env.WALG_BIN;
const PG_BIN = process.env.PG_BIN ?? "/usr/lib/postgresql/16/bin";
const ROOT_USER = process.getuid?.() === 0;
const runnable = !!WALG && existsSync(join(PG_BIN, "pg_ctl"));

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

describe.skipIf(!runnable)("pg-ops against a throwaway cluster with WAL-G (WALG_BIN)", () => {
  // Created in beforeAll: the body of a skipped describe still runs, its hooks do not.
  let dir = "";
  const saved = { ...process.env };
  let cfg;
  let pgdata;
  const out = [];
  const rep = createReporter({ alertUrl: "" }, (s) => out.push(JSON.parse(s)));
  const sh = (cmd, args, opts = {}) => {
    const [c, a] = asUser(cfg, cmd, args);
    const r = spawnSync(c, a, { encoding: "utf8", ...opts });
    if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}${r.stdout}`);
    return r.stdout;
  };
  const sql = (q, db = "wizard") => psql(cfg, { db }, q);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "wz-pgops-"));
    chmodSync(dir, 0o755);
    if (ROOT_USER) spawnSync("chown", ["postgres", dir]);
    const port = await freePort();
    pgdata = join(dir, "src");
    // The binary may sit in a directory the postgres user cannot traverse.
    const walg = join(dir, "wal-g");
    copyFileSync(WALG, walg);
    chmodSync(walg, 0o755);
    Object.assign(process.env, {
      WALG_FILE_PREFIX: join(dir, "store"),
      WALG_LIBSODIUM_KEY: randomBytes(32).toString("hex"),
      WALG_LIBSODIUM_KEY_TRANSFORM: "hex",
      WALG_COMPRESSION_METHOD: "zstd",
      PGHOST: join(dir, "sock"),
      PGPORT: String(port),
      PGUSER: "wizard",
      PGDATABASE: "wizard",
    });
    cfg = {
      ...config({
        PG_BIN,
        WALG_BIN: walg,
        PGDATA: pgdata,
        WIZARD_DRILL_DIR: join(dir, "drill"),
        WIZARD_DRILL_PORT: String(await freePort()),
        WIZARD_DRILL_ARCHIVE_WAIT_SEC: "60",
        WIZARD_DRILL_TIMEOUT_SEC: "120",
      }),
      runAs: ROOT_USER ? "postgres" : "",
    };
    sh("mkdir", ["-p", join(dir, "sock"), join(dir, "store")]);
    sh(join(PG_BIN, "initdb"), [
      "-D",
      pgdata,
      "-U",
      "wizard",
      "--auth=trust",
      "-E",
      "UTF8",
      "--no-instructions",
    ]);
    const conf = [
      "listen_addresses = ''",
      `port = ${port}`,
      `unix_socket_directories = '${join(dir, "sock")}'`,
      "wal_level = replica",
      "archive_mode = on",
      `archive_command = '${walg} wal-push "%p"'`,
      "archive_timeout = 60",
      "shared_buffers = '32MB'",
    ].join("\n");
    sh("sh", ["-c", `printf '%s\\n' "$1" >> "$2"`, "sh", conf, join(pgdata, "postgresql.auto.conf")]);
    sh(join(PG_BIN, "pg_ctl"), ["-D", pgdata, "-l", join(dir, "src.log"), "-w", "start"]);
    psql(cfg, { db: "postgres" }, "CREATE DATABASE wizard;");
    sql(`CREATE SCHEMA platform;
CREATE TABLE platform.users (id serial PRIMARY KEY, email text NOT NULL);
CREATE TABLE platform.runs (id bigserial PRIMARY KEY, status text NOT NULL);
CREATE TABLE platform.empty_one (id int);
INSERT INTO platform.users (email) SELECT 'u' || g || '@example.test' FROM generate_series(1, 120) AS g;
INSERT INTO platform.runs (status) SELECT 'done' FROM generate_series(1, 40);
CREATE SCHEMA app_other;
CREATE TABLE app_other.t (id int);`);
  }, 120_000);

  afterAll(() => {
    if (pgdata) spawnSync(...asUser(cfg, join(PG_BIN, "pg_ctl"), ["-D", pgdata, "-m", "immediate", "stop"]));
    process.env = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("base backup to the archive, journal row, retention pass", async () => {
    expect(await basebackup(cfg, rep), JSON.stringify(out.at(-1))).toBe(0);
    expect(
      readdirSync(join(dir, "store", "basebackups_005")).some((f) =>
        f.endsWith("_backup_stop_sentinel.json"),
      ),
    ).toBe(true);
    expect(out.at(-1)).toMatchObject({ level: "info", msg: "walg_backup_ok" });
    expect(sql(`SELECT count(*) FROM wizard_ops.ops_runs WHERE kind = 'basebackup' AND ok;`)).toBe("1");
  }, 120_000);

  it("restore drill: writes after the base backup come back through WAL replay, counts equal table by table", async () => {
    // Changes after the base backup exist only in the WAL archive.
    sql(`INSERT INTO platform.users (email) SELECT 'late' || g || '@example.test' FROM generate_series(1, 37) AS g;
DELETE FROM platform.runs WHERE id <= 5;`);
    // Rows written after the restore point (the drill is running) must not be in the restored database.
    const afterSnapshot = () =>
      sql(
        "INSERT INTO platform.users (email) SELECT 'after' || g || '@example.test' FROM generate_series(1, 5) AS g;",
      );
    const r = await restoreDrill(cfg, rep, { live: {}, user: "wizard", db: "wizard", afterSnapshot });
    expect(r, JSON.stringify(out.at(-1))).toMatchObject({ ok: true, tables: 3, rows: 157 + 35 });
    expect(out.at(-1)).toMatchObject({ level: "info", msg: "pg_restore_drill_ok", count: 3 });
    expect(existsSync(join(dir, "drill", "run"))).toBe(false);
    const s = archiveStatus(cfg);
    expect(s.lastBackupOk).toBeGreaterThan(0);
    expect(s.lastDrillOk).toBeGreaterThan(0);
    expect(evaluate(s, cfg).ok).toBe(true);
  }, 240_000);

  it("a broken archive is detected: lag alert, failing archiver, and the drill fails at the archive step", async () => {
    sql(`ALTER SYSTEM SET archive_command = 'false'; SELECT pg_reload_conf();`, "postgres");
    await new Promise((r) => setTimeout(r, 500));
    sql("INSERT INTO platform.users (email) VALUES ('x@example.test'); SELECT pg_switch_wal();");
    await new Promise((r) => setTimeout(r, 2500));
    const s = archiveStatus(cfg);
    expect(s.ready).toBeGreaterThanOrEqual(1);
    const ev = evaluate(s, { ...cfg, maxArchiveLagSec: 0 });
    expect(s.lastFailed, JSON.stringify(s)).toBeGreaterThan(0);
    expect(ev.problems.map((p) => p.msg)).toEqual(
      expect.arrayContaining(["walg_archive_lag", "walg_archive_failing"]),
    );
    const r = await restoreDrill({ ...cfg, archiveWaitSec: 3 }, rep, {
      live: {},
      user: "wizard",
      db: "wizard",
      sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 500))),
    });
    expect(r).toMatchObject({ ok: false, step: "archive" });
    expect(out.at(-1)).toMatchObject({ level: "error", msg: "pg_restore_drill_failed", step: "archive" });
    expect(sql(`SELECT count(*) FROM wizard_ops.ops_runs WHERE kind = 'restore-drill' AND NOT ok;`)).toBe(
      "1",
    );
  }, 120_000);

  it("bootstrap: an empty archive means first bring-up (initdb); an unreachable one stops the pod", async () => {
    const empty = join(dir, "empty-store");
    sh("mkdir", ["-p", empty]);
    const prefix = process.env.WALG_FILE_PREFIX;
    process.env.WALG_FILE_PREFIX = empty;
    try {
      expect(await bootstrap({ ...cfg, pgdata: join(dir, "fresh") }, rep)).toBe("initdb");
      expect(await bootstrap({ ...cfg, pgdata }, rep)).toBe("existing");
      process.env.WALG_FILE_PREFIX = "";
      await expect(bootstrap({ ...cfg, pgdata: join(dir, "fresh") }, rep)).rejects.toThrow(
        /архив недоступен/,
      );
      expect(out.at(-1)).toMatchObject({ level: "error", msg: "pg_bootstrap_failed" });
    } finally {
      process.env.WALG_FILE_PREFIX = prefix;
    }
  }, 60_000);

  it("bootstrap: a lost volume comes back from the latest base backup plus every archived segment", async () => {
    sql(
      `ALTER SYSTEM SET archive_command = '${cfg.walg} wal-push "%p"'; SELECT pg_reload_conf();`,
      "postgres",
    );
    sql("INSERT INTO platform.runs (status) VALUES ('after-drill');");
    const want = JSON.parse(
      sql(`SELECT json_build_object('u', (SELECT count(*) FROM platform.users),
      'r', (SELECT count(*) FROM platform.runs));`),
    );
    const wal = sql("SELECT pg_walfile_name(pg_current_wal_lsn()); SELECT pg_switch_wal();").split("\n")[0];
    for (let i = 0; i < 60; i++) {
      if (sql("SELECT COALESCE(last_archived_wal, '') FROM pg_stat_archiver;") >= wal) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const rebuilt = join(dir, "rebuilt");
    expect(await bootstrap({ ...cfg, pgdata: rebuilt }, rep)).toBe("restored");
    expect(out.at(-1)).toMatchObject({ level: "error", msg: "pg_restored_from_archive" });
    const port = String(await freePort());
    sh(join(PG_BIN, "pg_ctl"), [
      "-D",
      rebuilt,
      "-l",
      join(dir, "rebuilt.log"),
      "-o",
      `-p ${port} -c archive_mode=off`,
      "-w",
      "start",
    ]);
    try {
      let got = null;
      for (let i = 0; i < 120 && !got; i++) {
        const r = spawnSync(
          ...asUser(cfg, "psql", [
            "-X",
            "-A",
            "-t",
            "-p",
            port,
            "-d",
            "wizard",
            "-c",
            "SELECT CASE WHEN pg_is_in_recovery() THEN '' ELSE json_build_object('u', (SELECT count(*) FROM platform.users), 'r', (SELECT count(*) FROM platform.runs))::text END;",
          ]),
          { encoding: "utf8" },
        );
        if (r.status === 0 && r.stdout.trim()) got = JSON.parse(r.stdout.trim());
        else await new Promise((res) => setTimeout(res, 500));
      }
      expect(got).toEqual(want);
    } finally {
      spawnSync(...asUser(cfg, join(PG_BIN, "pg_ctl"), ["-D", rebuilt, "-m", "immediate", "stop"]));
    }
  }, 120_000);
});

describe("pg-ops bootstrap: first bring-up", () => {
  it("never asks the archive while nothing was released (WIZARD_PG_FIRST_BOOT)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pgops-first-"));
    const infos = [];
    const rep = { info: (m) => infos.push(m), error: async () => {} };
    try {
      const cfg = { walg: join(dir, "no-such-wal-g"), pgdata: join(dir, "pgdata"), firstBoot: true };
      expect(await bootstrap(cfg, rep)).toBe("initdb");
      expect(infos).toEqual(["pg_bootstrap_first_boot"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pg-ops bootstrap: a hanging archive", () => {
  it("fails with a reason after archiveProbeTimeoutSec instead of hanging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pgops-hang-"));
    const walg = join(dir, "wal-g");
    writeFileSync(walg, "#!/bin/sh\necho 'dial tcp: i/o timeout, retrying' >&2\nsleep 30\n", { mode: 0o755 });
    const events = [];
    const rep = { info: () => {}, error: async (msg, data) => events.push({ msg, ...data }) };
    try {
      await expect(
        bootstrap({ walg, pgdata: join(dir, "pgdata"), archiveProbeTimeoutSec: 1 }, rep),
      ).rejects.toThrow(/архив недоступен/);
      expect(events.at(-1)).toMatchObject({ msg: "pg_bootstrap_failed", step: "backup-list" });
      expect(events.at(-1).reason).toMatch(/нет ответа за 1 с.*i\/o timeout/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
