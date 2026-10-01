// L3-08 (deploy.yaml#cloud.observability.pii_in_logs): canary e2e over all processes — platform-api, worker and
// runtime run as separate processes; PII travels through requests, the database and failing runs; then the
// captured logs of every process are grepped for the canaries: 0 hits.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDb, ROOT, waitFor } from "../../platform-api/test/helpers.js";
import { ENTRY, freePort, type Proc, start, stopProc, waitOut } from "./proc.js";
import { LLM_CANARY } from "./support.js";

const EMAIL = "kanareyka.test@example.com";
const PHONE = "+7 916 555-12-34";
const NEEDLES = ["kanareyka", "555-12-34", "5551234", LLM_CANARY, "Канарейкин"];

let tdb: Awaited<ReturnType<typeof createTestDb>>;
const procs: Proc[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  tdb = await createTestDb("canary");
});

afterAll(async () => {
  for (const p of procs) await stopProc(p, "SIGKILL");
  await tdb?.drop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

describe("canary e2e: no PII in the logs of any process (L3-08)", () => {
  test("platform-api, worker and runtime logs contain none of the canaries", async () => {
    const [apiPort, rtPort] = [await freePort(), await freePort()];
    const api = start(join(ROOT, "apps/platform-api/src/main.ts"), {
      WIZARD_DB_URL: tdb.url,
      WIZARD_AUTH_MODE: "dev",
      PORT: String(apiPort),
      HOST: "127.0.0.1",
    });
    procs.push(api);
    await waitOut(api, '"msg":"listening"', 60_000);
    const worker = start(ENTRY, {
      WIZARD_DB_URL: tdb.url,
      WZ_ENTRY_MODE: "canary",
      WZ_ARTIFACTS: tmp("wz-can-art-"),
      WZ_STEPS: tmp("wz-can-steps-"),
      WZ_SECRETS: join(tmp("wz-can-sec-"), "secrets.enc"),
      WZ_DELAY_MS: "10",
    });
    procs.push(worker);
    await waitOut(worker, '"msg":"ready"', 60_000);
    const runtime = start(join(ROOT, "apps/runtime/src/main.ts"), {
      WIZARD_DB_URL: tdb.url,
      PORT: String(rtPort),
      HOST: "127.0.0.1",
    });
    procs.push(runtime);
    await waitOut(runtime, "listening", 60_000);

    const base = `http://127.0.0.1:${apiPort}/api/v1`;
    const json = { "content-type": "application/json" };
    const created = await fetch(`${base}/systems`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ prompt: `Запись к врачу Канарейкин, звоните ${PHONE}, пишите ${EMAIL}` }),
    });
    expect(created.status).toBe(201);
    const { run, system } = (await created.json()) as { run: { id: string }; system: { id: string } };
    const failed = await waitFor(async () => {
      const r = (await (await fetch(`${base}/runs/${run.id}`)).json()) as { status: string };
      return r.status === "failed" ? r : undefined;
    }, 30_000);
    expect(failed.status).toBe("failed");
    // A rejected body with PII is not logged either.
    const bad = await fetch(`${base}/systems/${system.id}/messages`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: 42, phone: PHONE }),
    });
    expect(bad.status).toBe(400);
    // Runtime: PII in the query string and in a body of an unknown system.
    const host = { host: `nosuch--draft.localhost:${rtPort}` };
    await fetch(`http://127.0.0.1:${rtPort}/?email=${EMAIL}&phone=${encodeURIComponent(PHONE)}`, {
      headers: host,
    });
    await fetch(`http://127.0.0.1:${rtPort}/api/data/patients?q=${EMAIL}`, {
      method: "POST",
      headers: { ...host, ...json },
      body: JSON.stringify({ email: EMAIL, phone: PHONE }),
    });

    await stopProc(worker);
    await stopProc(api);
    await stopProc(runtime);
    const logs = { api: api.out(), worker: worker.out(), runtime: runtime.out() };
    // The error paths were actually logged — with sqlstate only.
    expect(logs.worker).toContain('"sqlstate":"23505"');
    expect(logs.runtime).toContain('"route":"/api/data/patients"');
    const hits = Object.entries(logs).flatMap(([proc, text]) =>
      NEEDLES.filter((n) => text.toLowerCase().includes(n.toLowerCase())).map((n) => `${proc}: ${n}`),
    );
    if (process.env.WZ_TEST_LOG) console.log(logs);
    expect(hits).toEqual([]);
  }, 120_000);
});
