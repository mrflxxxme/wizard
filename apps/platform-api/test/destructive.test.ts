// Acceptance M2-72 (product.yaml#decisions.D56_destructive_changes, D72; api.yaml getDestructiveConsequences,
// confirmDestructive, listDestructiveChanges, undoDestructiveChange; gates.yaml G0-MIG-01): a prod change that removes a
// field, changes a type (text → int with values that do not convert) and removes an entity. The owner sees the
// consequences in words, editors cannot confirm or undo (403), publishing without a confirmation or with a stale one
// fails DESTRUCTIVE_IN_PROD; after publishing the values are in the archive, out of reach of the runtime DB role; a
// plain rollback to an older revision is refused; «Отменить правку» brings everything back. Builds are scripted,
// prod migrations run for real in Postgres.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RUNTIME_ROLE } from "../src/agents/draft.js";
import { markApplied } from "../src/destructive/service.js";
import { type BuildHost, type BuildParams, RunFailure } from "../src/runs/types.js";
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
import { expectContract } from "./session.js";

const EDITOR = { "x-wizard-dev-user": "editor@example.test" };

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let changeOps: unknown[] = [];

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
  tdb = await createTestDb("destructive", { migrator: true });
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
      smoke: async () => ({ ok: true }),
      lockRetryDelaysMs: [10, 10, 10],
      telegram: { mode: "outbox", outboxDir: null },
    },
  });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

