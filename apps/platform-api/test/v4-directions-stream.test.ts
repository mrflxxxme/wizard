// V4-17, platform part: first screens as a stream. POST /directions {stream} answers 202 at once with the job (stage,
// the skeleton of the first screen in the brief's words and brand colour); GET reports the directions already built
// (their previews served under the job's key) until the stored proposal replaces the job; a second POST while it runs
// returns the same job; a failure is reported in words and the next POST starts again. No live calls (the texts fall
// back to the brief: no recorded answer).
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemBriefInput } from "@wizard/appspec";
import { createRouter } from "@wizard/llm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { createTestDb, fakeExecutors, startApi, type TestApi } from "./helpers.js";
import { expectContract } from "./session.js";

const LOGO = "Логотип: фирменный цвет #0E7490, тёмный.";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let fixtures: string;

beforeAll(async () => {
  tdb = await createTestDb("v4dirstream");
  fixtures = mkdtempSync(join(tmpdir(), "wz-dir-stream-"));
  mkdirSync(join(fixtures, "unit"), { recursive: true });
  api = await startApi(tdb.url, {
    executors: fakeExecutors(),
    createRouter: (o) =>
      createRouter({ ...o, fixture: { suite: "unit", name: "design-directions", dir: fixtures }, env: {} }),
  });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
  if (fixtures) rmSync(fixtures, { recursive: true, force: true });
});

async function addSystem(brief: SystemBriefInput | null): Promise<string> {
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `dst-${key}`,
      schema_key: key,
      name: "Стоматология «Улыбка»",
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (brief) await saveBriefVersion(api.deps.db, { systemId: row.id, brief, author: "agent" });
  return row.id;
}

test("202 at once with the skeleton; GET streams the built directions until the stored proposal", async () => {
  const id = await addSystem({ ...dentalBrief(), design: { references: [LOGO] } });
  const t0 = performance.now();
  const r = await api.req("POST", `/systems/${id}/directions`, { body: { stream: true } });
  expect(r.status, r.text).toBe(202);
  expect(performance.now() - t0).toBeLessThan(5_000);
  expectContract("proposeDesignDirections", r);
  const pending = r.body.pending;
  expect(pending.key).toMatch(/^[0-9a-f]{64}$/);
  expect(pending.total).toBe(3);
  expect(pending.skeleton.title).toContain("Улыбка");
  expect(pending.skeleton.accent).toBe("#0E7490");
  expect(pending.error).toBeNull();

  // The same job while it runs.
  const again = await api.req("POST", `/systems/${id}/directions`, { body: { stream: true } });
  expect(again.status).toBe(202);
  expect(again.body.pending.key).toBe(pending.key);

  const seen: number[] = [];
  let proposal: { id: string; directions: { n: number }[] } | null = null;
  const until = Date.now() + 120_000;
  while (!proposal && Date.now() < until) {
    const g = await api.req("GET", `/systems/${id}/directions`);
    expect(g.status).toBe(200);
    expectContract("getDesignDirections", g);
    if (g.body.pending) {
      expect(g.body.pending.key).toBe(pending.key);
      expect(g.body.pending.stage).not.toBe("failed");
      seen.push(g.body.pending.ready.length);
      for (const d of g.body.pending.ready)
        expect(d.previewHtml).toContain(`/api/v1/direction-previews/${pending.key}/${d.n}/boot.js`);
    } else proposal = g.body.proposal;
    if (!proposal) await new Promise((res) => setTimeout(res, 100));
  }
  expect(proposal?.directions).toHaveLength(3);
  // Never fewer ready directions than before (they only join).
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  // The previews of the job's key stay served (the canvas keeps the frames it already shows).
  const boot = await api.req("GET", `/direction-previews/${pending.key}/1/boot.js`);
  expect(boot.status).toBe(200);
  // One chat card, as with the plain POST.
  const cards = await api.deps.pg<{ n: number }[]>`
    select count(*)::int as n from platform.messages
    where system_id = ${id} and payload->>'type' = 'design_directions'`;
  expect(cards[0]?.n).toBe(1);
}, 150_000);

test("no brief: refused in words at once, nothing pending", async () => {
  const id = await addSystem(null);
  const r = await api.req("POST", `/systems/${id}/directions`, { body: { stream: true } });
  expect(r.status).toBe(400);
  expect(r.body.message_ru).toContain("бриф");
  const g = await api.req("GET", `/systems/${id}/directions`);
  expect(g.body).toEqual({ proposal: null, pending: null });
});
