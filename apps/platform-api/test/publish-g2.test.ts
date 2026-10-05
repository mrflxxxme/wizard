// M2-04 follow-up: G2 at prod publication (workflows.yaml#workflows.publish.steps.gate_G2, gates.yaml#G2,
// security/abuse.yaml). With config.prodG2Required (M2+ / production) publish runs G1 (precondition, when the revision
// has no passed G1) and G2 with slug, secretExists and the org's abuse signals; a G2 blocker → GATES_FAILED with the
// report; a failed G2-AF-* → abuse_flag in the moderation journal; a G2-AF-08/09 warning → founder review
// (FOUNDER_REVIEW_PENDING until staff approves). Gates are scripted; publications run for real in Postgres.
import { secretEnvVar } from "@wizard/connectors";
import { ABUSE, type Check, type GateContext, type GateReport } from "@wizard/gates";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { DEFAULT_ORG_ID, DEV_USER_ID } from "../src/db/index.js";
import {
  type AbuseFlag,
  abuseContext,
  decideFounderReview,
  founderReviewStatus,
  pendingFounderReviews,
  REVIEW_PENDING_RU,
  REVIEW_REJECTED_RU,
  secretExistsFor,
} from "../src/publish/moderation.js";
import { listEvents } from "../src/runs/events.js";
import { loadEventSchemas } from "./event-schemas.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  passingReport,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";

type G2Mode = "pass" | "af01" | "perm" | "warn08" | "warn09";

const schemas = loadEventSchemas();
let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let mode: G2Mode = "pass";
const calls: { level: string; ctx: GateContext; secrets?: Record<string, boolean> }[] = [];
const flags: AbuseFlag[] = [];

