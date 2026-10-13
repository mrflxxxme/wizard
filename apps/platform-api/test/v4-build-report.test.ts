// V4-04 acceptance 1: every v3 build leaves its report in the shared file storage — the stages with ₽ and minutes, the
// brief's scenarios, the gates, the model calls, the critic and techreview when they ran — and a founder's build (a
// staff org) also the records of its model calls (V4-03); the report is served to staff at /admin/runs/:id/report.
// The build is the V3-11 fixture build (recorded answers, no network, no money); screenshots are the browser test's
// (v4-build-report.browser.test.ts) — here the build has no browser and the report says so.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefNiche } from "@wizard/agents/builder";
import { systemBriefSchema } from "@wizard/appspec";
import { createRouter, type RecordLine, type Router, type RouterOptions } from "@wizard/llm";
import { closeExecutors, type FileStorage } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  clinicBrief,
  fakeComposer,
  pageComposeMessages,
  v3Lines,
  writeFixture,
} from "../../../packages/agents/test/v3-harness-fixtures.js";
import { setStaff } from "../src/abuse/staff.js";
import { createAgentExecutors } from "../src/agents/executors.js";
import { OutboxMailer } from "../src/auth/mailer.js";
import { totpCode } from "../src/auth/totp.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { loadBuildReport, renderReportMd, reportFile, reportStorage } from "../src/builds-v3/report/index.js";
import { startV3Build } from "../src/builds-v3/start.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { createTestDb, startApi, type TestApi, waitRun } from "./helpers.js";
import { devLogin, type Session } from "./session.js";

function smallBrief() {
  const b = clinicBrief();
  return { ...b, scenarios: (b.scenarios ?? []).filter((s) => ["s_book", "s_lead"].includes(s.id)) };
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let outboxDir: string;
let fixtureDir: string;
// The shared file storage the build executors and the admin routes make (fs next to the artifacts in tests).
let files: FileStorage;
let staff: Session;
let client: Session;

beforeAll(async () => {
  tdb = await createTestDb("v4report", { migrator: true });
  outboxDir = mkdtempSync(join(tmpdir(), "wz-v4-outbox-"));
  const brief = systemBriefSchema.parse(smallBrief());
  fixtureDir = writeFixture(
    "clinic",
    v3Lines({
      brief: { goals: brief.goals, audience: brief.audience },
      niche: briefNiche(brief),
      seed: "x",
      pages: 10,
      prompt: pageComposeMessages({ brief, design: {} as never }, brief.scenarios[0] as never),
    }),
  );
  api = await startApi(tdb.url, {
    config: { unsafeLocalExec: true },
    createRouter: (opts: RouterOptions): Router =>
      createRouter({
        ...opts,
        mode: "fixture",
        fixture: { suite: "demo", name: "v3/clinic", dir: fixtureDir },
        env: {},
      }),
    executors: ({ pg, config }) =>
      createAgentExecutors({
        pg,
        config,
        v3: { enabled: true, composer: fakeComposer(), mailer: new OutboxMailer(outboxDir) },
      }),
  });
  files = reportStorage({ artifactsDir: api.artifactsDir });
  client = await devLogin(api, "owner-report@example.test");
  staff = await devLogin(api, "founder-report@example.test");
  await setStaff(api.deps.db, "founder-report@example.test", true);
  const en = await staff.req("POST", "/admin/mfa/enroll");
  await staff.req("POST", "/admin/mfa/confirm", { body: { code: totpCode(en.body.secret) } });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await closeExecutors();
  await tdb?.drop();
  rmSync(outboxDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
}, 120_000);

async function addSystem(name: string): Promise<string> {
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `v4-${key}`,
      schema_key: key,
      name,
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

describe("V4-04: the build report", () => {
  test("a founder's build saves its report: stages with ₽ and minutes, scenarios, gates, calls and the records", async () => {
    // The founder's org (B2-01: staff) — its model calls are recorded.
    await api.deps.db
      .updateTable("platform.orgs")
      .set({ kind: "staff" })
      .where("id", "=", DEFAULT_ORG_ID)
      .execute();
    const systemId = await addSystem("Клиника «Отчёт»");
    await saveBriefVersion(api.deps.db, { systemId, brief: smallBrief(), author: "agent" });
    const run = await startV3Build(api.deps, { systemId, userId: DEV_USER_ID });
    const done = await waitRun(api, run.id, ["succeeded", "failed"], 240_000);
    expect(done.status).toBe("succeeded");

    const report = await loadBuildReport(files, run.id);
    expect(report).not.toBeNull();
    if (!report) return;
    expect(report).toMatchObject({
      runId: run.id,
      systemId,
      status: "succeeded",
      failure: null,
      orgKind: "staff",
    });
    const stages = report.stages.map((s) => s.stage);
    for (const s of ["brief", "design", "backend", "skeleton", "scenarios", "techreview", "gates"])
      expect(stages).toContain(s);
    expect(report.stages.every((s) => s.rub >= 0 && s.minutes >= 0)).toBe(true);
    expect(report.rub).toBeGreaterThan(0);
    expect(report.scenarios.map((s) => s.id).sort()).toEqual(["s_book", "s_lead"]);
    expect(report.scenarios.every((s) => s.status === "passed")).toBe(true);
    expect(report.gates.map((g) => g.level).sort()).toEqual(["G0", "G1", "G2"]);
    expect(report.calls.length).toBeGreaterThan(0);
    expect(report.techreview?.status).toBeTruthy();
    // No browser in this build: the report names what it could not collect.
    expect(report.shots).toEqual([]);
    expect(report.gaps.join(" ")).toMatch(/снимки/);

    // The records of the founder's calls (V4-03): one per model call of the run, of real call types.
    expect(report.records).toMatch(/^wz_reports\//);
    const rec = await reportFile(files, report, report.records as string);
    const lines = new TextDecoder()
      .decode(rec?.data)
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RecordLine);
    expect(lines.length).toBe(report.calls.filter((c) => c.status === "ok").length);
    expect(lines.every((l) => l.source === "build" && l.key.startsWith(`${l.callType}@`))).toBe(true);

    const md = renderReportMd(report, "https://p/api/v1/admin/runs/x/report");
    expect(md).toContain("### Этапы");
    expect(md).toContain("s_book");
    expect(md).toContain("Записи вызовов");

    // Staff with MFA reads the report (JSON, Markdown) and its files; a client gets 404.
    const r = await staff.req("GET", `/admin/runs/${run.id}/report`);
    expect(r.status).toBe(200);
    expect(r.body.runId).toBe(run.id);
    const m = await staff.req("GET", `/admin/runs/${run.id}/report?format=md`);
    expect(m.text).toContain("### Сценарии брифа");
    const f = await staff.req("GET", `/admin/runs/${run.id}/report/files/${report.records}`);
    expect(f.status).toBe(200);
    expect(
      (await staff.req("GET", `/admin/runs/${run.id}/report/files/wz_reports/${randomUUID()}`)).status,
    ).toBe(404);
    expect((await client.req("GET", `/admin/runs/${run.id}/report`)).status).toBe(404);
  }, 300_000);
});
