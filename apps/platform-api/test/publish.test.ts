// Acceptance M1-04 (platform-api side): publish with an additive prod migration on live data, rollback of prod and of
// the draft, human revision diff, draft_snapshot with PII masking (L4-11). Builds are scripted (fake builder and
// gates); prod migrations, publications and the draft snapshot run for real in Postgres.
import { isSyntheticValue } from "@wizard/gates";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { migrateDraft, seedDraft } from "../src/agents/draft.js";
import { applyProdMigration, type ProdSmoke } from "../src/publish/prod.js";
import { draftSnapshot } from "../src/publish/snapshot.js";
import { listEvents } from "../src/runs/events.js";
import { type BuildHost, type BuildParams, RunFailure } from "../src/runs/types.js";
import { loadEventSchemas } from "./event-schemas.js";
import { startBuild } from "./flow.js";
import {
  createTestDb,
  fakeBuild,
  fakeCard,
  fakeExecutors,
  fakeInterview,
  fakeRouterFactory,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";

const schemas = loadEventSchemas();
const PII = {
  name: "Иван Петров",
  email: "ivan.petrov@mail.ru",
  phone: "+79161234567",
  speaker: "Мария Сидорова",
  speakerEmail: "maria.sidorova@yandex.ru",
};

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let changeOps: unknown[] = [];
let smokeResult: Awaited<ReturnType<ProdSmoke>> = { ok: true };
const smokeCalls: { revision: number; url: string }[] = [];

async function build(host: BuildHost, p: BuildParams) {
  if (p.mode !== "change") return fakeBuild(host, p, { spec: "forum" });
  const { version } = await host.store.getSpec();
  const r = await host.store.applyOps(changeOps, version, `${host.run.id}:change:1`);
  if (!r.ok) throw new RunFailure("GATES_FAILED", JSON.stringify(r.errors));
  const report = await host.runGates("G0");
  if (!report.passed) throw new RunFailure("GATES_FAILED", "G0");
  return { summary_ru: "Правка собрана" };
}

beforeAll(async () => {
  tdb = await createTestDb("publish", { migrator: true });
  api = await startApi(tdb.url, {
    executors: {
      ...fakeExecutors({ spec: "forum" }),
      build,
      interviewTurn: async (host) =>
        host.context.trigger === "message" && host.context.system.previewRevision !== null
          ? { kind: "card", text: "Правка", card: { ...fakeCard(20), summary: "Правка системы" } }
          : fakeInterview(host),
    },
    createRouter: fakeRouterFactory(),
    publish: {
      smoke: async (i) => {
        smokeCalls.push({ revision: i.revision, url: i.url });
        return smokeResult;
      },
      lockRetryDelaysMs: [10, 10, 10],
      telegram: { mode: "outbox", outboxDir: null },
    },
  });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

async function events(runId: string) {
  const list = await listEvents(api.deps.db, runId, 0);
  const bad = list.map((e) => schemas.validate(e)).filter((x) => x !== null);
  expect(bad, JSON.stringify(bad)).toEqual([]);
  return list;
}

async function sys(id: string) {
  return api.deps.db
    .selectFrom("platform.systems")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

async function publish(systemId: string, revision: number, finals = ["succeeded"]) {
  const res = await api.req("POST", `/systems/${systemId}/publish`, {
    body: { revision, confirmDiff: true },
  });
  expect(res.status, res.text).toBe(202);
  return waitRun(api, res.body.run.id, finals, 20_000);
}

async function change(systemId: string, ops: unknown[], finals = ["succeeded"]) {
  changeOps = ops;
  const m = await api.req("POST", `/systems/${systemId}/messages`, { body: { text: "Нужна правка" } });
  expect(m.status).toBe(202);
  await waitRun(api, m.body.run.id, ["succeeded"]);
  const s = await api.req("GET", `/systems/${systemId}`);
  expect(s.body.system.stage).toBe("card");
  const ap = await api.req("POST", `/systems/${systemId}/card/approve`, {
    body: { cardVersion: s.body.card.cardVersion },
  });
  expect(ap.status, ap.text).toBe(202);
  return waitRun(api, ap.body.run.id, finals, 20_000);
}

describe("publish → change → publish → rollback", () => {
  let systemId = "";
  let key = "";
  let firstRev = 0;
  let fieldRev = 0;
  const prod = () => `"app_${key}_prod"`;

  beforeAll(async () => {
    const b = await startBuild(api);
    systemId = b.systemId;
    const run = await waitRun(api, b.buildRunId, ["succeeded"], 20_000);
    expect(run.status).toBe("succeeded");
    key = (await sys(systemId)).schema_key;
  }, 60_000);

  test("publish: only owner; PII without operator → OPERATOR_NAME_REQUIRED; unknown revision → 404", async () => {
    const s = await sys(systemId);
    const asEditor = await api.req("POST", `/systems/${systemId}/publish`, {
      body: { revision: s.draft_revision },
      headers: { "x-wizard-dev-user": "editor@example.test" },
    });
    expect(asEditor.status).toBe(403);
    expect(asEditor.body.code).toBe("NOT_OWNER");
    const blocked = await api.req("POST", `/systems/${systemId}/publish`, {
      body: { revision: s.draft_revision },
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe("OPERATOR_NAME_REQUIRED");
    const missing = await api.req("POST", `/systems/${systemId}/publish`, { body: { revision: 999 } });
    expect(missing.status).toBe(404);
    const own = await api.req("GET", `/systems/${systemId}`);
    expect(own.body.publishBlockers).toEqual(["OPERATOR_NAME_REQUIRED", "OPERATOR_CONTACT_REQUIRED"]);
    const other = await api.req("GET", `/systems/${systemId}`, {
      headers: { "x-wizard-dev-user": "editor@example.test" },
    });
    expect(other.body.publishBlockers).toEqual([
      "NOT_OWNER",
      "OPERATOR_NAME_REQUIRED",
      "OPERATOR_CONTACT_REQUIRED",
    ]);
  });

  test("setCompliance (owner) → revision kind=compliance → first publish creates app_<key>_prod", async () => {
    const s0 = await sys(systemId);
    const put = await api.req("PUT", `/systems/${systemId}/compliance`, {
      body: {
        expectedVersion: s0.draft_revision,
        operatorName: "ООО «Северный ритейл»",
        operatorContact: "privacy@north-retail.example",
      },
    });
    expect(put.status, put.text).toBe(200);
    expect(put.body.revision.kind).toBe("compliance");
    firstRev = put.body.revision.version;

    const run = await publish(systemId, firstRev);
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
    const ev = await events(run.id);
    const steps = ev.filter((e) => e.type === "step_started").map((e) => e.payload.step);
    expect(steps).toEqual([
      "gate_G0",
      "plan_migration",
      "gate_G0_prod",
      "telegram_webhook", // forum has its own bot: getMe + setWebhook (recorded, outbox mode)
      "apply_migration",
      "switch",
      "smoke",
    ]);
    const fin = ev.at(-1);
    expect(fin?.type).toBe("run_finished");
    expect(fin?.payload.prodUrl).toMatch(/^http:\/\/[a-z0-9-]+\.localhost:4100\/$/);
    expect(run.resultRevision).toBe(firstRev);

    const s = await sys(systemId);
    expect(s.prod_revision).toBe(firstRev);
    expect(s.schema_hwm_revision).toBe(firstRev);
    const got = await api.req("GET", `/systems/${systemId}`);
    expect(got.body.system.prodUrl).toBe(fin?.payload.prodUrl);
    expect(got.body.publishBlockers).toEqual([]);
    const tables = await api.deps.pg`
      select table_name from information_schema.tables where table_schema = ${`app_${key}_prod`}`;
    expect(tables.map((t) => t.table_name)).toEqual(expect.arrayContaining(["users", "stream", "ticket"]));
    const dep = await api.deps.pg`
      select env, revision, bundle_key from platform.deployments where system_id = ${key} order by env`;
    expect(dep.map((d) => [d.env, d.revision])).toEqual([
      ["draft", firstRev],
      ["prod", firstRev],
    ]);
    const pubs = await api.req("GET", `/systems/${systemId}/publications`);
    expect(pubs.body.items).toHaveLength(1);
    expect(pubs.body.items[0]).toMatchObject({ env: "prod", revision: firstRev, status: "live" });
    expect(pubs.body.items[0].migrationSteps).toBeGreaterThan(5);
  });

  test("prod gets live data (including PII)", async () => {
    const pg = api.deps.pg;
    const spec = (await api.req("GET", `/systems/${systemId}/revisions/${firstRev}`)).body.spec;
    const enumOf = (e: string, f: string) =>
      spec.entities
        .find((x: { name: string }) => x.name === e)
        .fields.find((x: { name: string }) => x.name === f).enum[0].value;
    await pg.begin(async (tx) => {
      const [u] = await tx.unsafe(
        `insert into ${prod()}.users (role, display_name, email, phone) values ('participant', $1, $2, $3) returning id`,
        [PII.name, PII.email, PII.phone],
      );
      const [st] = await tx.unsafe(
        `insert into ${prod()}.stream (name, capacity) values ('Ритейл-тех', 300) returning id`,
      );
      const [tt] = await tx.unsafe(
        `insert into ${prod()}.ticket_type (name, kind, price, capacity) values ('Стандарт', $1, 5000, 500) returning id`,
        [enumOf("ticket_type", "kind")],
      );
      await tx.unsafe(
        `insert into ${prod()}.ticket (ticket_type, stream, holder_user, holder_name, holder_email, holder_phone, status, amount, event_starts_at)
         values ($1, $2, $3, $4, $5, $6, $7, 5000, now() + interval '30 days')`,
        [tt?.id, st?.id, u?.id, PII.name, PII.email, PII.phone, enumOf("ticket", "status")],
      );
      await tx.unsafe(
        `insert into ${prod()}.speaker_application (speaker_user, full_name, email, topic, abstract, status)
         values ($1, $2, $3, 'Омниканальность', 'Тезисы доклада', $4)`,
        [u?.id, PII.speaker, PII.speakerEmail, enumOf("speaker_application", "status")],
      );
    });
    const [n] = await pg.unsafe(`select count(*)::int as n from ${prod()}.ticket`);
    expect(n?.n).toBe(1);
  });

  test("draft_snapshot: a change build copies prod into draft with PII replaced (L4-11)", async () => {
    const s = await sys(systemId);
    const spec = (await api.req("GET", `/systems/${systemId}/revisions/${s.preview_revision}`)).body.spec;
    // The fake executors do not migrate the draft: create it as migrate_draft/seed_draft would.
    await migrateDraft(api.deps.pg, { systemKey: key, spec, prevSpec: null });
    await seedDraft(api.deps.pg, { systemKey: key, spec });

    const run = await change(systemId, [
      {
        op: "add_field",
        entity: "stream",
        field: { name: "hall", label: "Зал", type: "string", required: true, default: "Главный" },
      },
      { op: "add_field", entity: "stream", field: { name: "floor", label: "Этаж", type: "int" } },
    ]);
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
    const ev = await events(run.id);
    expect(ev.filter((e) => e.type === "step_started").map((e) => e.payload.step)).toContain(
      "draft_snapshot",
    );
    fieldRev = (await sys(systemId)).draft_revision;

    const draft = `"app_${key}_draft"`;
    const pg = api.deps.pg;
    const [t] = await pg.unsafe(`select * from ${draft}.ticket`);
    expect(t).toBeDefined();
    expect(isSyntheticValue(String(t?.holder_name))).toBe(true);
    expect(isSyntheticValue(String(t?.holder_email))).toBe(true);
    expect(isSyntheticValue(String(t?.holder_phone))).toBe(true);
    const [st] = await pg.unsafe(`select name from ${draft}.stream`);
    expect(st?.name).toBe("Ритейл-тех"); // non-PII values are copied as is
    // grep of every prod PII value over the whole draft schema = 0 (workflows.yaml draft_snapshot test)
    const tables = await pg`
      select table_name from information_schema.tables where table_schema = ${`app_${key}_draft`}`;
    let dump = "";
    for (const { table_name } of tables)
      for (const r of await pg.unsafe(`select row_to_json(x)::text as j from ${draft}."${table_name}" x`))
        dump += r.j;
    expect(dump.length).toBeGreaterThan(100);
    for (const v of Object.values(PII)) expect(dump).not.toContain(v);
    expect(dump).not.toContain("ivan.petrov");
    // the same prod state is not copied twice
    const again = await draftSnapshot(pg, {
      systemKey: key,
      specs: [spec],
      marker: (await livePub(systemId)).id,
    });
    expect(again.skipped).toBe(true);
  });

  test("human diff of the new revision against prod", async () => {
    const res = await api.req("GET", `/systems/${systemId}/revisions/${fieldRev}/diff?from=${firstRev}`);
    expect(res.status).toBe(200);
    const texts = res.body.changes.map((c: { text_ru: string }) => c.text_ru);
    expect(texts).toContain("В «Поток» добавлено поле «Зал» (строка, обязательное)");
    expect(texts).toContain("В «Поток» добавлено поле «Этаж» (целое число)");
    expect(res.body.changes.some((c: { destructive?: boolean }) => c.destructive)).toBe(false);
    const parent = await api.req("GET", `/systems/${systemId}/revisions/${fieldRev}/diff`);
    expect(parent.status).toBe(200);
    expect(Array.isArray(parent.body.changes)).toBe(true);
  });

  test("publish with an additive migration on live data: rows kept, required column backfilled", async () => {
    const run = await publish(systemId, fieldRev);
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
    const pg = api.deps.pg;
    const rows = await pg.unsafe(`select name, hall, floor from ${prod()}.stream`);
    expect(rows).toEqual([{ name: "Ритейл-тех", hall: "Главный", floor: null }]);
    const [col] = await pg`
      select is_nullable from information_schema.columns
      where table_schema = ${`app_${key}_prod`} and table_name = 'stream' and column_name = 'hall'`;
    expect(col?.is_nullable).toBe("NO");
    const [t] = await pg.unsafe(`select holder_email from ${prod()}.ticket`);
    expect(t?.holder_email).toBe(PII.email); // prod data untouched by the snapshot
    const s = await sys(systemId);
    expect([s.prod_revision, s.schema_hwm_revision]).toEqual([fieldRev, fieldRev]);
    const pubs = (await api.req("GET", `/systems/${systemId}/publications`)).body.items;
    expect(pubs.map((p: { status: string }) => p.status)).toEqual(["live", "superseded"]);
  });

  test("rollback prod: target must have been live; no DDL, data and the new column stay", async () => {
    const never = await api.req("POST", `/systems/${systemId}/rollback`, {
      body: { env: "prod", toRevision: 1 },
    });
    expect(never.status).toBe(422);
    expect(never.body.code).toBe("ROLLBACK_TARGET_INVALID");
    const asEditor = await api.req("POST", `/systems/${systemId}/rollback`, {
      body: { env: "prod", toRevision: firstRev },
      headers: { "x-wizard-dev-user": "editor@example.test" },
    });
    expect(asEditor.body.code).toBe("NOT_OWNER");

    const res = await api.req("POST", `/systems/${systemId}/rollback`, {
      body: { env: "prod", toRevision: firstRev },
    });
    expect(res.status).toBe(202);
    const run = await waitRun(api, res.body.run.id, ["succeeded", "failed"], 20_000);
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
    await events(run.id);
    const s = await sys(systemId);
    expect(s.prod_revision).toBe(firstRev);
    expect(s.schema_hwm_revision).toBe(fieldRev);
    const rows = await api.deps.pg.unsafe(`select name, hall from ${prod()}.stream`);
    expect(rows).toEqual([{ name: "Ритейл-тех", hall: "Главный" }]);
    const pubs = (await api.req("GET", `/systems/${systemId}/publications`)).body.items;
    expect(pubs[0]).toMatchObject({
      revision: firstRev,
      status: "live",
      migrationSteps: 0,
      schemaRevision: fieldRev,
    });
    const dep = await api.deps
      .pg`select revision from platform.deployments where system_id = ${key} and env = 'prod'`;
    expect(dep[0]?.revision).toBe(firstRev);
  });

  test("smoke failure → automatic rollback to the previous publication, SMOKE_FAILED", async () => {
    smokeResult = { ok: false, reason: "GET / → 503" };
    try {
      const run = await publish(systemId, fieldRev, ["succeeded", "failed"]);
      expect(run.status).toBe("failed");
      expect(run.failure.code).toBe("SMOKE_FAILED");
    } finally {
      smokeResult = { ok: true };
    }
    const s = await sys(systemId);
    expect(s.prod_revision).toBe(firstRev);
    const pubs = (await api.req("GET", `/systems/${systemId}/publications`)).body.items;
    expect(pubs.filter((p: { status: string }) => p.status === "live")).toHaveLength(1);
    expect(pubs[0]).toMatchObject({ revision: fieldRev, status: "failed" });
    expect(smokeCalls.at(-1)?.revision).toBe(fieldRev);
  });

  test("crash after apply_migration before switch: schema extended, old revision still live, republish is a no-op DDL", async () => {
    // A new revision with one more column; its migration is applied, then the "process dies" (no switch).
    const run = await change(systemId, [
      { op: "add_field", entity: "ticket_type", field: { name: "badge", label: "Бейдж", type: "string" } },
    ]);
    expect(run.status).toBe("succeeded");
    const rev = (await sys(systemId)).draft_revision;
    const spec = (await api.req("GET", `/systems/${systemId}/revisions/${rev}`)).body.spec;
    const hwmSpec = (await api.req("GET", `/systems/${systemId}/revisions/${fieldRev}`)).body.spec;
    const { planMigration } = await import("@wizard/appspec");
    const plan = planMigration(hwmSpec, spec, { env: "prod" });
    const [pub] = await api.deps.pg`
      insert into platform.publications (system_id, revision, schema_revision, migration_plan, bundle_key, status, created_by)
      select id, ${rev}, ${rev}, '{}'::jsonb, 'x', 'applying', created_by from platform.systems where id = ${systemId}
      returning id`;
    await applyProdMigration(api.deps.pg, {
      systemId,
      systemKey: key,
      plan,
      revision: rev,
      publicationId: pub?.id,
    });
    await api.deps.pg`update platform.publications set status = 'failed' where id = ${pub?.id}`;
    const s = await sys(systemId);
    expect(s.prod_revision).toBe(firstRev);
    expect(s.schema_hwm_revision).toBe(rev);
    const rows = await api.deps.pg.unsafe(`select name, badge from ${prod()}.ticket_type`);
    expect(rows).toEqual([{ name: "Стандарт", badge: null }]);

    const again = await publish(systemId, rev);
    expect(again.status, JSON.stringify(again.failure)).toBe("succeeded");
    const pubs = (await api.req("GET", `/systems/${systemId}/publications`)).body.items;
    expect(pubs[0]).toMatchObject({ revision: rev, status: "live", migrationSteps: 1 }); // only set_rls
  });

  test("destructive revision → DESTRUCTIVE_IN_PROD, prod untouched", async () => {
    const liveBefore = (await sys(systemId)).prod_revision;
    const run = await change(systemId, [{ op: "remove_field", entity: "stream", name: "description" }]);
    expect(run.status).toBe("succeeded");
    const rev = (await sys(systemId)).draft_revision;
    const diff = await api.req("GET", `/systems/${systemId}/revisions/${rev}/diff`);
    expect(diff.body.changes).toEqual([
      expect.objectContaining({
        kind: "field",
        destructive: true,
        text_ru: expect.stringContaining("удалено поле"),
      }),
    ]);
    const failed = await publish(systemId, rev, ["succeeded", "failed"]);
    expect(failed.status).toBe("failed");
    expect(failed.failure.code).toBe("DESTRUCTIVE_IN_PROD");
    const s = await sys(systemId);
    expect(s.prod_revision).toBe(liveBefore);
    const pubs = (await api.req("GET", `/systems/${systemId}/publications`)).body.items;
    expect(pubs[0].status).toBe("failed");
    const [col] = await api.deps.pg`
      select 1 as x from information_schema.columns
      where table_schema = ${`app_${key}_prod`} and table_name = 'stream' and column_name = 'description'`;
    expect(col?.x).toBe(1);
  });

  test("rollback draft: revision kind=revert with the target's spec, G0 → preview", async () => {
    const before = await sys(systemId);
    const res = await api.req("POST", `/systems/${systemId}/rollback`, {
      body: { env: "draft", toRevision: firstRev },
      headers: { "x-wizard-dev-user": "editor@example.test" },
    });
    expect(res.status, res.text).toBe(202);
    const run = await waitRun(api, res.body.run.id, ["succeeded", "failed"], 20_000);
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
    await events(run.id);
    const s = await sys(systemId);
    expect(s.draft_revision).toBe(before.draft_revision + 1);
    expect(s.preview_revision).toBe(s.draft_revision);
    const [a, b] = await Promise.all([
      api.req("GET", `/systems/${systemId}/revisions/${s.draft_revision}`),
      api.req("GET", `/systems/${systemId}/revisions/${firstRev}`),
    ]);
    expect(a.body.kind).toBe("revert");
    expect(a.body.spec).toEqual(b.body.spec);
    expect(a.body.files).toEqual(b.body.files);
    expect(s.prod_revision).not.toBe(s.draft_revision); // prod is not touched by a draft rollback
  });
});

async function livePub(systemId: string) {
  return api.deps.db
    .selectFrom("platform.publications")
    .select("id")
    .where("system_id", "=", systemId)
    .where("status", "=", "live")
    .executeTakeFirstOrThrow();
}
