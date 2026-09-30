// M1 exit criterion (M1-04): «Публикация в prod с аддитивной миграцией на живых данных и откат к предыдущей ревизии».
// «Форум» end to end over the platform API and the prod host of a real runtime (DbRegistry over platform.deployments):
// build (real gates G0, migrate_draft, seed_draft, bundle) → operator data → publish → live data in prod → change
// build adding fields (draft_snapshot masks PII) → human diff → publish (additive migration, data kept) → rollback of
// prod to the previous revision (no DDL: data and the new column stay, the old screens work).
// The builder is scripted (forum.json as ops + specs/runtime/examples): no LLM involved.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createAgentExecutors, createPlatformApi, type PlatformApi, RunFailure } from "@wizard/platform-api";
import { DbRegistry, startRuntime } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const BASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
const DB = `wz_e2e_publish_${randomBytes(4).toString("hex")}`;
const PII = { name: "Иван Петров", email: "ivan.petrov@mail.ru", phone: "+79161234567" };

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field in the test
type Json = any;
type Api = PlatformApi & {
  req(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }>;
};

let admin: postgres.Sql;
let pg: postgres.Sql;
let api: Api;
let runtime: { close(): Promise<void> };
let port = 0;
let artifacts = "";
let changeOps: unknown[] = [];

/** Forum code of specs/runtime/examples (bakery excluded) as the builder would write it. */
function forumFiles(): Map<string, string> {
  const base = join(ROOT, "specs/runtime/examples");
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(base, abs);
      if (rel === "bakery") continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(name)) out.set(rel, readFileSync(abs, "utf8"));
    }
  };
  walk(base);
  return out;
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const p = (srv.address() as { port: number }).port;
  await new Promise((r) => srv.close(r));
  return p;
}

const CARD = {
  title: "Форум «Северный ритейл»",
  summary: "Регистрация, билеты с QR, модерация докладов",
  estimate: { credits: { min: 10, expected: 20, max: 30 }, minutes: { expected: 8 } },
  cap: { credits: 40 },
};

type BuildHost = Parameters<ReturnType<typeof createAgentExecutors>["build"]>[0];
type BuildParams = Parameters<ReturnType<typeof createAgentExecutors>["build"]>[1];

async function scriptedBuild(host: BuildHost, p: BuildParams) {
  const { version } = await host.store.getSpec();
  let ops: unknown[][] = [changeOps];
  if (p.mode === "create") {
    const lib = (await import(join(ROOT, "tools/fixtures/lib/spec-to-ops.mjs"))) as {
      specToOps(spec: unknown, o: { author: string }): unknown[];
      batchOps(ops: unknown[]): unknown[][];
    };
    const spec = JSON.parse(readFileSync(join(ROOT, "specs/appspec/examples/forum.json"), "utf8"));
    ops = lib.batchOps(lib.specToOps(spec, { author: "agent" }));
  }
  let v = version;
  for (const [i, batch] of ops.entries()) {
    const r = await host.store.applyOps(batch as never, v, `${host.run.id}:ops_${i}:1`);
    if (!r.ok) throw new RunFailure("GATES_FAILED", JSON.stringify(r.errors));
    v = r.version;
  }
  if (p.mode === "create") for (const [path, src] of forumFiles()) await host.store.writeFile(path, src);
  await host.store.commitFiles();
  const report = await host.runGates("G0");
  if (!report.passed)
    throw new RunFailure(
      "GATES_FAILED",
      JSON.stringify(report.checks.filter((c) => c.status === "fail" || c.status === "error")),
    );
  return { summary_ru: "Собрано" };
}

