// M1-07 import over HTTP (api.yaml#createImport/getImport/updateImportMapping, workflows.yaml#import_table): the
// mapper (mock T1) sees only the SyntheticPayload; confirm → new_field through the builder → rows in app_<key>_draft;
// the source file is stored encrypted with a 7-day TTL.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRouter } from "@wizard/llm";
import { writeXlsx } from "@wizard/pii/import";
import { schemaName } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { canaryGrid, canaryNeedles, canaryRows } from "../../../packages/pii/test/import-canaries.js";
import { migrateDraft } from "../src/agents/draft.js";
import { DEFAULT_ORG_ID } from "../src/db/index.js";
import { ImportStore, sweepExpiredImports } from "../src/imports/storage.js";
import { IMPORT_CAP_MILLI } from "../src/imports/workflow.js";
import type { RunExecutors } from "../src/runs/types.js";
import { toCard } from "./flow.js";
import {
  createTestDb,
  fakeInterview,
  passingReport,
  startApi,
  type TestApi,
  waitFor,
  waitRun,
} from "./helpers.js";
import { ENV, importBuild, mockProviders, SHEET } from "./import-fixtures.js";
import { expectContract } from "./session.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let pg: postgres.Sql;
let api: TestApi;
let systemId: string;
let systemKey: string;
const mock = mockProviders();
const cards: Record<string, unknown>[] = [];
const rows = canaryRows(50);
const sources: string[] = ["Сайт", "Реклама", "Рекомендация"];

function xlsx(): Uint8Array {
  const grid = canaryGrid(rows).map((r, i) => [...r, i === 0 ? "Источник" : (sources[i % 3] ?? "")]);
  return writeXlsx([{ name: SHEET, rows: grid }]);
}

function upload(data: Uint8Array | Blob, name = "Клиенты Рахимова.xlsx") {
  const form = new FormData();
  form.set("file", data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>]), name);
  return api.req("POST", `/systems/${systemId}/imports`, { body: form });
}

async function awaitingConfirm(importId: string) {
  return waitFor(async () => {
    const r = await api.req("GET", `/systems/${systemId}/imports/${importId}`);
    return r.body.status === "awaiting_confirm" && r.body.inputId ? r : undefined;
  });
}

beforeAll(async () => {
  tdb = await createTestDb("imports", { migrator: true });
  pg = postgres(tdb.url, { max: 2, onnotice: () => {} });
  api = await startApi(tdb.url, {
    executors: ({ pg: db }): RunExecutors => ({
      interviewTurn: fakeInterview,
      build: (host, p) => importBuild(host, p, cards),
      gates: async (level, ctx) => passingReport(level, ctx.specVersion),
      onG0Passed: async (a) => {
        await migrateDraft(db, { systemKey: a.systemKey, spec: a.spec, prevSpec: a.prevSpec });
        return { bundleKey: `${a.systemKey}/${a.revision}` };
      },
    }),
    createRouter: (opts) =>
      createRouter({ ...opts, mode: "live", env: ENV, fetch: mock.fetch, sleep: async () => {} }),
  });
  const c = await toCard(api, "CRM для клиентов пекарни");
  const ap = await api.req("POST", `/systems/${c.systemId}/card/approve`, {
    body: { cardVersion: c.cardVersion },
  });
  await waitRun(api, ap.body.run.id, ["succeeded"]);
  systemId = c.systemId;
  const [s] = await pg`select schema_key from platform.systems where id = ${systemId}`;
  systemKey = s?.schema_key;
  mock.requests.length = 0;
});
afterAll(async () => {
  await pg?.end();
  await api?.dispose();
  await tdb?.drop();
});

