// Acceptance M2-05, platform part (security/compliance.yaml#system_package, workflows.yaml#retention_cron and
// #delete_system, L3-33, L3-36): runtime journals _w_deletion_log move into platform.deletion_log (counters only) and are
// listed to the owner; consent withdrawal → notice to the owner; system tables of older schemas are upgraded on the next
// draft migration / publish; a soft-deleted system is purged 30 days later (schemas, messages, imports, secrets,
// artifacts) with deletion_log mode=system_deleted; the runtime retention pass is watched (26 h → alert + request);
// platform clean-ups (OTP, run events, gate reports, message scrub) and the F5 purge of inactive Free drafts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import {
  type FileMeta,
  MemoryFileStorage,
  RETENTION_MARKER_KEY,
  RETENTION_REQUEST_KEY,
} from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { migrateDraft } from "../src/agents/draft.js";
import { upgradeSystemTables } from "../src/agents/system-tables.js";
import { OutboxMailer } from "../src/auth/mailer.js";
import { ImportStore } from "../src/imports/storage.js";
import { runRetentionCron } from "../src/privacy/cron.js";
import { runHousekeeping } from "../src/privacy/housekeeping.js";
import { SecretStore } from "../src/secrets/store.js";
import { startBuild } from "./flow.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";
import { expectContract } from "./session.js";

const forum = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../specs/appspec/examples/forum.json"), "utf8"),
) as AppSpec;
const EDITOR = { "x-wizard-dev-user": "editor-privacy@example.test" };
const STRANGER = { "x-wizard-dev-user": "stranger-privacy@example.test" };
const OPERATOR = {
  operatorName: "ООО «Форум»",
  operatorContact: "privacy@forum.example",
  operatorAddress: "г. Москва, ул. Тверская, д. 1",
};

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let outbox: string;
let mailer: OutboxMailer;
let systemId = "";
let key = "";

const prod = () => `"app_${key}_prod"`;
const draft = () => `"app_${key}_draft"`;

const alerts: { msg: string; fields: Record<string, unknown> }[] = [];
/** Objects of file fields (M2-14): the runtime and retention_cron share this storage. */
const fileStore = new MemoryFileStorage();
const FILE_META: FileMeta = {
  name: "Доклад.pdf",
  mime: "application/pdf",
  size: 5,
  entity: "speaker_application",
  field: "slides",
  uploadedBy: null,
  uploadedAt: "2026-01-01T00:00:00.000Z",
};
async function putFile(schema: string): Promise<string> {
  const key = `${schema}/${crypto.randomUUID()}`;
  await fileStore.put(key, new TextEncoder().encode("%PDF-"), FILE_META);
  return key;
}

function cron(now?: Date) {
  return runRetentionCron(
    {
      db: api.deps.db,
      pg: api.deps.pg,
      blobs: api.deps.blobs,
      config: api.deps.config,
      mailer,
      alert: (msg, fields) => alerts.push({ msg, fields }),
      platformOrigin: "http://localhost:5173",
      files: fileStore,
    },
    now,
  );
}

async function publishCompliance(extra: Record<string, unknown> = {}) {
  const s = await api.req("GET", `/systems/${systemId}`);
  const put = await api.req("PUT", `/systems/${systemId}/compliance`, {
    body: { expectedVersion: s.body.system.draftRevision, ...OPERATOR, ...extra },
  });
  expect(put.status, put.text).toBe(200);
  const pub = await api.req("POST", `/systems/${systemId}/publish`, {
    body: { revision: put.body.revision.version, confirmDiff: true },
  });
  expect(pub.status, pub.text).toBe(202);
  const run = await waitRun(api, pub.body.run.id, ["succeeded", "failed"], 30_000);
  expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
}

async function journal(schema: string, rows: [string, string, number, string | null][]) {
  for (const [entity, mode, n, cutoff] of rows)
    await api.deps.pg.unsafe(
      `insert into ${schema}."_w_deletion_log" (entity, mode, cutoff, rows_affected, fields) values ($1, $2, $3, $4, '{email}')`,
      [entity, mode, cutoff, n],
    );
}

