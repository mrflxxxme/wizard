// M1-01: runs as DBOS workflows of apps/worker; platform-api (engine dbos) only enqueues, sends and reads run_events.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { idempotenceKey } from "@wizard/connectors";
import { YookassaMock } from "@wizard/connectors/mocks";
import { createLogger } from "@wizard/pii/log";
import { type BuildHost, type BuildParams, RUN_WORKFLOW, SecretStore } from "@wizard/platform-api";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { listEvents } from "../../platform-api/src/runs/events.js";
import { loadEventSchemas } from "../../platform-api/test/event-schemas.js";
import { startBuild } from "../../platform-api/test/flow.js";
import {
  createTestDb,
  parseSse,
  startApi,
  type TestApi,
  waitFor,
  waitRun,
} from "../../platform-api/test/helpers.js";
import {
  BILLING_CRON,
  CREDITS_CRON,
  DBOS_RETENTION,
  IMPORTS_TTL,
  RETENTION_CRON,
  startWorker,
  type Worker,
} from "../src/index.js";
import { CODE_STEPS, LLM_CANARY, recordingRouter, scriptedBuild, scriptedExecutors } from "./support.js";

const SECRET = "shpk_live_9f8e7d6c5b4a";
const schemas = loadEventSchemas();
let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let worker: Worker;
let shop: YookassaMock;
const dirs: string[] = [];
let secretsFile = "";
let build: (host: BuildHost, p: BuildParams) => Promise<{ summary_ru: string }> = scriptedBuild;

const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