describe("import_table over HTTP", () => {
  test("upload → profile/map (T1 sees no canary) → edit mapping → confirm → new field via builder → 50 rows", async () => {
    const created = await upload(xlsx());
    expect(created.status).toBe(202);
    expectContract("createImport", created);
    const importId = created.body.importId as string;
    const runId = created.body.run.id as string;
    expect(created.body.run).toMatchObject({ kind: "import_table", status: "queued" });

    const got = await awaitingConfirm(importId);
    expectContract("getImport", got);
    expect(got.body).toMatchObject({ id: importId, runId, status: "awaiting_confirm", rowsImported: null });
    expect(got.body.profile.map((p: { column: string }) => p.column)).toEqual([
      "ФИО клиента",
      "Телефон",
      "Почта",
      "Город",
      "Сумма заказа",
      "Комментарий",
      "Источник",
    ]);
    const phone = got.body.profile.find((p: { column: string }) => p.column === "Телефон");
    expect(phone).toMatchObject({ typeGuess: "phone", piiKindGuess: "phone", nullShare: 0, distinct: 50 });
    const byCol = Object.fromEntries(got.body.mapping.map((m: { column: string }) => [m.column, m]));
    expect(byCol.Телефон).toEqual({
      column: "Телефон",
      action: "map",
      entity: "client",
      field: "phone",
      pii: "basic",
    });
    expect(byCol.Источник).toMatchObject({ action: "new_field", entity: "client", field: "source" });
    // Neither the screen data nor any provider request carries a cell value; the sheet name was scrubbed for T1.
    const needles = canaryNeedles(rows);
    // The user's own sheet name is shown to the user (not a cell value); it never reaches T1.
    for (const n of needles.filter((x) => !SHEET.includes(x))) expect(got.text).not.toContain(n);
    expect(mock.requests.map((r) => r.provider)).toEqual(["zai"]);
    for (const r of mock.requests) for (const n of needles) expect(r.body, n).not.toContain(n);
    expect(mock.requests[0]?.body).toContain("sheet_1");
    const [call] = await pg`select call_type, tier, scrubbed from platform.llm_calls where run_id = ${runId}`;
    expect(call).toMatchObject({ call_type: "import_mapping", tier: "T1", scrubbed: true });

    // PUT: problems → 422; «Комментарий» is skipped by the user; «Город» keeps its personal-data mark off.
    const path = `/systems/${systemId}/imports/${importId}/mapping`;
    const bad = await api.req("PUT", path, {
      body: {
        mapping: [
          { column: "Нет такой", action: "skip" },
          { column: "Город", action: "map", entity: "client", field: "nope" },
        ],
      },
    });
    expect(bad.status).toBe(422);
    expectContract("updateImportMapping", bad);
    expect(bad.body.details.problems).toHaveLength(2);
    expect(
      (await api.req("PUT", path, { body: { mapping: [{ column: "Телефон", action: "drop" }] } })).status,
    ).toBe(400);
    const edited = got.body.mapping.map((m: { column: string }) =>
      m.column === "Комментарий" ? { column: "Комментарий", action: "skip", pii: "basic" } : m,
    );
    const put = await api.req("PUT", path, { body: { mapping: edited } });
    expect(put.status).toBe(200);
    expectContract("updateImportMapping", put);
    expect(put.body.mapping.find((m: { column: string }) => m.column === "Комментарий")).toEqual({
      column: "Комментарий",
      action: "skip",
      pii: "basic",
    });

    const input = await api.req("POST", `/runs/${runId}/input`, {
      body: { inputId: got.body.inputId, choice: "confirm" },
    });
    expect(input.status).toBe(202);
    const run = await waitRun(api, runId, ["succeeded", "failed", "cancelled"], 20_000);
    expect(run).toMatchObject({ status: "succeeded", failure: null });
    expect(run.resultRevision).toBeGreaterThan(0);
    expect((await api.req("PUT", path, { body: { mapping: edited } })).status).toBe(409);

    // schema_ops: the builder got the new field (payload names only) and the draft schema has the column.
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: "change",
      importFields: [{ entity: "client", field: "source", label: "Источник", type: "string", pii: "none" }],
    });
    const done = await api.req("GET", `/systems/${systemId}/imports/${importId}`);
    expect(done.body).toMatchObject({ status: "done", rowsImported: 50, inputId: null });
    const db = await pg.unsafe(
      `select full_name, phone, source, note from ${schemaName(systemKey, "draft")}.client order by total`,
    );
    expect(db.map((r) => r.full_name)).toEqual(rows.map((r) => r.name));
    expect(db.map((r) => r.source)).toEqual(rows.map((_, i) => sources[(i + 1) % 3]));
    expect(db.every((r) => r.note === null)).toBe(true);
    for (const r of mock.requests.filter((x) => x.provider === "zai"))
      for (const n of needles) expect(r.body, n).not.toContain(n);
    const events =
      await pg`select type, payload from platform.run_events where run_id = ${runId} order by seq`;
    const steps = events.filter((e) => e.type === "step_started").map((e) => e.payload.step);
    expect(steps).toEqual(expect.arrayContaining(["profile", "map", "schema_ops", "load_rows"]));
    expect(events.find((e) => e.type === "needs_input")?.payload).toMatchObject({
      kind: "decision",
      decisionId: "import_confirm",
    });

    // At rest: encrypted, no plaintext, tampering is detected.
    const dir = api.deps.config.importsDir;
    const raw = readFileSync(join(dir, `${importId}.enc`));
    expect(raw.subarray(0, 4).toString()).toBe("WZI1");
    for (const n of ["kanareyka-test", "Рахимов", rows[0]?.phone ?? ""])
      expect(raw.includes(Buffer.from(n))).toBe(false);
    const [{ source_sha }] =
      (await pg`select source_sha from platform.imports where id = ${importId}`) as never as [
        { source_sha: string },
      ];
    const store = new ImportStore(dir, api.deps.config.secretsKey);
    expect((await store.get(importId, source_sha)).subarray(0, 2).toString()).toBe("PK");
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    mkdirSync(join(dir, "copy"), { recursive: true });
    writeFileSync(join(dir, "copy", `${importId}.enc`), raw);
    await expect(
      new ImportStore(join(dir, "copy"), api.deps.config.secretsKey).get(importId),
    ).rejects.toThrow();
    await expect(new ImportStore(dir, "another-key-another-key-another-key").get(importId)).rejects.toThrow();
  });

  test("cancel at confirm → run cancelled, import failed, nothing loaded", async () => {
    const before = await pg.unsafe(`select count(*)::int as n from ${schemaName(systemKey, "draft")}.client`);
    const created = await upload(xlsx());
    const got = await awaitingConfirm(created.body.importId);
    await api.req("POST", `/runs/${created.body.run.id}/input`, {
      body: { inputId: got.body.inputId, choice: "cancel" },
    });
    await waitRun(api, created.body.run.id, ["cancelled"]);
    const after = await api.req("GET", `/systems/${systemId}/imports/${created.body.importId}`);
    expect(after.body.status).toBe("failed");
    const n = await pg.unsafe(`select count(*)::int as n from ${schemaName(systemKey, "draft")}.client`);
    expect(n[0]?.n).toBe(before[0]?.n);
  });

  test("limits and formats: > 20 MB → 413, .xls → 415, broken file → 400; system without preview → 409", async () => {
    const big = await upload(new Blob([new Uint8Array(21 * 1024 * 1024)]), "big.csv");
    expect(big.status).toBe(413);
    expectContract("createImport", big);
    const xls = await upload(
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]),
      "old.xls",
    );
    expect(xls.status).toBe(415);
    const broken = await upload(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]), "x.xlsx");
    expect(broken.status).toBe(400);
    expect((await api.req("POST", `/systems/${systemId}/imports`, { body: {} })).status).toBe(400);
    const fresh = await api.req("POST", "/systems", { body: { prompt: "Ещё одна система" } });
    const form = new FormData();
    form.set("file", new Blob([xlsx() as Uint8Array<ArrayBuffer>]), "a.xlsx");
    const r = await api.req("POST", `/systems/${fresh.body.system.id}/imports`, { body: form });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("PREVIEW_NOT_READY");
    expect(
      (await api.req("GET", `/systems/${systemId}/imports/00000000-0000-4000-8000-000000000000`)).status,
    ).toBe(404);
  });

  test("TTL: after 7 days the file is deleted and an unfinished import expires", async () => {
    const created = await upload(xlsx());
    const importId = created.body.importId as string;
    await awaitingConfirm(importId);
    const dir = api.deps.config.importsDir;
    expect(readdirSync(dir)).toContain(`${importId}.enc`);
    const [row] =
      await pg`select extract(epoch from expires_at - created_at)::float8 as ttl from platform.imports where id = ${importId}`;
    expect(Math.abs(Number(row?.ttl) - 7 * 24 * 3600)).toBeLessThan(10);
    await api.engine.cancel(created.body.run.id);
    await waitRun(api, created.body.run.id, ["cancelled"]);
    await pg`update platform.imports set status = 'awaiting_confirm', expires_at = now() - interval '1 minute' where id = ${importId}`;
    const store = new ImportStore(dir, api.deps.config.secretsKey);
    expect(await sweepExpiredImports(api.deps.db, store)).toBeGreaterThanOrEqual(1);
    expect(readdirSync(dir)).not.toContain(`${importId}.enc`);
    const g = await api.req("GET", `/systems/${systemId}/imports/${importId}`);
    expect(g.body.status).toBe("expired");
  });
});

