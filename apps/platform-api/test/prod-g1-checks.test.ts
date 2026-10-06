// Publish G1 of a revision without its own G1 (a compliance edit on top of a build, publish/workflows.ts gate_G1_prod)
// reuses the QA scenarios the build's G1 ran (db.yaml#g1_checks). Found by the local rehearsal of the pilot: card ACs
// without inline steps are checked only by QA scenarios, which lived in the builder's memory, so the publish G1 of the
// compliance revision failed G1-AC-COVER for every one of them. Here the forum's ACs lose their steps; the build hands
// G1 the same scenarios as QA checks. G1 is the real gate on the in-process runtime (as prod-g1.test.ts); G0 and G2 are
// scripted; the publication runs for real in Postgres.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { type GateContext, type GateReport, g1Checks, type QaCheck } from "@wizard/gates";
import { closeExecutors } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createAgentExecutors } from "../src/agents/executors.js";
import { inheritedG1Checks, type StoredG1Check } from "../src/runs/g1-checks.js";
import type { BuildHost, RunExecutors } from "../src/runs/types.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  passingReport,
  ROOT,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";

const forum = JSON.parse(readFileSync(join(ROOT, "specs/appspec/examples/forum.json"), "utf8")) as AppSpec;

/** The forum as an LLM build leaves it: scenario/constraint ACs carry no inline steps (QA writes the scenarios). */
const bare: AppSpec = {
  ...forum,
  acceptance: (forum.acceptance ?? []).map((a) =>
    a.check.type === "permission"
      ? a
      : {
          id: a.id,
          text: a.text,
          check: {
            type: a.check.type,
            ...(a.check.milestone ? { milestone: a.check.milestone } : {}),
          },
        },
  ),
};
/** What qa_generate hands the build's G1: one scenario per AC without steps (the forum's own scenarios). */
const qaChecks: QaCheck[] = g1Checks(forum).filter((c) => c.acId && c.scenario);
const QA_IDS = qaChecks.map((c) => c.id).sort();

/** Forum code of specs/runtime/examples (bakery excluded), as in prod-g1.test.ts. */
function forumFiles(): Map<string, string> {
  const base = join(ROOT, "specs/runtime/examples");
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(base, abs).replaceAll("\\", "/");
      if (rel === "bakery") continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(name)) out.set(rel, readFileSync(abs, "utf8"));
    }
  };
  walk(base);
  return out;
}

type SpecToOps = {
  specToOps(spec: unknown, o: { author: string }): unknown[];
  batchOps(ops: unknown[]): unknown[][];
};

/** "rewrite": after the passed G1 the build rewrites AC1 (new revision, G0 only) — its scenario must not be reused. */
let variant: "plain" | "rewrite" = "plain";
const REWRITTEN_AC1 = "Гость видит на главной странице только темы, закреплённые модератором";