beforeAll(async () => {
  tdb = await createTestDb("privacy", { migrator: true });
  outbox = mkdtempSync(join(tmpdir(), "wz-outbox-"));
  mailer = new OutboxMailer(outbox);
  api = await startApi(tdb.url, {
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
    retentionCronMs: 0,
    publish: {
      smoke: async () => ({ ok: true }),
      lockRetryDelaysMs: [10, 10, 10],
      telegram: { mode: "outbox", outboxDir: null },
    },
  });
  const b = await startBuild(api);
  systemId = b.systemId;
  expect((await waitRun(api, b.buildRunId, ["succeeded"], 20_000)).status).toBe("succeeded");
  key = (
    await api.deps.db
      .selectFrom("platform.systems")
      .select("schema_key")
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow()
  ).schema_key;
  await migrateDraft(api.deps.pg, { systemKey: key, spec: forum, prevSpec: null });
  await publishCompliance();
}, 90_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
  rmSync(outbox, { recursive: true, force: true });
});

describe("deletion journal: runtime _w_deletion_log → platform.deletion_log → GET /systems/:id/deletion-log", () => {
  test("rows move with counters only; the owner lists them newest first with a cursor; contract", async () => {
    const cutoff = "2026-08-01T00:00:00.000Z";
    await journal(prod(), [
      ["ticket", "delete", 3, cutoff],
      ["ticket", "anonymize", 2, cutoff],
      ["users", "subject_request", 1, null],
    ]);
    await journal(draft(), [["ticket", "delete", 7, cutoff]]);
    const r = await cron();
    expect(r.moved).toBe(4);
    for (const s of [prod(), draft()]) {
      const [n] = await api.deps.pg.unsafe(`select count(*)::int as n from ${s}."_w_deletion_log"`);
      expect(n?.n).toBe(0);
    }
    const rows = await api.deps.pg`
      select env, entity, mode, cutoff, rows_affected from platform.deletion_log where system_id = ${systemId}
      order by id`;
    expect(rows.map((x) => [x.env, x.entity, x.mode, x.rows_affected])).toEqual([
      ["draft", "ticket", "delete", 7],
      ["prod", "ticket", "delete", 3],
      ["prod", "ticket", "anonymize", 2],
      ["prod", "users", "subject_request", 1],
    ]);
    expect(new Date(rows[1]?.cutoff).toISOString()).toBe(cutoff);

    const all = await api.req("GET", `/systems/${systemId}/deletion-log`);
    expect(all.status, all.text).toBe(200);
    expectContract("listDeletionLog", all);
    expect(all.body.items).toHaveLength(4);
    expect(Object.keys(all.body.items[0]).sort()).toEqual(
      ["createdAt", "cutoff", "entity", "env", "mode", "rowsAffected"].sort(),
    );
    const p1 = await api.req("GET", `/systems/${systemId}/deletion-log?limit=3`);
    expect(p1.body.items).toHaveLength(3);
    expect(p1.body.nextCursor).toBeTypeOf("string");
    const p2 = await api.req("GET", `/systems/${systemId}/deletion-log?limit=3&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    expect([...p1.body.items, ...p2.body.items]).toEqual(all.body.items);
    // Idempotent: nothing left to move.
    expect((await cron()).moved).toBe(0);
  });

  test("retention of users (mode=retention, db.yaml) is kept as is", async () => {
    await journal(prod(), [["users", "retention", 4, "2023-10-01T00:00:00.000Z"]]);
    await cron();
    const r = await api.req("GET", `/systems/${systemId}/deletion-log?limit=1`);
    expect(r.body.items[0]).toMatchObject({
      env: "prod",
      entity: "users",
      mode: "retention",
      rowsAffected: 4,
    });
  });

  test("consent withdrawal → letter to the owner without the user's data; deletion_log mode=consent_revoked", async () => {
    const before = mailer.list().length;
    await journal(prod(), [
      ["users", "consent_revoked", 1, null],
      ["ticket", "consent_revoked", 2, null],
    ]);
    const r = await cron();
    expect(r.notices).toBe(1);
    const letters = mailer.list().slice(before);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ kind: "notice", to: "dev@wizard.local" });
    expect(letters[0]?.text).toContain("отозвал согласие");
    expect(letters[0]?.text).toContain("записей: 3");
    const log = await api.req("GET", `/systems/${systemId}/deletion-log?limit=2`);
    expect(log.body.items.map((i: { mode: string }) => i.mode)).toEqual([
      "consent_revoked",
      "consent_revoked",
    ]);
  });

  test("owner only: editor → 403, another org → 404 (also for DELETE /systems/:id)", async () => {
    const ed = await api.req("GET", `/systems/${systemId}/deletion-log`, { headers: EDITOR });
    expect(ed.status).toBe(403);
    expectContract("listDeletionLog", ed);
    expect((await api.req("DELETE", `/systems/${systemId}`, { headers: EDITOR })).status).toBe(403);
    await api.req("GET", "/me", { headers: STRANGER });
    await api.deps.pg`delete from platform.memberships where user_id in
      (select id from platform.users where email = 'stranger-privacy@example.test')`;
    for (const m of ["GET", "DELETE"] as const) {
      const p = m === "GET" ? `/systems/${systemId}/deletion-log` : `/systems/${systemId}`;
      const r = await api.req(m, p, { headers: STRANGER });
      expect(r.status, m).toBe(404);
    }
    expect((await api.req("GET", "/systems/not-a-uuid/deletion-log")).status).toBe(404);
    expect((await api.req("GET", `/systems/${systemId}/deletion-log?cursor=bad`)).status).toBe(400);
  });
});

describe("system tables of older schemas (users.last_login_at, _w_deletion_log)", () => {
  const hasTable = async (schema: string) =>
    (await api.deps.pg`select to_regclass(${`${schema}."_w_deletion_log"`}) as t`)[0]?.t !== null;
  const hasColumn = async (schema: string) =>
    (
      await api.deps.pg`
        select 1 from information_schema.columns
        where table_schema = ${schema.replaceAll('"', "")} and table_name = 'users' and column_name = 'last_login_at'`
    ).length > 0;
  const downgrade = async (schema: string) => {
    await api.deps.pg.unsafe(`drop table ${schema}."_w_deletion_log"`);
    await api.deps.pg.unsafe(`alter table ${schema}."users" drop column last_login_at`);
    // M2-53: a schema from before the signed-body replay guard (column + unique index).
    await api.deps.pg.unsafe(`alter table ${schema}."_w_webhook_events" drop column signed_body_hash`);
  };
  const hasBodyGuard = async (schema: string) =>
    (
      await api.deps.pg`
        select indexdef from pg_catalog.pg_indexes
        where schemaname = ${schema.replaceAll('"', "")} and indexname = '_w_webhook_events_signed_body'`
    )[0]?.indexdef as string | undefined;

  test("the upgrade DDL is idempotent and creates only what is missing", () => {
    const ddl = upgradeSystemTables("app_x_draft");
    expect(ddl[0]).toMatch(/^SET LOCAL lock_timeout/);
    expect(ddl).toContain(
      'ALTER TABLE "app_x_draft"."users" ADD COLUMN IF NOT EXISTS "last_login_at" timestamptz',
    );
    expect(ddl.some((s) => s.startsWith('CREATE TABLE IF NOT EXISTS "app_x_draft"."_w_deletion_log"'))).toBe(
      true,
    );
    expect(ddl.some((s) => /ADD COLUMN IF NOT EXISTS "id"/.test(s))).toBe(false);
    expect(ddl).toContain(
      'ALTER TABLE "app_x_draft"."_w_webhook_events" ADD COLUMN IF NOT EXISTS "signed_body_hash" bytea',
    );
    expect(ddl.at(-1)).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "_w_webhook_events_signed_body" ON "app_x_draft"."_w_webhook_events" ("integration", "signed_body_hash")',
    );
  });

  test("journal transfer skips a schema without _w_deletion_log; the next draft migration restores it", async () => {
    await downgrade(draft());
    await journal(prod(), [["ticket", "delete", 1, null]]);
    expect((await cron()).moved).toBe(1);
    const { created } = await migrateDraft(api.deps.pg, { systemKey: key, spec: forum, prevSpec: forum });
    expect(created).toBe(false);
    expect(await hasTable(draft())).toBe(true);
    expect(await hasColumn(draft())).toBe(true);
    expect(await hasBodyGuard(draft())).toMatch(/UNIQUE INDEX .*\(integration, signed_body_hash\)/);
    // RLS and the runtime grant cover the new table (set_rls of the same migration).
    const [rls] = await api.deps.pg`
      select relrowsecurity, relforcerowsecurity from pg_class
      where oid = to_regclass(${`${draft()}."_w_deletion_log"`})`;
    expect(rls).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const [g] = await api.deps.pg`
      select has_table_privilege('wizard_runtime', ${`${draft()}."_w_deletion_log"`}, 'INSERT') as ok`;
    expect(g?.ok).toBe(true);
  });

  test("the next publish upgrades the prod schema", async () => {
    await downgrade(prod());
    await publishCompliance({ operatorName: "ООО «Форум 2»" });
    expect(await hasTable(prod())).toBe(true);
    expect(await hasColumn(prod())).toBe(true);
    expect(await hasBodyGuard(prod())).toMatch(/UNIQUE INDEX/);
    await journal(prod(), [["ticket", "anonymize", 5, null]]);
    expect((await cron()).moved).toBe(1);
  });
});

describe("control of the runtime retention pass (workflows.yaml#retention_cron, 26 h)", () => {
  const H = 3600_000;
  const jobs = () => `${prod()}."_w_jobs"`;
  const marker = (at: Date) =>
    api.deps.pg.unsafe(
      `insert into ${jobs()} (kind, payload, run_at, locked_until, idempotency_key)
       values ('workflow_step', cast($1::text as jsonb), 'infinity', 'infinity', $2)
       on conflict (idempotency_key) do update set payload = excluded.payload`,
      [JSON.stringify({ state: "retention_pass", at: at.toISOString(), failed: 0 }), RETENTION_MARKER_KEY],
    );
  const requested = async () =>
    (await api.deps.pg.unsafe(`select 1 from ${jobs()} where idempotency_key = $1`, [RETENTION_REQUEST_KEY]))
      .length > 0;

  test("fresh publication without a pass → no alert; after 26 h → retention_overdue + request row", async () => {
    alerts.length = 0;
    expect((await cron()).overdue).toEqual([]);
    expect(await requested()).toBe(false);
    const r = await cron(new Date(Date.now() + 27 * H));
    expect(r.overdue).toEqual([{ systemId, lastPassAt: null, requested: true }]);
    expect(await requested()).toBe(true);
    expect(alerts).toEqual([
      {
        msg: "retention_overdue",
        fields: { systemId, env: "prod", reason: "no_pass", count: null, status: "requested" },
      },
    ]);
    // Repeated alert while the runtime stays silent; the request row is not duplicated.
    expect((await cron(new Date(Date.now() + 28 * H))).overdue).toHaveLength(1);
    const [n] = await api.deps.pg.unsafe(
      `select count(*)::int as n from ${jobs()} where idempotency_key = $1`,
      [RETENTION_REQUEST_KEY],
    );
    expect(n?.n).toBe(1);
    await api.deps.pg.unsafe(`delete from ${jobs()} where idempotency_key = $1`, [RETENTION_REQUEST_KEY]);
  });

  test("a pass within 26 h → quiet; a stale pass → alert with its age", async () => {
    const now = new Date();
    await marker(new Date(now.getTime() - 25 * H));
    alerts.length = 0;
    expect((await cron(now)).overdue).toEqual([]);
    expect(alerts).toEqual([]);
    await marker(new Date(now.getTime() - 30 * H));
    const r = await cron(now);
    expect(r.overdue).toEqual([
      { systemId, lastPassAt: new Date(now.getTime() - 30 * H).toISOString(), requested: true },
    ]);
    expect(alerts[0]?.fields).toMatchObject({ reason: "stale_pass", count: 30 });
    await api.deps.pg.unsafe(`delete from ${jobs()} where idempotency_key in ($1, $2)`, [
      RETENTION_MARKER_KEY,
      RETENTION_REQUEST_KEY,
    ]);
  });
});

describe("platform clean-ups of retention_cron (db.yaml retention)", () => {
  test("OTP > 24 h, run events and gate reports > 180 days (the latest per level stays), message scrub", async () => {
    const pg = api.deps.pg;
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
    await pg`insert into platform.auth_otps (email, code_hash, expires_at, created_at) values
      ('old-otp@example.test', 'h', ${ago(1.1)}, ${ago(1.1)}), ('new-otp@example.test', 'h', ${now}, ${now})`;
    const [run] =
      await pg`select id from platform.runs where system_id = ${systemId} order by created_at limit 1`;
    const [mx] =
      await pg`select coalesce(max(seq), 0)::int as n from platform.run_events where run_id = ${run?.id}`;
    const seq = Number(mx?.n) + 1000;
    await pg`insert into platform.run_events (run_id, seq, type, payload, ts) values
      (${run?.id}, ${seq}, 'log', '{}', ${ago(181)}), (${run?.id}, ${seq + 1}, 'log', '{}', ${ago(10)})`;
    const [g] = await pg`select coalesce(max(revision), 0)::int as n from platform.gate_reports
      where system_id = ${systemId} and level = 'G2'`;
    const rev = Number(g?.n) + 1;
    await pg`insert into platform.gate_reports (run_id, system_id, revision, level, passed, report, created_at) values
      (${run?.id}, ${systemId}, ${rev}, 'G2', true, '{}', ${ago(200)}),
      (${run?.id}, ${systemId}, ${rev + 1}, 'G2', true, '{}', ${ago(190)})`;
    // A chat of a system inactive for 200 days and of an active one.
    const [old] = await pg`
      insert into platform.systems (org_id, slug, schema_key, name, created_by, last_activity_at)
      values ('00000000-0000-0000-0000-000000000001', ${`scrub-${Date.now().toString(36)}`}, ${Date.now()
        .toString(36)
        .padStart(12, "0")
        .slice(-12)}, 'Старый черновик', '00000000-0000-0000-0000-0000000000aa', ${ago(200)})
      returning id`;
    const phone = "Позвоните мне: +7 915 123-45-67";
    await pg`insert into platform.messages (system_id, seq, role, kind, text) values
      (${old?.id}, 1, 'user', 'text', ${phone}), (${old?.id}, 2, 'assistant', 'text', ${phone}),
      (${systemId}, 100000, 'user', 'text', ${phone})`;

    const r = await runHousekeeping(api.deps.db, now);
    expect(r.otps).toBeGreaterThanOrEqual(1);
    expect(r.runEvents).toBeGreaterThanOrEqual(1);
    expect(r.gateReports).toBeGreaterThanOrEqual(1);
    expect(r.messagesScrubbed).toBe(1);
    const otps = await pg`select email from platform.auth_otps where email like '%-otp@example.test'`;
    expect(otps.map((x) => x.email)).toEqual(["new-otp@example.test"]);
    const ev =
      await pg`select seq from platform.run_events where run_id = ${run?.id} and seq >= ${seq} order by seq`;
    expect(ev.map((x) => x.seq)).toEqual([seq + 1]);
    const gr =
      await pg`select revision from platform.gate_reports where system_id = ${systemId} and level = 'G2'
      and revision >= ${rev} order by revision`;
    expect(gr.map((x) => x.revision)).toEqual([rev + 1]);
    const msgs = await pg`select system_id, role, text from platform.messages
      where system_id in (${old?.id}, ${systemId}) and text like 'Позвоните%' order by system_id, seq`;
    const scrubbed = msgs.find((m) => m.system_id === old?.id && m.role === "user");
    expect(scrubbed?.text).not.toContain("915");
    expect(scrubbed?.text).toMatch(/\[ТЕЛЕФОН_1\]/);
    expect(msgs.find((m) => m.system_id === old?.id && m.role === "assistant")?.text).toBe(phone);
    expect(msgs.find((m) => m.system_id === systemId)?.text).toBe(phone);
    // Idempotent: nothing left to change.
    expect((await runHousekeeping(api.deps.db, now)).messagesScrubbed).toBe(0);
    await pg`delete from platform.messages where system_id = ${old?.id}`;
    await pg`delete from platform.systems where id = ${old?.id}`;
    await pg`delete from platform.messages where system_id = ${systemId} and seq = 100000`;
  });
});

describe("F5: inactive Free drafts (workflows.yaml#retention_cron)", () => {
  test("53 days → letter to the owner; ≥ 7 days later and 60 days inactive → only the draft schema goes", async () => {
    const b = await startBuild(api, "Черновик без активности");
    expect((await waitRun(api, b.buildRunId, ["succeeded"], 20_000)).status).toBe("succeeded");
    const pg = api.deps.pg;
    const [s] = await pg`select schema_key from platform.systems where id = ${b.systemId}`;
    const k = String(s?.schema_key);
    await migrateDraft(pg, { systemKey: k, spec: forum, prevSpec: null });
    const draftSchema = `app_${k}_draft`;
    const exists = async () =>
      (await pg`select 1 from pg_namespace where nspname = ${draftSchema}`).length > 0;
    const revs = async () =>
      Number(
        (await pg`select count(*)::int as n from platform.revisions where system_id = ${b.systemId}`)[0]?.n,
      );
    const revCount = await revs();
    const draftFile = await putFile(draftSchema);
    const prodFile = await putFile(`app_${k}_prod`);
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);

    await pg`update platform.systems set last_activity_at = ${ago(52)} where id = ${b.systemId}`;
    expect((await cron(now)).freeDrafts.noticed).not.toContain(b.systemId);

    const before = mailer.list().length;
    await pg`update platform.systems set last_activity_at = ${ago(54)} where id = ${b.systemId}`;
    expect((await cron(now)).freeDrafts.noticed).toContain(b.systemId);
    const letters = mailer.list().slice(before);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ kind: "notice", to: "dev@wizard.local" });
    expect(letters[0]?.subject).toContain("Тестовые данные черновика");
    expect(letters[0]?.text).toContain("Спека, код, ревизии и опубликованная версия сохранятся");
    // Warned once per inactivity period; not purged before 60 days and 7 days after the letter.
    const again = await cron(new Date(now.getTime() + 6 * 86_400_000));
    expect(again.freeDrafts).toEqual({ noticed: [], purged: [] });
    expect(mailer.list().length).toBe(before + 1);
    expect(await exists()).toBe(true);

    const r = await cron(new Date(now.getTime() + 7 * 86_400_000 + 60_000));
    expect(r.freeDrafts.purged).toEqual([{ systemId: b.systemId, rows: expect.any(Number) }]);
    expect(await exists()).toBe(false);
    // M2-14: the draft's file objects go with its data; prod files stay.
    expect(fileStore.objects.has(draftFile)).toBe(false);
    expect(fileStore.objects.has(prodFile)).toBe(true);
    expect(await revs()).toBe(revCount);
    const [sys] =
      await pg`select draft_data_purged_at, deleted_at from platform.systems where id = ${b.systemId}`;
    expect(sys?.draft_data_purged_at).not.toBeNull();
    expect(sys?.deleted_at).toBeNull();
    const [log] = await pg`select env, entity, mode from platform.deletion_log
      where system_id = ${b.systemId} and mode = 'draft_purged'`;
    expect(log).toMatchObject({ env: "draft", entity: "*", mode: "draft_purged" });
    // Purged once; activity and the next build bring the schema back.
    expect((await cron(new Date(now.getTime() + 8 * 86_400_000))).freeDrafts).toEqual({
      noticed: [],
      purged: [],
    });
    const { created } = await migrateDraft(pg, { systemKey: k, spec: forum, prevSpec: forum });
    expect(created).toBe(true);
    // Paid plans are never touched.
    await pg`update platform.systems set last_activity_at = ${ago(100)}, draft_purge_notice_at = null where id = ${b.systemId}`;
    await pg`update platform.orgs set plan = 'start' where id = '00000000-0000-0000-0000-000000000001'`;
    try {
      expect((await cron(now)).freeDrafts).toEqual({ noticed: [], purged: [] });
    } finally {
      await pg`update platform.orgs set plan = 'free' where id = '00000000-0000-0000-0000-000000000001'`;
      await pg`update platform.systems set last_activity_at = now() where id = ${b.systemId}`;
    }
  });
});

describe("delete_system (L3-36)", () => {
  test("soft delete by the owner; purge after 30 days: schemas, messages, imports, secrets, artifacts; shared blobs stay", async () => {
    // A second system with the same files: their blobs are shared and must survive the purge.
    const other = await startBuild(api, "Регистрация на второй форум");
    expect((await waitRun(api, other.buildRunId, ["succeeded"], 20_000)).status).toBe("succeeded");

    const pg = api.deps.pg;
    const cfg = api.deps.config;
    // A secret value, an import file and a bundle directory of the system.
    const secrets = new SecretStore(cfg.secretsFile, cfg.secretsKey);
    await api.deps.db.transaction().execute((trx) =>
      secrets.put(trx, {
        orgId: "00000000-0000-0000-0000-000000000001",
        systemId,
        env: "prod",
        name: "bot_token",
        value: "s3cr3t",
      }),
    );
    const [imp] = await pg`
      insert into platform.imports (system_id, source_sha, status, expires_at, created_by)
      values (${systemId}, ${"0".repeat(64)}, 'done', now() + interval '1 day', '00000000-0000-0000-0000-0000000000aa')
      returning id`;
    const imports = new ImportStore(cfg.importsDir, cfg.secretsKey);
    await imports.put(imp?.id, new TextEncoder().encode("a;b\n1;2\n"));
    const files = [await putFile(`app_${key}_prod`), await putFile(`app_${key}_draft`)];
    const foreignFile = await putFile("app_zzzzzzzzzzzz_prod");
    const bundleDir = join(cfg.artifactsDir, key, "1");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "manifest.json"), "{}");
    // A blob only this system references.
    const own = await api.deps.blobs.put(
      api.deps.db,
      new TextEncoder().encode(`own-${systemId}`),
      "text/plain",
    );
    const [rev] = await pg`
      select files_manifest_sha from platform.revisions where system_id = ${systemId} order by version desc limit 1`;
    const manifest = JSON.parse((await api.deps.blobs.get(rev?.files_manifest_sha)).toString("utf8"));
    manifest["ui/Own.tsx"] = own.sha256;
    const m2 = await api.deps.blobs.put(
      api.deps.db,
      Buffer.from(JSON.stringify(manifest)),
      "application/json",
    );
    await pg`update platform.revisions set files_manifest_sha = ${m2.sha256}
      where system_id = ${systemId} and files_manifest_sha = ${rev?.files_manifest_sha}`;
    const otherShas = Object.values(
      JSON.parse(
        (
          await api.deps.blobs.get(
            (
              await pg`select files_manifest_sha from platform.revisions where system_id = ${other.systemId}
                order by version desc limit 1`
            )[0]?.files_manifest_sha,
          )
        ).toString("utf8"),
      ),
    ) as string[];
    expect(otherShas.length).toBeGreaterThan(0);

    // An active run blocks the delete.
    const [run] =
      await pg`select id from platform.runs where system_id = ${systemId} order by created_at desc limit 1`;
    await pg`update platform.runs set status = 'running' where id = ${run?.id}`;
    const locked = await api.req("DELETE", `/systems/${systemId}`);
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe("SYSTEM_LOCKED");
    await pg`update platform.runs set status = 'succeeded' where id = ${run?.id}`;

    const del = await api.req("DELETE", `/systems/${systemId}`);
    expect(del.status, del.text).toBe(200);
    expect(Date.parse(del.body.purgeAfter) - Date.parse(del.body.deletedAt)).toBe(30 * 86_400_000);
    expect((await api.req("GET", `/systems/${systemId}`)).status).toBe(404);
    expect((await api.req("DELETE", `/systems/${systemId}`)).status).toBe(404);
    const list = await api.req("GET", "/systems");
    expect(list.body.items.map((s: { id: string }) => s.id)).not.toContain(systemId);
    const [dep] = await pg`select count(*)::int as n from platform.deployments where system_id = ${key}`;
    expect(dep?.n).toBe(0);
    // The journal of a deleted system stays readable for the owner.
    expect((await api.req("GET", `/systems/${systemId}/deletion-log`)).status).toBe(200);

    // Younger than 30 days → nothing purged; a journal row written meanwhile still moves.
    await journal(prod(), [["users", "consent_revoked", 1, null]]);
    const early = await cron();
    expect(early.purged).toEqual([]);
    expect(early.moved).toBe(1);

    await journal(prod(), [["ticket", "delete", 2, null]]);
    await pg`update platform.systems set deleted_at = now() - interval '31 days' where id = ${systemId}`;
    const r = await cron();
    expect(r.purged).toHaveLength(1);
    expect(r.purged[0]).toMatchObject({ systemId, blobs: 2, files: 2 });
    for (const f of files) expect(fileStore.objects.has(f)).toBe(false);
    expect(fileStore.objects.has(foreignFile)).toBe(true);
    expect(r.purged[0]?.schemas.sort()).toEqual([`app_${key}_draft`, `app_${key}_prod`]);

    const [ns] = await pg`select count(*)::int as n from pg_namespace where nspname like ${`app_${key}_%`}`;
    expect(ns?.n).toBe(0);
    for (const t of ["messages", "imports", "exports", "secrets_refs"]) {
      const [c] = await pg.unsafe(`select count(*)::int as n from platform.${t} where system_id = $1`, [
        systemId,
      ]);
      expect(c?.n, t).toBe(0);
    }
    expect(secrets.get(systemId, "prod", "bot_token")).toBeNull();
    await expect(imports.get(imp?.id)).rejects.toThrow();
    expect(existsSync(join(cfg.artifactsDir, key))).toBe(false);
    await expect(api.deps.blobs.get(own.sha256)).rejects.toThrow();
    for (const sha of otherShas) expect((await api.deps.blobs.get(sha)).length).toBeGreaterThanOrEqual(0);
    // No platform.runs row for the purge.
    const [runs] =
      await pg`select count(*)::int as n from platform.runs where system_id = ${systemId} and created_at > now() - interval '1 minute' and kind not in ('interview_turn','build','publish')`;
    expect(runs?.n).toBe(0);

    const log = await pg`
      select env, entity, mode, rows_affected from platform.deletion_log
      where system_id = ${systemId} and mode in ('system_deleted', 'delete') order by id desc limit 3`;
    expect(
      log
        .filter((x) => x.mode === "system_deleted")
        .map((x) => x.env)
        .sort(),
    ).toEqual(["draft", "prod"]);
    // The runtime journal was moved before the schema was dropped.
    expect(log.some((x) => x.mode === "delete" && x.rows_affected === 2)).toBe(true);
    const api200 = await api.req("GET", `/systems/${systemId}/deletion-log`);
    expect(api200.body.items[0].mode).toBe("system_deleted");
    // Purged once: the marker stops further passes.
    expect((await cron()).purged).toEqual([]);
  });
});