beforeAll(async () => {
  admin = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${DB}`);
  for (const role of ["wizard_owner", "wizard_runtime"])
    await admin.unsafe(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$`);
  await admin.unsafe(`GRANT CREATE ON DATABASE ${DB} TO wizard_owner`);
  const url = new URL(BASE_URL);
  url.pathname = `/${DB}`;
  pg = postgres(url.toString(), { max: 4, onnotice: () => {} });
  artifacts = mkdtempSync(join(tmpdir(), "wz-e2e-publish-"));
  port = await freePort();

  const platform = await createPlatformApi({
    config: { dbUrl: url.toString(), artifactsDir: artifacts, authMode: "dev", runtimePort: port },
    executors: (d) => ({
      ...createAgentExecutors(d),
      interviewTurn: async () => ({ kind: "card", text: "Карточка", card: CARD }),
      build: scriptedBuild,
    }),
    log: () => {},
  });
  const req: Api["req"] = async (method, path, body) => {
    const res = await platform.fetch(
      new Request(`http://localhost:4000/api/v1${path}`, {
        method,
        headers: { host: "localhost:4000", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
  };
  api = Object.assign(platform, { req });
  const rt = await startRuntime({
    db: pg,
    registry: new DbRegistry(pg),
    artifactsRoot: artifacts,
    port,
    env: { systemsDomain: "localhost" },
  });
  runtime = rt;
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  await api?.close();
  await pg?.end();
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin?.end();
  if (artifacts) rmSync(artifacts, { recursive: true, force: true });
}, 60_000);

async function waitRun(id: string, ms = 180_000) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await api.req("GET", `/runs/${id}`);
    if (["succeeded", "failed", "cancelled"].includes(r.body.status)) return r.body;
    if (Date.now() > until) throw new Error(`run ${id} timeout`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

/** The prod host through the real runtime HTTP server (<slug>.localhost → loopback with an explicit Host). */
function prodGet(slug: string, path: string): Promise<{ status: number; text: string; json: Json }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, agent: false, headers: { host: `${slug}.localhost:${port}` } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text,
            json: text.startsWith("{") ? JSON.parse(text) : null,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function approveAndBuild(systemId: string) {
  const s = await api.req("GET", `/systems/${systemId}`);
  expect(s.body.system.stage).toBe("card");
  const ap = await api.req("POST", `/systems/${systemId}/card/approve`, {
    cardVersion: s.body.card.cardVersion,
  });
  expect(ap.status).toBe(202);
  const run = await waitRun(ap.body.run.id);
  expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
  return (await api.req("GET", `/systems/${systemId}`)).body.system;
}

async function publish(systemId: string, revision: number) {
  const res = await api.req("POST", `/systems/${systemId}/publish`, { revision, confirmDiff: true });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const run = await waitRun(res.body.run.id);
  expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
  return run;
}

describe("форум: prod с данными → ревизия с полем → публикация → откат", () => {
  let systemId = "";
  let slug = "";
  let key = "";
  let firstRev = 0;
  let fieldRev = 0;
  const prod = () => `"app_${key}_prod"`;

  test("build → operator data → first publish: the prod host serves the revision", async () => {
    const created = await api.req("POST", "/systems", { prompt: "Регистрация на форум «Северный ритейл»" });
    expect(created.status).toBe(201);
    systemId = created.body.system.id;
    slug = created.body.system.slug;
    await waitRun(created.body.run.id);
    const built = await approveAndBuild(systemId);
    const [row] = await pg`select schema_key from platform.systems where id = ${systemId}`;
    key = row?.schema_key;

    const blocked = await api.req("POST", `/systems/${systemId}/publish`, {
      revision: built.previewRevision,
    });
    expect(blocked.body.code).toBe("OPERATOR_NAME_REQUIRED");
    const put = await api.req("PUT", `/systems/${systemId}/compliance`, {
      expectedVersion: built.draftRevision,
      operatorName: "ООО «Северный ритейл»",
      operatorContact: "privacy@north-retail.example",
    });
    expect(put.status).toBe(200);
    firstRev = put.body.revision.version;

    const run = await publish(systemId, firstRev);
    expect(run.resultRevision).toBe(firstRev);
    const health = await prodGet(slug, "/_wizard/health");
    expect(health.json).toMatchObject({ status: "ok", env: "prod", revision: firstRev });
    expect((await prodGet(slug, "/")).status).toBe(200);
    const sys = (await api.req("GET", `/systems/${systemId}`)).body.system;
    expect(sys.prodRevision).toBe(firstRev);
    expect(sys.prodUrl).toBe(`http://${slug}.localhost:${port}/`);
  }, 240_000);

  test("live data in prod, readable through the prod data API", async () => {
    await pg.begin(async (tx) => {
      const [u] = await tx.unsafe(
        `insert into ${prod()}.users (role, display_name, email, phone) values ('participant', $1, $2, $3) returning id`,
        [PII.name, PII.email, PII.phone],
      );
      const [st] = await tx.unsafe(
        `insert into ${prod()}.stream (name, capacity) values ('Ритейл-тех', 300) returning id`,
      );
      const [tt] = await tx.unsafe(
        `insert into ${prod()}.ticket_type (name, kind, price, capacity) values ('Стандарт', 'standard', 5000, 500) returning id`,
      );
      await tx.unsafe(
        `insert into ${prod()}.ticket (ticket_type, stream, holder_user, holder_name, holder_email, holder_phone, status, amount, event_starts_at)
         values ($1, $2, $3, $4, $5, $6, 'pending_payment', 5000, now() + interval '30 days')`,
        [tt?.id, st?.id, u?.id, PII.name, PII.email, PII.phone],
      );
    });
    const list = await prodGet(slug, "/api/data/stream");
    expect(list.status, list.text).toBe(200);
    expect(list.json.items.map((x: { name: string }) => x.name)).toEqual(["Ритейл-тех"]);
  });

  test("change build adds fields; the draft gets a masked copy of prod; the diff is human-readable", async () => {
    changeOps = [
      {
        op: "add_field",
        entity: "stream",
        field: { name: "hall", label: "Зал", type: "string", required: true, default: "Главный" },
      },
      { op: "add_field", entity: "stream", field: { name: "floor", label: "Этаж", type: "int" } },
    ];
    const msg = await api.req("POST", `/systems/${systemId}/messages`, { text: "Добавь зал и этаж потоку" });
    await waitRun(msg.body.run.id);
    const sys = await approveAndBuild(systemId);
    fieldRev = sys.previewRevision;
    expect(fieldRev).toBe(sys.draftRevision);

    const draft = `"app_${key}_draft"`;
    const [t] = await pg.unsafe(`select holder_name, holder_email from ${draft}.ticket`);
    expect(t).toBeDefined();
    const tables =
      await pg`select table_name from information_schema.tables where table_schema = ${`app_${key}_draft`}`;
    let dump = "";
    for (const { table_name } of tables)
      for (const r of await pg.unsafe(`select row_to_json(x)::text as j from ${draft}."${table_name}" x`))
        dump += r.j;
    for (const v of Object.values(PII)) expect(dump).not.toContain(v);

    const diff = await api.req("GET", `/systems/${systemId}/revisions/${fieldRev}/diff?from=${firstRev}`);
    const texts = diff.body.changes.map((c: { text_ru: string }) => c.text_ru);
    expect(texts).toContain("В «Поток» добавлено поле «Зал» (строка, обязательное)");
    expect(texts).toContain("В «Поток» добавлено поле «Этаж» (целое число)");
  }, 240_000);

  test("publish with an additive migration on live data: rows kept, new column backfilled", async () => {
    await publish(systemId, fieldRev);
    const health = await prodGet(slug, "/_wizard/health");
    expect(health.json.revision).toBe(fieldRev);
    const list = await prodGet(slug, "/api/data/stream");
    expect(list.json.items).toEqual([expect.objectContaining({ name: "Ритейл-тех", hall: "Главный" })]);
    const [ticket] = await pg.unsafe(`select holder_email from ${prod()}.ticket`);
    expect(ticket?.holder_email).toBe(PII.email);
  }, 240_000);

  test("rollback of prod to the previous revision: no DDL, data and the new column intact, old screens work", async () => {
    const res = await api.req("POST", `/systems/${systemId}/rollback`, { env: "prod", toRevision: firstRev });
    expect(res.status).toBe(202);
    const run = await waitRun(res.body.run.id);
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");

    expect((await prodGet(slug, "/_wizard/health")).json.revision).toBe(firstRev);
    expect((await prodGet(slug, "/")).status).toBe(200);
    const spec = await prodGet(slug, "/_wizard/spec");
    expect(spec.status).toBe(200);
    const list = await prodGet(slug, "/api/data/stream");
    expect(list.status).toBe(200);
    expect(list.json.items.map((x: { name: string }) => x.name)).toEqual(["Ритейл-тех"]);
    expect(list.json.items[0].hall).toBeUndefined(); // the revision's spec does not know the column
    const rows = await pg.unsafe(`select name, hall from ${prod()}.stream`);
    expect(rows).toEqual([{ name: "Ритейл-тех", hall: "Главный" }]);
    // The superset schema keeps accepting rows written by the old revision (no value for the new column).
    await pg.unsafe(`insert into ${prod()}.stream (name, capacity) values ('Логистика', 200)`);
    const after = await prodGet(slug, "/api/data/stream");
    expect(after.json.items).toHaveLength(2);
    const pubs = (await api.req("GET", `/systems/${systemId}/publications`)).body.items;
    expect(pubs.map((p: { revision: number; status: string }) => [p.revision, p.status])).toEqual([
      [firstRev, "live"],
      [fieldRev, "superseded"],
      [firstRev, "superseded"],
    ]);
  }, 120_000);
});