beforeAll(async () => {
  tdb = await createTestDb("worker");
  shop = await new YookassaMock().start();
  secretsFile = join(tmp("wz-secrets-"), "secrets.enc");
  const config = {
    // M2-07: the platform shop for billing_cron renewals (YooKassa API stub).
    platformShop: { shopId: shop.shopId, secretKey: shop.secretKey },
    yookassaApiBase: shop.apiBase,
    dbUrl: tdb.url,
    artifactsDir: tmp("wz-art-"),
    stepsDir: tmp("wz-steps-"),
    secretsFile,
    authMode: "dev",
    runConcurrency: 2,
  };
  api = await startApi(tdb.url, { engine: "dbos", config, executors: scriptedExecutors() });
  worker = await startWorker({
    config,
    executors: scriptedExecutors((h, p) => build(h, p)),
    createRouter: recordingRouter({ delayMs: 20 }),
    sweepMs: 0,
    pollMs: 100,
    logger: createLogger({
      svc: "worker",
      level: "debug",
      write: process.env.WZ_TEST_LOG ? (j) => process.stderr.write(`${j}\n`) : () => {},
    }),
  });
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await api?.dispose();
  await tdb?.drop();
  await shop?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function expectValid(events: { type: string; payload: unknown; seq: number }[]) {
  expect(events.map((e) => schemas.validate(e)).filter(Boolean)).toEqual([]);
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  const terminal = events.filter((e) => e.type === "run_finished" || e.type === "run_failed");
  expect(terminal).toHaveLength(1);
  expect(events.at(-1)).toBe(terminal[0]);
}

/** Rows of every dbos.* table whose text contains `needle`. */
async function dbosRowsWith(needle: string): Promise<string[]> {
  const tables = await api.deps.pg<{ t: string }[]>`
    select table_name as t from information_schema.tables where table_schema = 'dbos' and table_type = 'BASE TABLE'`;
  const hits: string[] = [];
  for (const { t } of tables) {
    const [r] = await api.deps.pg.unsafe(
      `select count(*)::int as n from dbos."${t.replaceAll('"', '""')}" x where x::text like $1`,
      [`%${needle}%`],
    );
    if ((r?.n as number) > 0) hits.push(t);
  }
  return hits;
}

const events = (runId: string) => listEvents(api.deps.db, runId, 0);

async function pendingOf(runId: string): Promise<Record<string, unknown>> {
  await waitRun(api, runId, ["needs_input"], 20_000);
  const [r] = await api.deps.pg`select pending_input from platform.runs where id = ${runId}`;
  return r?.pending_input as Record<string, unknown>;
}

describe("runs as DBOS workflows (M1-01)", () => {
  test("interview and build run in the worker; events valid and gap-free; charge once; dbos.* has no LLM text", async () => {
    const b = await startBuild(api, "Форум на 600 человек");
    await waitRun(api, b.buildRunId, ["succeeded"], 30_000);
    const ev = await events(b.buildRunId);
    expectValid(ev);
    expect(
      ev.filter((e) => e.type === "step_started" && String(e.payload.step).startsWith("code#")),
    ).toHaveLength(CODE_STEPS);
    // The workflow ends a moment after the terminal transaction (lock hand-over step).
    const wf = await waitFor(async () => {
      const [w] = await api.deps.pg`
        select status, name, queue_name from dbos.workflow_status where workflow_uuid = ${b.buildRunId}`;
      return w?.status === "SUCCESS" ? w : undefined;
    });
    expect(wf).toMatchObject({ status: "SUCCESS", name: RUN_WORKFLOW, queue_name: "runs" });
    const [iv] = await api.deps.pg`
      select queue_name, queue_partition_key from dbos.workflow_status where workflow_uuid = ${b.createRunId}`;
    expect(iv).toMatchObject({ queue_name: "interview", queue_partition_key: b.systemId });

    const calls = await api.deps.pg<{ step: string }[]>`
      select step from platform.llm_calls where run_id = ${b.buildRunId} order by created_at`;
    expect(calls.map((c) => c.step)).toEqual(Array.from({ length: CODE_STEPS }, (_, i) => `build_code#${i}`));
    const ledger = await api.deps.pg<{ kind: string; total: string }[]>`
      select kind, sum(amount_milli)::text as total from platform.credit_ledger where run_id = ${b.buildRunId}
      group by kind order by kind`;
    const by = Object.fromEntries(ledger.map((l) => [l.kind, Number(l.total)]));
    expect(by.charge).toBe(-CODE_STEPS * 100);
    expect(by.hold).toBe(-(by.release ?? 0));

    // execution.M1.dbos_data: LLM output only by reference.
    expect(await dbosRowsWith(LLM_CANARY)).toEqual([]);
    // The step outputs outlive the run only until the sweep sees the workflow ended.
    expect(worker.steps.runs()).toContain(b.buildRunId);
    await worker.sweep();
    expect(worker.steps.runs()).not.toContain(b.buildRunId);

    // SSE of platform-api reads run_events written by the worker process.
    const sse = parseSse((await api.req("GET", `/runs/${b.buildRunId}/events`)).text);
    expect(sse.at(-1)?.event).toBe("run_finished");
    expect(sse.map((f) => Number(f.id))).toEqual(
      ev.filter((e) => e.type !== "model_switched").map((e) => e.seq),
    );
  });

  test("live SSE follows a run executing in the worker", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    build = async (host, p) => {
      await gate;
      return scriptedBuild(host, p);
    };
    try {
      const b = await startBuild(api, "Форум для SSE");
      const stream = api.fetch(
        new Request(`http://localhost:4000/api/v1/runs/${b.buildRunId}/events`, {
          headers: { host: "localhost:4000" },
        }),
      );
      await waitRun(api, b.buildRunId, ["running"], 20_000);
      release();
      const text = await (await stream).text();
      const frames = parseSse(text);
      expect(frames[0]?.event).toBe("run_started");
      expect(frames.at(-1)?.event).toBe("run_finished");
    } finally {
      release();
      build = scriptedBuild;
    }
  });

  test("needs_input: the answer reaches the workflow through DBOS.send", async () => {
    build = async (host, p) => {
      const ans = await host.needsInput({
        decisionId: "escalation",
        prompt_ru: "Что делаем?",
        options: [
          { id: "retry", label: "Ещё раз", recommended: true },
          { id: "rephrase", label: "Переформулировать", freeText: true },
        ],
      });
      if (ans.choice !== "rephrase" || ans.text !== "проще") throw new Error("wrong answer");
      return scriptedBuild(host, p);
    };
    try {
      const b = await startBuild(api, "Форум с вопросом");
      const pending = await pendingOf(b.buildRunId);
      const res = await api.req("POST", `/runs/${b.buildRunId}/input`, {
        body: { inputId: pending.inputId, choice: "rephrase", text: "проще" },
      });
      expect(res.status).toBe(202);
      await waitRun(api, b.buildRunId, ["succeeded"], 30_000);
      const ev = await events(b.buildRunId);
      expectValid(ev);
      expect(ev.find((e) => e.type === "input_received")?.payload).toMatchObject({ choice: "rephrase" });
    } finally {
      build = scriptedBuild;
    }
  });

  test("secret: the value goes to the store in the HTTP handler, the workflow gets secret://name (L3-09)", async () => {
    let ref: string | undefined;
    build = async (host, p) => {
      const ans = await host.needsInput({
        kind: "secret",
        secretName: "shop_key",
        prompt_ru: "Ключ магазина",
      });
      ref = ans.secretRef;
      return scriptedBuild(host, p);
    };
    try {
      const b = await startBuild(api, "Форум с оплатой");
      const pending = await pendingOf(b.buildRunId);
      expect(pending).toMatchObject({ kind: "secret", secretName: "shop_key" });
      const res = await api.req("POST", `/runs/${b.buildRunId}/input`, {
        body: { inputId: pending.inputId, secretValue: SECRET },
      });
      expect(res.status).toBe(202);
      await waitRun(api, b.buildRunId, ["succeeded"], 30_000);
      expect(ref).toBe("secret://shop_key");
      const [row] = await api.deps.pg`
        select backend, backend_path from platform.secrets_refs where system_id = ${b.systemId} and name = 'shop_key'`;
      expect(row).toMatchObject({ backend: "local_encrypted", backend_path: `${b.systemId}/draft/shop_key` });
      expect(new SecretStore(secretsFile, "").get(b.systemId, "draft", "shop_key")).toBe(SECRET);
      expect(readFileSync(secretsFile, "utf8")).not.toContain(SECRET);
      expect(await dbosRowsWith(SECRET)).toEqual([]);
      const ev = await events(b.buildRunId);
      expect(JSON.stringify(ev)).not.toContain(SECRET);
      expect(ev.find((e) => e.type === "input_received")?.payload).toMatchObject({ choice: null });
    } finally {
      build = scriptedBuild;
    }
  });

  test("cancel of a running build: the worker aborts it at the step boundary", async () => {
    build = async (host, p) => {
      await new Promise<void>((r) =>
        host.signal.aborted ? r() : host.signal.addEventListener("abort", () => r(), { once: true }),
      );
      return scriptedBuild(host, p);
    };
    try {
      const b = await startBuild(api, "Форум для отмены");
      await waitRun(api, b.buildRunId, ["running"], 20_000);
      const res = await api.req("POST", `/runs/${b.buildRunId}/cancel`);
      expect(res.status).toBe(202);
      const done = await waitRun(api, b.buildRunId, ["cancelled"], 20_000);
      expect(done.status).toBe("cancelled");
      expectValid(await events(b.buildRunId));
      const [c] = await api.deps
        .pg`select count(*)::int as n from platform.llm_calls where run_id = ${b.buildRunId}`;
      expect(c?.n).toBe(0);
    } finally {
      build = scriptedBuild;
    }
  });

  test("second build of a system waits for the lock (lock_waiting) and runs after the hand-over", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    build = async (host, p) => {
      if (first) {
        first = false;
        await gate;
      }
      return scriptedBuild(host, p);
    };
    try {
      const b = await startBuild(api, "Форум с очередью");
      await waitRun(api, b.buildRunId, ["running"], 20_000);
      const [second] = await api.deps.pg`
        insert into platform.runs (org_id, system_id, kind, mode, credits_cap_milli, input)
        select org_id, id, 'build', 'fix', 3000, '{}'::jsonb from platform.systems where id = ${b.systemId}
        returning id`;
      api.engine.enqueue({ id: second?.id, kind: "build", system_id: b.systemId });
      await waitRun(api, second?.id, ["waiting_lock"], 20_000);
      const ev = await events(second?.id);
      expect(ev.map((e) => e.type)).toEqual(["lock_waiting"]);
      expect(ev[0]?.payload).toMatchObject({ holderRunId: b.buildRunId, position: 1 });
      const t0 = Date.now();
      release();
      await waitRun(api, b.buildRunId, ["succeeded"], 30_000);
      await waitRun(api, second?.id, ["succeeded"], 30_000);
      // Hand-over by DBOS.send, not by the 10 s safety poll.
      expect(Date.now() - t0).toBeLessThan(9_000);
      expectValid(await events(second?.id));
    } finally {
      release();
      build = scriptedBuild;
    }
  });

  test("sweep enqueues a queued run whose enqueue was lost (crash between commit and enqueue)", async () => {
    const b = await startBuild(api, "Форум для сиротского прогона");
    await waitRun(api, b.buildRunId, ["succeeded"], 30_000);
    const [orphan] = await api.deps.pg`
      insert into platform.runs (org_id, system_id, kind, mode, credits_cap_milli, input, created_at)
      select org_id, id, 'build', 'fix', 3000, '{}'::jsonb, now() - interval '1 minute'
      from platform.systems where id = ${b.systemId}
      returning id`;
    expect(await DBOS.getWorkflowStatus(orphan?.id)).toBeNull();
    await worker.sweep();
    await waitRun(api, orphan?.id, ["succeeded"], 30_000);
    expectValid(await events(orphan?.id));
  });

  test("sweep fails a run whose workflow ended without the terminal transaction and frees the lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    build = async (host, p) => {
      await gate;
      return scriptedBuild(host, p);
    };
    try {
      const b = await startBuild(api, "Форум с брошенным прогоном");
      await waitRun(api, b.buildRunId, ["running"], 20_000);
      // E.g. recovery attempts exhausted: DBOS ends the workflow, the run row stays «running».
      await DBOS.cancelWorkflow(b.buildRunId);
      await api.deps
        .pg`update platform.runs set created_at = now() - interval '1 minute' where id = ${b.buildRunId}`;
      await worker.sweep();
      const run = await waitRun(api, b.buildRunId, ["failed"], 10_000);
      expect(run.failure.code).toBe("WORKER_RESTARTED");
      const [lock] = await api.deps.pg`select 1 from platform.locks where system_id = ${b.systemId}`;
      expect(lock).toBeUndefined();
      expectValid(await events(b.buildRunId));
    } finally {
      release();
      build = scriptedBuild;
    }
  });

  test("dbos retention: terminal workflows older than 30 days are deleted with their steps; schedules registered", async () => {
    const b = await startBuild(api, "Форум для уборки");
    await waitRun(api, b.buildRunId, ["succeeded"], 30_000);
    await waitFor(async () => {
      const [w] = await api.deps
        .pg`select status from dbos.workflow_status where workflow_uuid = ${b.buildRunId}`;
      return w?.status === "SUCCESS";
    });
    const old = Date.now() - 31 * 24 * 3600_000;
    await api.deps
      .pg`update dbos.workflow_status set completed_at = ${old} where workflow_uuid = ${b.buildRunId}`;
    const steps = async (id: string) =>
      (
        await api.deps.pg`select count(*)::int as n from dbos.operation_outputs where workflow_uuid = ${id}`
      )[0]?.n as number;
    expect(await steps(b.buildRunId)).toBeGreaterThan(0);
    expect(await worker.retainDbos()).toBeGreaterThanOrEqual(1);
    expect(await steps(b.buildRunId)).toBe(0);
    // Younger workflows stay.
    expect(await steps(b.createRunId)).toBeGreaterThan(0);
    // The run itself (platform.runs, run_events) is untouched.
    expect((await api.req("GET", `/runs/${b.buildRunId}`)).body.status).toBe("succeeded");
    const names = (await DBOS.listSchedules()).map((s) => s.scheduleName).sort();
    expect(names).toEqual([BILLING_CRON, CREDITS_CRON, DBOS_RETENTION, IMPORTS_TTL, RETENTION_CRON].sort());
  });

  test("retention_cron (M2-05): a system deleted 31 days ago is purged by the worker pass; messages gone, journal written", async () => {
    const b = await startBuild(api, "Форум для удаления");
    await waitRun(api, b.buildRunId, ["succeeded"], 30_000);
    const del = await api.req("DELETE", `/systems/${b.systemId}`);
    expect(del.status, del.text).toBe(200);
    await api.deps.pg`
      update platform.systems set deleted_at = now() - interval '31 days' where id = ${b.systemId}`;
    const report = await worker.retention();
    expect(report.purged.map((p) => p.systemId)).toContain(b.systemId);
    const [m] = await api.deps
      .pg`select count(*)::int as n from platform.messages where system_id = ${b.systemId}`;
    expect(m?.n).toBe(0);
    const log = await api.req("GET", `/systems/${b.systemId}/deletion-log`);
    expect(log.body.items.map((i: { mode: string }) => i.mode)).toContain("system_deleted");
    // Idempotent: a second pass finds nothing to purge.
    expect((await worker.retention()).purged).toEqual([]);
  });
});