async function build(host: BuildHost) {
  const lib = (await import(join(ROOT, "tools/fixtures/lib/spec-to-ops.mjs"))) as SpecToOps;
  for (const [i, ops] of lib.batchOps(lib.specToOps(bare, { author: "agent" })).entries()) {
    const { version } = await host.store.getSpec();
    const r = await host.runStep(`apply_ops_${i}`, () =>
      host.store.applyOps(ops, version, `${host.run.id}:ops_${i}:1`),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
  }
  for (const [path, src] of forumFiles()) await host.store.writeFile(path, src);
  await host.store.commitFiles();
  expect((await host.runGates("G0")).passed).toBe(true);
  const g1 = await host.runGates("G1", { checks: qaChecks });
  expect(g1.passed, JSON.stringify(g1.checks.filter((c) => c.status !== "pass")).slice(0, 2000)).toBe(true);
  if (variant === "rewrite") {
    const { spec, version } = await host.store.getSpec();
    const acceptance = (spec.acceptance ?? []).map((a) =>
      a.id === "AC1" ? { ...a, text: REWRITTEN_AC1 } : a,
    );
    const r = await host.store.applyOps(
      [{ op: "set_acceptance", acceptance }],
      version,
      `${host.run.id}:rewrite_ac1`,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect((await host.runGates("G0")).passed).toBe(true);
  }
  return { summary_ru: "Система собрана" };
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let real: RunExecutors | undefined;
const g1Calls: { env: string; specVersion: number; checks: string[]; report: GateReport }[] = [];

beforeAll(async () => {
  tdb = await createTestDb("prodg1qa", { migrator: true });
  api = await startApi(tdb.url, {
    config: { prodG2Required: true, unsafeLocalExec: true, milestone: "M2" },
    executors: {
      ...fakeExecutors({ spec: "forum" }),
      build: (host) => build(host),
      gates: async (level, ctx: GateContext) => {
        if (level !== "G1") return passingReport(level, ctx.specVersion, true);
        // The real G1 (in-process runtime, unsafe local exec) exactly as the platform executors run it.
        const report = (await real?.gates?.("G1", ctx)) as GateReport;
        g1Calls.push({
          env: ctx.env,
          specVersion: ctx.specVersion,
          checks: (ctx.checks ?? []).map((c) => c.id).sort(),
          report,
        });
        return report;
      },
    },
    createRouter: fakeRouterFactory(),
    publish: {
      smoke: async () => ({ ok: true }),
      lockRetryDelaysMs: [10, 10, 10],
      telegram: { mode: "outbox", outboxDir: null },
      moderationLog: () => {},
    },
  });
  real = createAgentExecutors({ pg: api.deps.pg, config: api.deps.config, g1Sandbox: null });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await closeExecutors();
  await tdb?.drop();
});

const sys = (id: string) =>
  api.deps.db.selectFrom("platform.systems").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

/** Interview → card → approve → the build above (G0, G1 with QA checks). */
async function builtSystem(prompt: string): Promise<string> {
  const created = await api.req("POST", "/systems", { body: { prompt } });
  expect(created.status, created.text).toBe(201);
  const id = created.body.system.id as string;
  await waitRun(api, created.body.run.id, ["succeeded"]);
  const ans = await api.req("POST", `/systems/${id}/answers`, { body: { restByRecommendation: true } });
  await waitRun(api, ans.body.run.id, ["succeeded"]);
  const s = await api.req("GET", `/systems/${id}`);
  const ap = await api.req("POST", `/systems/${id}/card/approve`, {
    body: { cardVersion: s.body.card.cardVersion },
  });
  expect(ap.status, ap.text).toBe(202);
  const run = await waitRun(api, ap.body.run.id, ["succeeded", "failed"], 240_000);
  expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
  return id;
}

/** The operator details (PUT /systems/:id/compliance): a new revision without a build. */
async function complianceRevision(id: string): Promise<number> {
  const cur = await sys(id);
  const put = await api.req("PUT", `/systems/${id}/compliance`, {
    body: {
      expectedVersion: cur.draft_revision,
      operatorName: "ООО «Северный ритейл»",
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
  return waitRun(api, r.body.run.id, ["succeeded", "failed"], 240_000);
}

const storedRows = (id: string) =>
  api.deps.db
    .selectFrom("platform.g1_checks")
    .select(["revision", "checks"])
    .where("system_id", "=", id)
    .orderBy("revision")
    .execute();

describe("publish G1 reuses the build's QA scenarios (db.yaml#g1_checks)", () => {
  test("compliance edit after the build → publish: G1 runs the stored scenarios and passes", async () => {
    variant = "plain";
    g1Calls.length = 0;
    const id = await builtSystem("Форум северного ритейла");
    const built = (await sys(id)).draft_revision;
    // The build's G1 ran the QA checks; the scenario ACs are kept (no PC probes, no spec-derived checks).
    expect(g1Calls.map((c) => [c.env, c.specVersion, c.checks])).toEqual([["draft", built, QA_IDS]]);
    const rows = await storedRows(id);
    expect(rows.map((r) => r.revision)).toEqual([built]);
    const stored = rows[0]?.checks as StoredG1Check[];
    expect(stored.map((s) => s.check.id).sort()).toEqual(QA_IDS);
    for (const s of stored) {
      expect(s.textSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.check.scenario?.steps.length).toBeGreaterThan(0);
    }

    const rev = await complianceRevision(id);
    expect(rev).toBeGreaterThan(built);
    g1Calls.length = 0;
    const run = await publish(id, rev);
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
    expect((await sys(id)).prod_revision).toBe(rev);
    expect(g1Calls.map((c) => [c.env, c.specVersion, c.checks])).toEqual([["prod", rev, QA_IDS]]);
    const g1 = g1Calls[0]?.report;
    expect(g1?.passed).toBe(true);
    expect(g1?.checks.filter((c) => c.id === "G1-AC-COVER" && c.status === "fail")).toEqual([]);
    for (const sc of QA_IDS) expect(g1?.checks.find((c) => c.id === sc)?.status).toBe("pass");
    // The passed publish G1 keeps its scenarios too (the next compliance revision finds them on this one).
    expect((await storedRows(id)).map((r) => r.revision)).toEqual([built, rev]);
  }, 600_000);

  test("an AC rewritten after the passed G1 gets no stale scenario: its G1-AC-COVER is a warning (D75), publish goes on", async () => {
    variant = "rewrite";
    g1Calls.length = 0;
    const id = await builtSystem("Форум с переписанным критерием");
    const s = await sys(id);
    const rewritten = s.draft_revision;
    const rows = await storedRows(id);
    expect(rows.map((r) => r.revision)).toEqual([rewritten - 1]);

    const rev = await complianceRevision(id);
    const spec = (
      await api.deps.db
        .selectFrom("platform.revisions")
        .select("spec")
        .where("system_id", "=", id)
        .where("version", "=", rev)
        .executeTakeFirstOrThrow()
    ).spec as unknown as AppSpec;
    expect(spec.acceptance?.find((a) => a.id === "AC1")?.text).toBe(REWRITTEN_AC1);
    const inherited = await inheritedG1Checks(api.deps.db, id, rev, spec);
    expect(inherited.checks.map((c) => c.id).sort()).toEqual(QA_IDS.filter((x) => x !== "SC-AC1"));
    expect(inherited.fromRevision.AC1).toBeUndefined();
    expect(inherited.fromRevision.AC2).toBe(rewritten - 1);

    g1Calls.length = 0;
    const run = await publish(id, rev);
    // D75: an uncovered scenario AC is QA's miss — a warning for the founder's review, not a refusal.
    expect(run.status).not.toBe("failed");
    const g1 = g1Calls[0]?.report;
    expect(g1Calls[0]?.checks).toEqual(QA_IDS.filter((x) => x !== "SC-AC1"));
    expect(g1?.passed).toBe(true);
    const cover = g1?.checks.filter((c) => c.id === "G1-AC-COVER") ?? [];
    expect(cover.map((c) => [c.status, c.severity, c.message_ru])).toEqual([
      ["warn", "warning", `Критерий AC1 «${REWRITTEN_AC1}» не проверяется автоматически`],
    ]);
  }, 600_000);
});