function g2Report(specVersion: number, m: G2Mode): GateReport {
  const check = (
    id: string,
    status: Check["status"],
    severity: Check["severity"],
    message_ru: string,
  ): Check => ({
    id,
    status,
    severity,
    message_ru,
  });
  const checks: Check[] = [
    check("G2-PERM-01", m === "perm" ? "fail" : "pass", "blocker", "Матрица прав"),
    check("G2-AF-01", m === "af01" ? "fail" : "pass", "blocker", ABUSE.messages["G2-AF-01"] ?? "AF-01"),
    check("G2-AF-08", m === "warn08" ? "warn" : "pass", "warning", REVIEW_PENDING_RU),
    check("G2-AF-09", m === "warn09" ? "warn" : "pass", "warning", "Переписка пользователей"),
  ];
  const passed = !checks.some(
    (c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"),
  );
  return {
    level: "G2",
    passed,
    specVersion,
    startedAt: new Date().toISOString(),
    durationMs: 5,
    checks,
    summary: { pass: 0, fail: passed ? 0 : 1, warn: 0, skip: 0, error: 0 },
  };
}

beforeAll(async () => {
  tdb = await createTestDb("publishg2", { migrator: true });
  process.env[secretEnvVar("envonlykey00", "env_only")] = "set";
  api = await startApi(tdb.url, {
    // The local org is exempt from card binding and plan limits; M2 publish rules switched on explicitly.
    config: { prodG2Required: true },
    executors: {
      ...fakeExecutors({ spec: "forum" }),
      gates: async (level, ctx) => {
        if (level === "G2") {
          const secrets: Record<string, boolean> = {};
          for (const n of ["telegram_bot_token", "missing_token"])
            secrets[n] = (await ctx.secretExists?.(n)) ?? false;
          calls.push({ level, ctx, secrets });
          return g2Report(ctx.specVersion, mode);
        }
        calls.push({ level, ctx });
        return passingReport(level, ctx.specVersion, true);
      },
    },
    createRouter: fakeRouterFactory(),
    publish: {
      smoke: async () => ({ ok: true }),
      lockRetryDelaysMs: [10, 10, 10],
      telegram: { mode: "outbox", outboxDir: null },
      moderationLog: (f) => flags.push(f),
    },
  });
}, 60_000);

afterAll(async () => {
  delete process.env[secretEnvVar("envonlykey00", "env_only")];
  await api?.dispose();
  await tdb?.drop();
});

const sys = (id: string) =>
  api.deps.db.selectFrom("platform.systems").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

async function blockers(id: string): Promise<string[]> {
  const r = await api.req("GET", `/systems/${id}`);
  expect(r.status).toBe(200);
  return r.body.publishBlockers as string[];
}

/** New revision through setCompliance (no build): the revision publish gates from scratch. */
async function newRevision(id: string, n: number): Promise<number> {
  const cur = await sys(id);
  const put = await api.req("PUT", `/systems/${id}/compliance`, {
    body: {
      expectedVersion: cur.draft_revision,
      operatorName: `ООО «Северный ритейл ${n}»`,
      operatorContact: "privacy@north-retail.example",
      operatorAddress: "г. Москва, ул. Тверская, д. 1",
    },
  });
  expect(put.status, put.text).toBe(200);
  return put.body.revision.version as number;
}

async function publish(id: string, revision: number) {
  const r = await api.req("POST", `/systems/${id}/publish`, { body: { revision, confirmDiff: true } });
  expect(r.status, r.text).toBe(202);
  const run = await waitRun(api, r.body.run.id, ["succeeded", "failed"], 30_000);
  const events = await listEvents(api.deps.db, run.id, 0);
  const bad = events.map((e) => schemas.validate(e)).filter((x) => x !== null);
  expect(bad, JSON.stringify(bad)).toEqual([]);
  return { run, events };
}

async function gateRows(id: string, revision: number) {
  return api.deps.db
    .selectFrom("platform.gate_reports")
    .select(["level", "passed", "run_id"])
    .where("system_id", "=", id)
    .where("revision", "=", revision)
    .orderBy("created_at")
    .execute();
}

describe("G2 in the publish workflow (M2)", () => {
  let id = "";

  beforeAll(async () => {
    const created = await api.req("POST", "/systems", { body: { prompt: "Форум северного ритейла" } });
    expect(created.status, created.text).toBe(201);
    id = created.body.system.id;
    await waitRun(api, created.body.run.id, ["succeeded"]);
    const ans = await api.req("POST", `/systems/${id}/answers`, { body: { restByRecommendation: true } });
    await waitRun(api, ans.body.run.id, ["succeeded"]);
    const s = await api.req("GET", `/systems/${id}`);
    const ap = await api.req("POST", `/systems/${id}/card/approve`, {
      body: { cardVersion: s.body.card.cardVersion },
    });
    expect(ap.status, ap.text).toBe(202);
    await waitRun(api, ap.body.run.id, ["succeeded"], 20_000);
    const cur = await sys(id);
    await api.deps.db
      .insertInto("platform.secrets_refs")
      .values({
        org_id: cur.org_id,
        system_id: id,
        env: "draft",
        name: "telegram_bot_token",
        backend: "local_encrypted",
        backend_path: `${id}/draft/telegram_bot_token`,
      })
      .execute();
    await api.deps.db
      .insertInto("platform.brand_allowlist")
      .values({
        org_id: DEFAULT_ORG_ID,
        brand_id: "sber",
        verified_by: DEV_USER_ID,
        evidence_note: "Свидетельство",
      })
      .execute();
  }, 60_000);

  test("clean G2: G1 (precondition) and G2 run on the published revision with slug, secrets and abuse context", async () => {
    mode = "pass";
    const rev = await newRevision(id, 1);
    calls.length = 0;
    const { run, events } = await publish(id, rev);
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
    expect((await sys(id)).prod_revision).toBe(rev);
    // Draft G0 (the setCompliance revision has no bundle yet), G0 for prod, then G1 (no passed G1 on this revision),
    // then G2 — all on the published revision.
    expect(calls.map((c) => [c.level, c.ctx.specVersion, c.ctx.env])).toEqual([
      ["G0", rev, "draft"],
      ["G0", rev, "prod"],
      ["G1", rev, "prod"],
      ["G2", rev, "prod"],
    ]);
    const g2 = calls[3];
    const s = await sys(id);
    expect(g2?.ctx.slug).toBe(s.slug);
    expect(g2?.ctx.systemKey).toBe(s.schema_key);
    expect([...(g2?.ctx.files.keys() ?? [])].sort()).toEqual([
      "functions/registerTicket.ts",
      "ui/Landing.tsx",
    ]);
    expect(g2?.secrets).toEqual({ telegram_bot_token: true, missing_token: false });
    expect(g2?.ctx.abuse).toEqual({
      orgAgeDays: 0,
      plan: "free",
      brandAllowlist: ["sber"],
      abuseReportsPrev: 0,
    });
    // compliance.consentText is filled by the executors (not stored); the spec is the stored revision.
    expect(g2?.ctx.spec.compliance?.operatorName).toBe("ООО «Северный ритейл 1»");
    expect((await gateRows(id, rev)).map((r) => [r.level, r.passed])).toEqual([
      ["G0", true],
      ["G1", true],
      ["G2", true],
    ]);
    const gateStarted = events.filter((e) => e.type === "gate_started").map((e) => e.payload);
    expect(gateStarted).toEqual([
      { level: "G0", revision: rev },
      { level: "G0", revision: rev },
      { level: "G1", revision: rev },
      { level: "G2", revision: rev },
    ]);
    const steps = events
      .filter((e) => e.type === "step_started")
      .map((e) => (e.payload as { step: string }).step);
    expect(steps.indexOf("gate_G2")).toBeGreaterThan(steps.indexOf("gate_G0_prod"));
    expect(steps.indexOf("gate_G2")).toBeLessThan(steps.indexOf("apply_migration"));
    expect(flags).toEqual([]);
    expect(await founderReviewStatus(api.deps.db, id, rev)).toBeNull();
    // secretExists also sees the runtime env (WIZARD_SECRET_<SYSTEMID>_<NAME>); the value is never read.
    expect(await secretExistsFor(api.deps.db, { id, schema_key: "envonlykey00" })("env_only")).toBe(true);
  });

  test("antifraud blocker: GATES_FAILED with the neutral text, report stored, abuse_flag journaled, prod untouched", async () => {
    mode = "af01";
    const before = (await sys(id)).prod_revision;
    const rev = await newRevision(id, 2);
    flags.length = 0;
    const { run, events } = await publish(id, rev);
    expect(run.status).toBe("failed");
    expect(run.failure).toMatchObject({ code: "GATES_FAILED", message_ru: ABUSE.messages["G2-AF-01"] });
    expect((await sys(id)).prod_revision).toBe(before);
    const g2 = (await gateRows(id, rev)).find((r) => r.level === "G2");
    expect(g2?.passed).toBe(false);
    const result = events.find(
      (e) => e.type === "gate_result" && (e.payload as { level: string }).level === "G2",
    );
    expect(result?.payload).toMatchObject({ level: "G2", passed: false, failedChecks: [{ id: "G2-AF-01" }] });
    expect(flags).toEqual([
      { runId: run.id, orgId: DEFAULT_ORG_ID, systemId: id, revision: rev, checks: ["G2-AF-01"] },
    ]);
    const pub = await api.deps.db
      .selectFrom("platform.publications")
      .select("status")
      .where("run_id", "=", run.id)
      .executeTakeFirstOrThrow();
    expect(pub.status).toBe("failed");
    expect(await blockers(id)).not.toContain("FOUNDER_REVIEW_PENDING");
  });

  test("non-antifraud blocker: GATES_FAILED, no abuse_flag", async () => {
    mode = "perm";
    const rev = await newRevision(id, 3);
    flags.length = 0;
    const { run } = await publish(id, rev);
    expect(run.failure).toMatchObject({ code: "GATES_FAILED" });
    expect(run.failure.message_ru).toContain("проверку безопасности");
    expect(run.failure.message_ru).not.toContain("G2");
    expect(flags).toEqual([]);
  });

  test("G2-AF-08 warning → founder review pending → FOUNDER_REVIEW_PENDING until approved → publish", async () => {
    mode = "warn08";
    const rev = await newRevision(id, 4);
    const first = await publish(id, rev);
    expect(first.run.failure).toMatchObject({ code: "GATES_FAILED", message_ru: REVIEW_PENDING_RU });
    expect(await founderReviewStatus(api.deps.db, id, rev)).toBe("pending");
    expect((await pendingFounderReviews(api.deps.db)).map((r) => [r.system_id, r.revision])).toEqual([
      [id, rev],
    ]);
    expect(await blockers(id)).toContain("FOUNDER_REVIEW_PENDING");
    const again = await api.req("POST", `/systems/${id}/publish`, {
      body: { revision: rev, confirmDiff: true },
    });
    expect(again.status).toBe(403);
    expect(again.body).toMatchObject({ code: "FOUNDER_REVIEW_PENDING", message_ru: REVIEW_PENDING_RU });

    expect(
      await decideFounderReview(api.deps.db, {
        systemId: id,
        revision: rev,
        decision: "approve",
        note: "ок",
      }),
    ).toBe(true);
    expect(await blockers(id)).not.toContain("FOUNDER_REVIEW_PENDING");
    calls.length = 0;
    const second = await publish(id, rev);
    expect(second.run.status, JSON.stringify(second.run.failure)).toBe("succeeded");
    expect((await sys(id)).prod_revision).toBe(rev);
    // G1 already passed on this revision in the first attempt: only G0 and G2 run again.
    expect(calls.map((c) => c.level)).toEqual(["G0", "G2"]);
    expect(await founderReviewStatus(api.deps.db, id, rev)).toBe("approved");
  });

  test("G2-AF-09 warning → review rejected → publish of that revision refused", async () => {
    mode = "warn09";
    const rev = await newRevision(id, 5);
    const r = await publish(id, rev);
    expect(r.run.failure).toMatchObject({ code: "GATES_FAILED", message_ru: REVIEW_PENDING_RU });
    expect(
      await decideFounderReview(api.deps.db, {
        systemId: id,
        revision: rev,
        decision: "reject",
        note: "ОРИ",
      }),
    ).toBe(true);
    expect(await blockers(id)).toContain("FOUNDER_REVIEW_PENDING");
    const again = await api.req("POST", `/systems/${id}/publish`, {
      body: { revision: rev, confirmDiff: true },
    });
    expect(again.status).toBe(403);
    expect(again.body).toMatchObject({ code: "FOUNDER_REVIEW_PENDING", message_ru: REVIEW_REJECTED_RU });
    expect(await decideFounderReview(api.deps.db, { systemId: id, revision: 999, decision: "approve" })).toBe(
      false,
    );
  });

  test("abuse context: org age, plan, brand allowlist; earlier reports (M2-08 abuse_reports)", async () => {
    const now = new Date(Date.now() + 10 * 86_400_000);
    expect(await abuseContext(api.deps.db, DEFAULT_ORG_ID, now)).toEqual({
      orgAgeDays: 10,
      plan: "free",
      brandAllowlist: ["sber"],
      abuseReportsPrev: 0,
    });
    // M2-08 reports (db.yaml#abuse_reports): dismissed ones do not count.
    await api.deps.pg`insert into platform.abuse_reports (system_id, url, category, status, sla_deadline)
      values (${id}, 'http://x.localhost/', 'fraud', 'takedown', now()), (${id}, 'http://x.localhost/', 'spam', 'dismissed', now()),
             (${id}, 'http://x.localhost/', 'phishing', 'new', now())`;
    try {
      expect((await abuseContext(api.deps.db, DEFAULT_ORG_ID)).abuseReportsPrev).toBe(2);
    } finally {
      await api.deps.pg`delete from platform.abuse_reports where system_id = ${id}`;
    }
  });
});

describe("milestone switch", () => {
  test("prodG2Required: M2+ or production; M0/M1 publish stays G0-only", () => {
    expect(loadConfig({}).prodG2Required).toBe(false);
    expect(loadConfig({ WIZARD_MILESTONE: "M1" }).prodG2Required).toBe(false);
    expect(loadConfig({ WIZARD_MILESTONE: "M2" }).prodG2Required).toBe(true);
    expect(loadConfig({ NODE_ENV: "production" }).prodG2Required).toBe(true);
    expect(loadConfig({ WIZARD_MILESTONE: "M3" }, { prodG2Required: false }).prodG2Required).toBe(false);
  });
});
