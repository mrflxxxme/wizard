// M1-01 × M1-07/FU-6: import_table in the worker survives kill -9 at the confirm step — the mapping the user edits
// while the worker is down is kept (no second mapping call), the confirm sent meanwhile is delivered, rows load once,
// settlement is written once, and no cell value reaches dbos.*. Also with the kill between the needs_input
// transaction and its checkpoint: the re-run step keeps the input id the confirm was sent for.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeXlsx } from "@wizard/pii/import";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { canaryGrid, canaryNeedles, canaryRows } from "../../../packages/pii/test/import-canaries.js";
import { listEvents } from "../../platform-api/src/runs/events.js";
import { loadEventSchemas } from "../../platform-api/test/event-schemas.js";
import { toCard } from "../../platform-api/test/flow.js";
import { createTestDb, startApi, type TestApi, waitFor, waitRun } from "../../platform-api/test/helpers.js";
import { SHEET } from "../../platform-api/test/import-fixtures.js";
import { ENTRY, type Proc, start, stopProc, waitOut } from "./proc.js";
import { scriptedExecutors } from "./support.js";

const schemas = loadEventSchemas();
const rows = canaryRows(50);
let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let env: Record<string, string>;
const procs: Proc[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  tdb = await createTestDb("wimport", { migrator: true });
  const tmp = (p: string) => {
    const d = mkdtempSync(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  const config = {
    dbUrl: tdb.url,
    artifactsDir: tmp("wz-wimp-art-"),
    stepsDir: tmp("wz-wimp-steps-"),
    secretsFile: join(tmp("wz-wimp-sec-"), "secrets.enc"),
    authMode: "dev",
  };
  api = await startApi(tdb.url, { engine: "dbos", config, executors: scriptedExecutors() });
  env = {
    WIZARD_DB_URL: tdb.url,
    WZ_ENTRY_MODE: "import",
    WZ_ARTIFACTS: config.artifactsDir,
    WZ_STEPS: config.stepsDir,
    WZ_SECRETS: config.secretsFile,
  };
}, 60_000);

afterAll(async () => {
  for (const p of procs) await stopProc(p, "SIGKILL");
  await api?.dispose();
  await tdb?.drop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function worker(extra: Record<string, string> = {}): Promise<Proc> {
  const p = start(ENTRY, { ...env, ...extra });
  procs.push(p);
  await waitOut(p, '"msg":"ready"');
  return p;
}

/** `hangAfter`: worker 1 hangs after that step's side effects, before its checkpoint, and is killed there. */
async function killAtConfirm(hangAfter?: string): Promise<void> {
  const w1 = await worker(hangAfter ? { WZ_FAULT_HANG_AFTER: hangAfter } : {});
  const c = await toCard(api, "CRM для клиентов пекарни");
  const ap = await api.req("POST", `/systems/${c.systemId}/card/approve`, {
    body: { cardVersion: c.cardVersion },
  });
  await waitRun(api, ap.body.run.id, ["succeeded"], 30_000);

  const grid = canaryGrid(rows).map((r, i) => [...r, i === 0 ? "Источник" : "Сайт"]);
  const form = new FormData();
  form.set("file", new Blob([writeXlsx([{ name: SHEET, rows: grid }]) as Uint8Array<ArrayBuffer>]), "k.xlsx");
  const created = await api.req("POST", `/systems/${c.systemId}/imports`, { body: form });
  expect(created.status, created.text).toBe(202);
  const importId = created.body.importId as string;
  const runId = created.body.run.id as string;
  const got = await waitFor(async () => {
    const r = await api.req("GET", `/systems/${c.systemId}/imports/${importId}`);
    return r.body.status === "awaiting_confirm" && r.body.inputId ? r : undefined;
  }, 30_000);

  if (hangAfter) await waitOut(w1, '"msg":"fault_hang"');
  w1.child.kill("SIGKILL");
  await w1.exited;
  if (hangAfter) {
    const [cp] = await api.deps.pg`
      select count(*)::int as n from dbos.operation_outputs
      where workflow_uuid = ${runId} and function_name = ${hangAfter}`;
    expect(cp?.n, "killed inside the commit→checkpoint window").toBe(0);
  }
  // While the worker is down: the user skips «Комментарий» and confirms.
  const edited = got.body.mapping.map((m: { column: string }) =>
    m.column === "Комментарий" ? { column: "Комментарий", action: "skip", pii: "basic" } : m,
  );
  const put = await api.req("PUT", `/systems/${c.systemId}/imports/${importId}/mapping`, {
    body: { mapping: edited },
  });
  expect(put.status, put.text).toBe(200);
  const input = await api.req("POST", `/runs/${runId}/input`, {
    body: { inputId: got.body.inputId, choice: "confirm" },
  });
  expect(input.status).toBe(202);

  const w2 = await worker();
  const run = await waitRun(api, runId, ["succeeded", "failed", "cancelled"], 60_000);
  expect(run, JSON.stringify(run.failure)).toMatchObject({ status: "succeeded" });

  const done = await api.req("GET", `/systems/${c.systemId}/imports/${importId}`);
  expect(done.body).toMatchObject({ status: "done", rowsImported: 50 });
  const [s] = await api.deps.pg`select schema_key from platform.systems where id = ${c.systemId}`;
  const loaded = await api.deps.pg.unsafe(
    `select full_name, note, source from "app_${s?.schema_key}_draft".client`,
  );
  expect(loaded).toHaveLength(50);
  expect(loaded.every((r) => r.note === null)).toBe(true);
  expect(loaded.every((r) => r.source === "Сайт")).toBe(true);

  // The mapping call ran before the kill and was not repeated.
  const calls = await api.deps.pg<{ call_type: string }[]>`
    select call_type from platform.llm_calls where run_id = ${runId}`;
  expect(calls.filter((x) => x.call_type === "import_mapping")).toHaveLength(1);
  const ev = await listEvents(api.deps.db, runId, 0);
  expect(ev.map((e) => schemas.validate(e)).filter(Boolean)).toEqual([]);
  expect(ev.map((e) => e.seq)).toEqual(ev.map((_, i) => i + 1));
  expect(ev.filter((e) => e.type === "run_finished")).toHaveLength(1);
  expect(ev.filter((e) => e.type === "needs_input")).toHaveLength(1);

  const ledger = await api.deps.pg<{ kind: string; key: string; amount: string }[]>`
    select kind, idempotency_key as key, amount_milli::text as amount from platform.credit_ledger
    where run_id = ${runId}`;
  const sum = (k: string) => ledger.filter((l) => l.kind === k).reduce((a, l) => a + Number(l.amount), 0);
  const billed = (
    await api.deps.pg`select coalesce(sum(credits_milli), 0)::int as n from platform.llm_calls
      where run_id = ${runId} and billable`
  )[0]?.n as number;
  expect(sum("hold")).toBe(-sum("release"));
  expect(sum("charge")).toBe(-Math.min(billed, -sum("hold")));

  // execution.M1.dbos_data: no cell value of the table in dbos.*.
  const needles = canaryNeedles(rows).filter((n) => !SHEET.includes(n));
  const tables = await api.deps.pg<{ t: string }[]>`
    select table_name as t from information_schema.tables where table_schema = 'dbos' and table_type = 'BASE TABLE'`;
  for (const { t } of tables) {
    const all = await api.deps.pg.unsafe(`select x::text as row from dbos."${t.replaceAll('"', '""')}" x`);
    const text = all.map((r) => r.row as string).join("\n");
    for (const n of needles) expect(text.includes(n), `${t}: ${n}`).toBe(false);
  }
  await stopProc(w2);
}

describe("import_table survives kill -9 of the worker", () => {
  test("killed while waiting for confirm → mapping edit kept, rows loaded once, one mapping call", async () => {
    await killAtConfirm();
  }, 120_000);

  test("killed after the needs_input transaction, before its checkpoint → the confirm sent meanwhile is delivered", async () => {
    await killAtConfirm("needs_input");
  }, 120_000);

  test("killed after the mapping was saved, before its checkpoint → the re-run save keeps the user's edit", async () => {
    const w1 = await worker({ WZ_FAULT_HANG_AFTER: "mapping_saved" });
    const c = await toCard(api, "CRM для клиентов пекарни");
    const ap = await api.req("POST", `/systems/${c.systemId}/card/approve`, {
      body: { cardVersion: c.cardVersion },
    });
    await waitRun(api, ap.body.run.id, ["succeeded"], 30_000);
    const grid = canaryGrid(rows).map((r, i) => [...r, i === 0 ? "Источник" : "Сайт"]);
    const form = new FormData();
    form.set(
      "file",
      new Blob([writeXlsx([{ name: SHEET, rows: grid }]) as Uint8Array<ArrayBuffer>]),
      "k.xlsx",
    );
    const created = await api.req("POST", `/systems/${c.systemId}/imports`, { body: form });
    const importId = created.body.importId as string;
    const runId = created.body.run.id as string;
    const path = `/systems/${c.systemId}/imports/${importId}`;
    await waitOut(w1, '"msg":"fault_hang"');
    w1.child.kill("SIGKILL");
    await w1.exited;
    const got = await api.req("GET", path);
    expect(got.body).toMatchObject({ status: "awaiting_confirm", inputId: null });
    const edited = got.body.mapping.map((m: { column: string }) =>
      m.column === "Комментарий" ? { column: "Комментарий", action: "skip", pii: "basic" } : m,
    );
    expect((await api.req("PUT", `${path}/mapping`, { body: { mapping: edited } })).status).toBe(200);

    // mapping_saved runs again (no checkpoint) but does not overwrite the edit; the mapping call is not repeated.
    const w2 = await worker();
    const ready = await waitFor(async () => {
      const r = await api.req("GET", path);
      return r.body.inputId ? r : undefined;
    }, 30_000);
    expect(ready.body.mapping.find((m: { column: string }) => m.column === "Комментарий")).toMatchObject({
      action: "skip",
    });
    const input = await api.req("POST", `/runs/${runId}/input`, {
      body: { inputId: ready.body.inputId, choice: "confirm" },
    });
    expect(input.status).toBe(202);
    const run = await waitRun(api, runId, ["succeeded", "failed", "cancelled"], 60_000);
    expect(run, JSON.stringify(run.failure)).toMatchObject({ status: "succeeded" });
    const [s] = await api.deps.pg`select schema_key from platform.systems where id = ${c.systemId}`;
    const loaded = await api.deps.pg.unsafe(`select note from "app_${s?.schema_key}_draft".client`);
    expect(loaded).toHaveLength(50);
    expect(loaded.every((r) => r.note === null)).toBe(true);
    const calls = await api.deps.pg<{ call_type: string }[]>`
      select call_type from platform.llm_calls where run_id = ${runId}`;
    expect(calls.filter((x) => x.call_type === "import_mapping")).toHaveLength(1);
    await stopProc(w2);
  }, 120_000);
});