describe("billing_cron (M2-07): renewals as a durable scheduled workflow", () => {
  test("a due subscription is renewed by the saved card in step renew:<org>; the same workflow id never charges twice", async () => {
    const [org] = await api.deps
      .pg`insert into platform.orgs (name, plan) values ('Подписчик', 'start') returning id`;
    const [user] = await api.deps
      .pg`insert into platform.users (email) values ('payer@example.ru') returning id`;
    await api.deps
      .pg`insert into platform.memberships (org_id, user_id, role) values (${org?.id}, ${user?.id}, 'owner')`;
    const card = {
      first6: "220220",
      last4: "5151",
      expiry_month: "01",
      expiry_year: "2032",
      card_type: "Mir",
      issuer_country: "RU",
    };
    shop.savedMethods.set("pm-worker-1", { type: "bank_card", id: "pm-worker-1", saved: true, card });
    const [pm] = await api.deps.pg`
      insert into platform.payment_methods (org_id, provider_method_id, card_last4, card_type, issuer_country,
        card_fingerprint, bound_by)
      values (${org?.id}, 'pm-worker-1', '5151', 'Mir', 'RU', 'fp-worker', ${user?.id}) returning id`;
    const end = new Date(Date.now() - 60_000);
    await api.deps.pg`
      insert into platform.subscriptions (org_id, plan, status, payment_method_id, current_period_start,
        current_period_end, next_charge_at)
      values (${org?.id}, 'start', 'active', ${pm?.id}, ${new Date(end.getTime() - 30 * 24 * 3600_000)}, ${end}, ${end})`;

    await worker.runBillingCron("billing-cron-test-1");
    const calls = shop.callsTo("POST", "/v3/payments");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.idempotenceKey).toBe(idempotenceKey(`renew:${org?.id}:${end.toISOString()}`));
    expect(calls[0]?.body).toMatchObject({ payment_method_id: "pm-worker-1", amount: { value: "1990.00" } });
    const [sub] = await api.deps
      .pg`select current_period_start from platform.subscriptions where org_id = ${org?.id}`;
    expect(new Date(sub?.current_period_start).getTime()).toBe(end.getTime());
    const steps = await api.deps.pg`
      select function_name from dbos.operation_outputs where workflow_uuid = 'billing-cron-test-1' order by function_id`;
    expect(steps.map((r) => r.function_name)).toEqual([
      "billing_remind",
      "billing_end",
      "billing_due",
      `renew:${org?.id}`,
      "billing_reconcile",
    ]);
    // Replaying the finished workflow returns its recorded result: no second payment.
    await worker.runBillingCron("billing-cron-test-1");
    expect(shop.callsTo("POST", "/v3/payments")).toHaveLength(1);
    const grants = await api.deps.pg`
      select count(*)::int as n from platform.credit_ledger where org_id = ${org?.id} and bucket = 'plan_monthly'`;
    expect(grants[0]?.n).toBe(1);
  });
});