async function sys(id: string) {
  return api.deps.db
    .selectFrom("platform.systems")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

async function publish(systemId: string, revision: number) {
  const res = await api.req("POST", `/systems/${systemId}/publish`, {
    body: { revision, confirmDiff: true },
  });
  expect(res.status, res.text).toBe(202);
  return waitRun(api, res.body.run.id, ["succeeded", "failed"], 20_000);
}

async function change(systemId: string, ops: unknown[]) {
  changeOps = ops;
  const m = await api.req("POST", `/systems/${systemId}/messages`, { body: { text: "Нужна правка" } });
  expect(m.status).toBe(202);
  await waitRun(api, m.body.run.id, ["succeeded"]);
  const s = await api.req("GET", `/systems/${systemId}`);
  const ap = await api.req("POST", `/systems/${systemId}/card/approve`, {
    body: { cardVersion: s.body.card.cardVersion },
  });
  expect(ap.status, ap.text).toBe(202);
  const run = await waitRun(api, ap.body.run.id, ["succeeded", "failed"], 20_000);
  expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
  return (await sys(systemId)).draft_revision;
}

describe("prod change that removes data: confirm, archive, undo", () => {
  let systemId = "";
  let key = "";
  let baseRev = 0;
  let destructiveRev = 0;
  let firstRev = 0;
  let hash = "";
  const prod = () => `"app_${key}_prod"`;
  const archive = () => `app_${key}_prod_archive`;
  const streams = { a: randomUUID(), b: randomUUID(), c: randomUUID() };

  beforeAll(async () => {
    const b = await startBuild(api);
    systemId = b.systemId;
    await waitRun(api, b.buildRunId, ["succeeded"], 20_000);
    key = (await sys(systemId)).schema_key;
    const s0 = await sys(systemId);
    const put = await api.req("PUT", `/systems/${systemId}/compliance`, {
      body: {
        expectedVersion: s0.draft_revision,
        operatorName: "ООО «Северный ритейл»",
        operatorContact: "privacy@north-retail.example",
        operatorAddress: "г. Москва, ул. Тверская, д. 1",
      },
    });
    expect(put.status, put.text).toBe(200);
    firstRev = put.body.revision.version;
    expect((await publish(systemId, firstRev)).status).toBe("succeeded");
    // An additive change first: «Зал» as a string, to retype it later.
    baseRev = await change(systemId, [
      { op: "add_field", entity: "stream", field: { name: "hall", label: "Зал", type: "string" } },
    ]);
    expect((await publish(systemId, baseRev)).status).toBe("succeeded");
    const pg = api.deps.pg;
    for (const [id, name, description, hall] of [
      [streams.a, "Ритейл", "Про магазины", "12"],
      [streams.b, "Финтех", "Про платежи", "Большой"],
      [streams.c, "Логистика", null, null],
    ] as const)
      await pg.unsafe(
        `insert into ${prod()}.stream (id, name, capacity, description, hall) values ($1, $2, 100, $3, $4)`,
        [id, name, description, hall],
      );
    await pg.unsafe(
      `insert into ${prod()}.session (title, stream, starts_at, ends_at) values ('Открытие', $1, now(), now() + interval '1 hour')`,
      [streams.a],
    );
    destructiveRev = await change(systemId, [
      { op: "remove_field", entity: "stream", name: "description" },
      { op: "remove_field", entity: "stream", name: "hall" },
      { op: "add_field", entity: "stream", field: { name: "hall", label: "Зал", type: "int" } },
      { op: "remove_entity", name: "session" },
    ]);
  }, 120_000);

  test("consequences in words: field, type change with unconvertible values, entity", async () => {
    const res = await api.req("GET", `/systems/${systemId}/destructive?revision=${destructiveRev}`);
    expect(res.status, res.text).toBe(200);
    expectContract("getDestructiveConsequences", res);
    expect(res.body).toMatchObject({ revision: destructiveRev, baseRevision: baseRev, required: true });
    expect(res.body.blocking).toBe(false);
    expect(res.body.canConfirm).toBe(true);
    expect(res.body.confirmation).toBeNull();
    const texts = res.body.changes.map((c: { text_ru: string }) => c.text_ru);
    expect(texts).toEqual([
      "Удаление поля „Описание“ в разделе „Поток“ затронет 2 записи. Значения сохранятся в архиве, правку можно отменить.",
      "Смена типа поля „Зал“ в разделе „Поток“ (строка → целое число) затронет 2 записи. 1 значение нельзя перенести в новый тип — оно останется только в архиве, в записях поле станет пустым. Прежние значения сохранятся в архиве, правку можно отменить.",
      "Удаление раздела „Сессия программы“ затронет 1 запись. Записи сохранятся в архиве, правку можно отменить.",
    ]);
    expect(res.body.changes[1]).toMatchObject({ kind: "alter_column_type", affected: 2, unconvertible: 1 });
    hash = res.body.hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const asEditor = await api.req("GET", `/systems/${systemId}/destructive?revision=${destructiveRev}`, {
      headers: EDITOR,
    });
    expect(asEditor.body.canConfirm).toBe(false);
  });

  test("an editor cannot confirm (403); publishing without a confirmation fails DESTRUCTIVE_IN_PROD", async () => {
    const asEditor = await api.req("POST", `/systems/${systemId}/destructive/confirm`, {
      body: { revision: destructiveRev, hash },
      headers: EDITOR,
    });
    expect(asEditor.status).toBe(403);
    expect(asEditor.body.code).toBe("NOT_OWNER");
    expectContract("confirmDestructive", asEditor);
    const run = await publish(systemId, destructiveRev);
    expect(run.status).toBe("failed");
    expect(run.failure.code).toBe("DESTRUCTIVE_IN_PROD");
    expect(run.failure.message_ru).toMatch(/Владелец должен посмотреть последствия и подтвердить/);
    const [col] = await api.deps.pg`
      select 1 as x from information_schema.columns
      where table_schema = ${`app_${key}_prod`} and table_name = 'stream' and column_name = 'description'`;
    expect(col?.x).toBe(1);
  });

  test("new records do not make a confirmation stale; another set of changes does", async () => {
    const wrong = await api.req("POST", `/systems/${systemId}/destructive/confirm`, {
      body: { revision: destructiveRev, hash: "0".repeat(64) },
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe("DESTRUCTIVE_CONSEQUENCES_CHANGED");
    expectContract("confirmDestructive", wrong);
    const ok = await api.req("POST", `/systems/${systemId}/destructive/confirm`, {
      body: { revision: destructiveRev, hash },
    });
    expect(ok.status, ok.text).toBe(201);
    expectContract("confirmDestructive", ok);
    // A new record with a description: the count grows, but the owner confirmed what the change does, not a number.
    await api.deps.pg.unsafe(
      `insert into ${prod()}.stream (name, capacity, description) values ('Маркетинг', 50, 'Про рекламу')`,
    );
    const now = await api.req("GET", `/systems/${systemId}/destructive?revision=${destructiveRev}`);
    expect(now.body.confirmation.status).toBe("confirmed");
    expect(now.body.changes[0].text_ru).toMatch(/затронет 3 записи/);
    expect(now.body.hash).toBe(hash);
    // Another set of changes: prod as if on the first publication (no «Зал» yet) — the retype of «Зал» becomes a
    // plain new column, so the list differs from what the owner confirmed.
    const hwm = (await sys(systemId)).schema_hwm_revision;
    await api.deps.db
      .updateTable("platform.systems")
      .set({ schema_hwm_revision: firstRev })
      .where("id", "=", systemId)
      .execute();
    try {
      const other = await api.req("GET", `/systems/${systemId}/destructive?revision=${destructiveRev}`);
      expect(other.body.confirmation.status).toBe("stale");
      expect(other.body.hash).not.toBe(hash);
      expect(other.body.changes.map((c: { kind: string }) => c.kind)).toEqual(["drop_column", "drop_table"]);
      const run = await publish(systemId, destructiveRev);
      expect(run.status).toBe("failed");
      expect(run.failure.code).toBe("DESTRUCTIVE_IN_PROD");
      expect(run.failure.message_ru).toMatch(/состав правки изменился/);
    } finally {
      await api.deps.db
        .updateTable("platform.systems")
        .set({ schema_hwm_revision: hwm })
        .where("id", "=", systemId)
        .execute();
    }
    const back = await api.req("GET", `/systems/${systemId}/destructive?revision=${destructiveRev}`);
    expect(back.body.confirmation.status).toBe("confirmed");
    expect(back.body.hash).toBe(hash);
  });

  test("confirmed publish: values go to the archive, the runtime role cannot read it", async () => {
    const run = await publish(systemId, destructiveRev);
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
    const pg = api.deps.pg;
    const cols = await pg`
      select column_name, data_type from information_schema.columns
      where table_schema = ${`app_${key}_prod`} and table_name = 'stream'`;
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
    expect(byName.description).toBeUndefined();
    expect(byName.hall).toBe("bigint");
    const halls = await pg.unsafe(`select id, hall from ${prod()}.stream where id in ($1, $2, $3)`, [
      streams.a,
      streams.b,
      streams.c,
    ]);
    expect(Object.fromEntries(halls.map((r) => [r.id, r.hall]))).toEqual({
      [streams.a]: "12",
      [streams.b]: null,
      [streams.c]: null,
    });
    const [gone] = await pg`select to_regclass(${`app_${key}_prod.session`}) as r`;
    expect(gone?.r).toBeNull();
    const tables = await pg`
      select table_name from information_schema.tables where table_schema = ${archive()} order by 1`;
    expect(tables).toHaveLength(3);
    let archived = "";
    for (const { table_name } of tables)
      for (const r of await pg.unsafe(
        `select row_to_json(x)::text as j from "${archive()}"."${table_name}" x`,
      ))
        archived += r.j;
    for (const v of ["Про магазины", "Про платежи", "Про рекламу", "Большой", "Открытие"])
      expect(archived).toContain(v);
    const denied = await pg
      .begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
        return tx.unsafe(`select * from "${archive()}"."${tables[0]?.table_name}"`);
      })
      .catch((e: { code?: string }) => e);
    expect((denied as { code?: string }).code).toBe("42501");
    const s = await sys(systemId);
    expect([s.prod_revision, s.schema_hwm_revision]).toEqual([destructiveRev, destructiveRev]);
  });

  test("markApplied takes only a confirmation still waiting: an applied one throws and the transaction rolls back", async () => {
    const pg = api.deps.pg;
    const [row] = await pg`
      select id, publication_id, archive_tables from platform.destructive_changes
       where system_id = ${systemId} and status = 'applied'`;
    expect(row).toBeDefined();
    const marker = `wz-mark-${randomUUID()}`;
    const err = await pg
      .begin(async (tx) => {
        await tx`update platform.systems set name = ${marker} where id = ${systemId}`;
        await markApplied(tx, {
          changeId: row?.id,
          publicationId: randomUUID(),
          baseRevision: 1,
          schema: "x",
          tables: [],
        });
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "DESTRUCTIVE_IN_PROD" });
    const [after] = await pg`
      select d.publication_id, d.archive_tables, s.name from platform.destructive_changes d
        join platform.systems s on s.id = d.system_id where d.id = ${row?.id}`;
    expect(after).toMatchObject({ publication_id: row?.publication_id, archive_tables: row?.archive_tables });
    expect(after?.name).not.toBe(marker);
  });

  test("journal; editor cannot undo; a plain rollback past the change is refused", async () => {
    const j = await api.req("GET", `/systems/${systemId}/destructive/changes`);
    expect(j.status).toBe(200);
    expectContract("listDestructiveChanges", j);
    // One confirmation: new records after it did not make the owner confirm again.
    expect(j.body.items.map((x: { status: string }) => x.status)).toEqual(["applied"]);
    expect(j.body.undo).toMatchObject({ changeId: j.body.items[0].id, toRevision: baseRev });
    const asEditor = await api.req(
      "POST",
      `/systems/${systemId}/destructive/changes/${j.body.undo.changeId}/undo`,
      {
        headers: EDITOR,
      },
    );
    expect(asEditor.status).toBe(403);
    expect(asEditor.body.code).toBe("NOT_OWNER");
    const rb = await api.req("POST", `/systems/${systemId}/rollback`, {
      body: { env: "prod", toRevision: baseRev },
    });
    expect(rb.status).toBe(202);
    const run = await waitRun(api, rb.body.run.id, ["succeeded", "failed"], 20_000);
    expect(run.status).toBe("failed");
    expect(run.failure.code).toBe("ROLLBACK_TARGET_INVALID");
    expect(run.failure.message_ru).toMatch(/Отменить правку/);
  });

  test("«Отменить правку» restores the field, the original values and the entity", async () => {
    const j = await api.req("GET", `/systems/${systemId}/destructive/changes`);
    const res = await api.req(
      "POST",
      `/systems/${systemId}/destructive/changes/${j.body.undo.changeId}/undo`,
    );
    expect(res.status, res.text).toBe(202);
    expectContract("undoDestructiveChange", res);
    const run = await waitRun(api, res.body.run.id, ["succeeded", "failed"], 20_000);
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
    const pg = api.deps.pg;
    const rows = await pg.unsafe(
      `select id, description, hall from ${prod()}.stream where id in ($1, $2, $3)`,
      [streams.a, streams.b, streams.c],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.description, r.hall]]))).toEqual({
      [streams.a]: ["Про магазины", "12"],
      [streams.b]: ["Про платежи", "Большой"],
      [streams.c]: [null, null],
    });
    const sessions = await pg.unsafe(`select title, stream from ${prod()}.session`);
    expect(sessions.map((r) => [r.title, r.stream])).toEqual([["Открытие", streams.a]]);
    const s = await sys(systemId);
    expect([s.prod_revision, s.schema_hwm_revision]).toEqual([baseRev, baseRev]);
    const after = await api.req("GET", `/systems/${systemId}/destructive/changes`);
    expect(after.body.items[0]).toMatchObject({ status: "undone", undoable: false });
    expect(after.body.items[0].undoneAt).toEqual(expect.any(String));
    expect(after.body.undo).toBeNull();
    const pubs = (await api.req("GET", `/systems/${systemId}/publications`)).body.items;
    expect(pubs[0]).toMatchObject({ revision: baseRev, status: "live" });
    // The revision can be published again only with a new confirmation.
    const again = await api.req("GET", `/systems/${systemId}/destructive?revision=${destructiveRev}`);
    expect(again.body).toMatchObject({ required: true, confirmation: null });
  });
});