describe("import_table credits (billing.yaml#run_charging, FU-6)", () => {
  const ledger = async (runId: string): Promise<Record<string, number>> =>
    Object.fromEntries(
      (
        await pg`select kind, sum(amount_milli)::int as s from platform.credit_ledger
                 where run_id = ${runId} group by kind`
      ).map((r) => [String(r.kind), Number(r.s)]),
    );

  test("upload holds the import cap; the finish releases it and charges the mapping by fact", async () => {
    const created = await upload(xlsx());
    expect(created.status).toBe(202);
    const runId = created.body.run.id as string;
    expect(await ledger(runId)).toEqual({ hold: -IMPORT_CAP_MILLI });
    const got = await awaitingConfirm(created.body.importId);
    await api.req("POST", `/runs/${runId}/input`, { body: { inputId: got.body.inputId, choice: "cancel" } });
    await waitRun(api, runId, ["cancelled"]);
    const [u] =
      await pg`select coalesce(sum(credits_milli), 0)::int as used from platform.llm_calls where run_id = ${runId} and billable`;
    const used = Number(u?.used);
    expect(used).toBeGreaterThan(0);
    const l = await ledger(runId);
    expect(l).toMatchObject({
      hold: -IMPORT_CAP_MILLI,
      release: IMPORT_CAP_MILLI,
      charge: -Math.min(used, IMPORT_CAP_MILLI),
    });
    expect(l.refund).toBeUndefined();
  });

  test("an org (not exempt) without the import cap available → 402 INSUFFICIENT_CREDITS, the file is not kept", async () => {
    const strict = await startApi(tdb.url, {
      config: {
        billingExemptOrgs: [],
        artifactsDir: api.artifactsDir,
        importsDir: api.deps.config.importsDir,
        secretsKey: api.deps.config.secretsKey,
      },
      recover: false,
      creditsCronMs: 0,
    });
    try {
      const b = strict.deps.billing;
      const { available } = await b.readBalance(strict.deps.db, DEFAULT_ORG_ID);
      const adjust = (amountMilli: number, key: string) =>
        strict.deps.db
          .transaction()
          .execute((trx) => b.adjust(trx, DEFAULT_ORG_ID, { amountMilli, key, note: "тест" }));
      await adjust(10_000 - available, "fu6:drain");
      const files = readdirSync(api.deps.config.importsDir).length;
      const form = new FormData();
      form.set("file", new Blob([xlsx() as Uint8Array<ArrayBuffer>]), "a.xlsx");
      const r = await strict.req("POST", `/systems/${systemId}/imports`, { body: form });
      expect(r.status).toBe(402);
      expect(r.body).toMatchObject({
        code: "INSUFFICIENT_CREDITS",
        details: { available: 10, required: 15 },
      });
      expect(readdirSync(api.deps.config.importsDir)).toHaveLength(files);
      const [n] = await pg`select count(*)::int as n from platform.imports where status = 'profiling'`;
      expect(n?.n).toBe(0);
      await adjust(available - 10_000, "fu6:restore");
    } finally {
      await strict.dispose();
    }
  });
});
