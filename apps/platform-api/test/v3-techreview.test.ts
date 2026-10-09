// V3-15 acceptance, platform part: the techreview of a v3 build (builds-v3/techreview.ts wired into V3Host.hooks by
// builds-v3/host.ts) on recorded answers (packages/agents/test/v3-*-fixtures.ts; no network, no money): «Собрать» →
// … → techreview — the real G0 on the uncommitted system (migration dry run in the shadow schema against the preview
// revision), the static G2, the chains, then the reviewer on a model of another family than the builder (T0, recorded in
// platform.llm_calls) → the final gates (G0 of an unchanged revision is not run again). A clean review → the system is
// ready, its V3-20 contract passes the contract tests on the mock (no key — a note); a reviewer blocker → the run fails
// with GATES_FAILED and the revision is not published (publish refuses it with the reason, publishBlockers).

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefNiche, defaultBuilderFamilies, familyOf } from "@wizard/agents/builder";
import { contractFromOpenApi, contractHash } from "@wizard/agents/integrations";
import { systemBriefSchema } from "@wizard/appspec";
import { createRouter, type Router, type RouterOptions } from "@wizard/llm";
import { closeExecutors } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { crmOpenApi } from "../../../packages/agents/test/integrations/fixtures.js";
import {
  clinicBrief,
  fakeComposer,
  pageComposeMessages,
  v3Lines,
  writeFixture,
} from "../../../packages/agents/test/v3-harness-fixtures.js";
import { finding, reviewLine, workshopCtx } from "../../../packages/agents/test/v3-techreview-fixtures.js";
import { createAgentExecutors } from "../src/agents/executors.js";
import { OutboxMailer } from "../src/auth/mailer.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { startV3Build } from "../src/builds-v3/start.js";
import { latestG1, platformTechreviewDeps, runBuilderFamilies } from "../src/builds-v3/techreview.js";
import { techreviewBlockersOf } from "../src/builds-v3/techreview-verdict.js";
import { DEFAULT_ORG_ID, DEV_USER_EMAIL, DEV_USER_ID, json } from "../src/db/index.js";
import { insertContract } from "../src/integrations-v3/store.js";
import { listEvents } from "../src/runs/events.js";
import { loadEventSchemas } from "./event-schemas.js";
import { createTestDb, startApi, type TestApi, waitRun } from "./helpers.js";

const schemas = loadEventSchemas();

/** The clinic brief cut to two «must» scenarios (booking and the request): G0 + G1 per scenario keep it short. */
function smallBrief() {
  const b = clinicBrief();
  return { ...b, scenarios: (b.scenarios ?? []).filter((s) => ["s_book", "s_lead"].includes(s.id)) };
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let outboxDir: string;
let fixtureDir: string;
/** Recorded answers of the next run: v3/<answers>.jsonl (page_compose, then the reviewer). */
let answers = "clean";

beforeAll(async () => {
  tdb = await createTestDb("v3techreview", { migrator: true });
  outboxDir = mkdtempSync(join(tmpdir(), "wz-v3tr-outbox-"));
  const brief = systemBriefSchema.parse(smallBrief());
  const pages = v3Lines({
    brief: { goals: brief.goals, audience: brief.audience },
    niche: briefNiche(brief),
    seed: "x",
    pages: 6,
    prompt: pageComposeMessages({ brief, design: {} as never }, brief.scenarios[0] as never),
  });
  // Usage of a reviewer answer: the digest prompt of a system of the same size.
  const ctx = workshopCtx({
    route: async () => {
      throw new Error("no model");
    },
  });
  fixtureDir = writeFixture("clean", [...pages, reviewLine(ctx, { findings: [] })]);
  writeFixture(
    "blocked",
    [
      ...pages,
      reviewLine(ctx, {
        findings: [
          finding({
            area: "permissions",
            title_ru: "Посетитель без входа видит чужие записи на приём",
            evidence: { kind: "spec", ref: "/permissions/0" },
          }),
        ],
      }),
    ],
    fixtureDir,
  );
  api = await startApi(tdb.url, {
    config: { unsafeLocalExec: true },
    createRouter: (opts: RouterOptions): Router =>
      createRouter({
        ...opts,
        mode: "fixture",
        fixture: { suite: "demo", name: `v3/${answers}`, dir: fixtureDir },
        env: {},
      }),
    executors: ({ pg, config }) =>
      createAgentExecutors({
        pg,
        config,
        v3: { enabled: true, composer: fakeComposer(), mailer: new OutboxMailer(outboxDir) },
      }),
  });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await closeExecutors();
  await tdb?.drop();
  rmSync(outboxDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

async function build(
  name: string,
  which: string,
  o: { brief?: ReturnType<typeof smallBrief>; before?: (systemId: string) => Promise<void> } = {},
) {
  answers = which;
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const { id: systemId } = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `v3tr-${key}`,
      schema_key: key,
      name,
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await saveBriefVersion(api.deps.db, { systemId, brief: o.brief ?? smallBrief(), author: "agent" });
  await o.before?.(systemId);
  const run = await startV3Build(api.deps, { systemId, userId: DEV_USER_ID });
  const done = await waitRun(api, run.id, ["succeeded", "failed"], 300_000);
  const ev = await listEvents(api.deps.db, run.id, 0);
  expect(ev.map((e) => schemas.validate(e)).filter(Boolean)).toEqual([]);
  const calls = await api.deps.db
    .selectFrom("platform.llm_calls")
    .select(["call_type", "tier", "model_id", "status"])
    .where("run_id", "=", run.id)
    .execute();
  const sys = await api.deps.db
    .selectFrom("platform.systems")
    .select(["stage", "prod_revision", "draft_revision"])
    .where("id", "=", systemId)
    .executeTakeFirstOrThrow();
  return { run, done, ev, calls, sys, systemId };
}

const stagesOf = (ev: Awaited<ReturnType<typeof build>>["ev"]) =>
  ev.filter((e) => e.type === "build_stage").map((e) => `${e.payload.stage}:${e.payload.status}`);

describe("platform: the techreview of a v3 build (V3-15)", () => {
  test("a clean review: the deterministic part and a reviewer of another family, then the final gates — ready", async () => {
    // A V3-20 contract of the brief's outgoing integration, stored without a key (the build runs it on the mock).
    const contract = contractFromOpenApi(crmOpenApi(), {
      id: "crm",
      name: "Partner CRM",
      need: "заявки в CRM",
    });
    const brief = {
      ...smallBrief(),
      integrations: [{ id: "crm", name: "Partner CRM", direction: "out" as const }],
    };
    const { run, done, ev, calls, sys, systemId } = await build("Клиника «Техревью»", "clean", {
      brief,
      before: async (id) => {
        await api.deps.pg.begin((t) =>
          insertContract(t, {
            systemId: id,
            contract,
            sha256: contractHash(contract),
            tests: {},
            createdBy: DEV_USER_ID,
          }),
        );
      },
    });
    const gates = ev.filter((e) => e.type === "gate_result").map((e) => e.payload);
    expect(done.status, JSON.stringify({ failure: done.failure, gates })).toBe("succeeded");
    expect(stagesOf(ev)).toEqual(
      expect.arrayContaining(["techreview:started", "techreview:done", "gates:started", "gates:done"]),
    );
    expect(stagesOf(ev).indexOf("techreview:done")).toBeLessThan(stagesOf(ev).indexOf("gates:started"));
    // The techreview's own gates make no gate events: the gate runs are the preview, the scenarios and the final ones;
    // the final G0 is not run again — the revision is the one the last scenario's G0 passed (nothing changed since).
    expect(gates.map((g) => g.level)).toEqual(["G0", "G0", "G1", "G0", "G1", "G1", "G2"]);
    expect(gates.at(-2)?.revision).toBe(gates.at(-3)?.revision);
    // The reviewer: T0, a model of another family than the builder's page_compose.
    const builder = await runBuilderFamilies(api.deps.pg, run.id);
    expect(builder).toEqual(["glm"]);
    const review = calls.filter((c) => c.call_type === "techreview");
    expect(review).toEqual([
      { call_type: "techreview", tier: "T0", model_id: "deepseek-v4-pro", status: "ok" },
    ]);
    const family = familyOf(review[0]?.model_id ?? "");
    expect([...builder, ...defaultBuilderFamilies()]).not.toContain(family);
    // The evidence of the chains: the latest G1 of this run.
    expect((await latestG1(api.deps.pg, run.id)).map((r) => r.level)).toEqual(["G1"]);
    const finished = ev.find((e) => e.type === "run_finished")?.payload as { summary_ru: string };
    expect(finished.summary_ru).toContain("Техревью: проверил сборку и типы");
    expect(finished.summary_ru).toContain("Ревьюер на модели другого семейства нашёл 0 замечаний");
    expect(sys.stage).toBe("ready");
    expect(new OutboxMailer(outboxDir).list(DEV_USER_EMAIL)).toHaveLength(1);
    const cps = await api.deps.pg<{ data: { status: string; blockers: string[] } }[]>`
      select c.checkpoint -> 'data' as data from platform.system_build_checkpoints c
      where c.run_id = ${run.id} and c.key = 'techreview'`;
    expect(cps[0]?.data).toMatchObject({ status: "done", blockers: [] });
    // V3-20: the contract of the integration reaches the techreview with its state (mock — no key yet), the client of
    // the system is in the draft; the contract tests on the mock passed (no blocker above).
    const deps = platformTechreviewDeps({ run: { id: run.id, systemId } } as never, {
      pg: api.deps.pg,
      db: api.deps.db,
    });
    expect((await deps.contracts?.())?.map((c) => [c.integrationId, c.status, c.keyCheck])).toEqual([
      ["crm", "mock", null],
    ]);
    const draft = await api.deps.db
      .selectFrom("platform.revisions")
      .select("spec")
      .where("system_id", "=", systemId)
      .where("version", "=", sys.draft_revision)
      .executeTakeFirstOrThrow();
    const fns = (draft.spec as { functions?: { file: string }[] }).functions ?? [];
    expect(fns.some((f) => f.file.startsWith("functions/integrations/crm/"))).toBe(true);
    // Nothing of the techreview keeps this revision from publication.
    expect(await techreviewBlockersOf(api.deps.db, systemId, sys.draft_revision)).toEqual([]);
    const pub = await api.req("POST", `/systems/${systemId}/publish`, {
      body: { revision: sys.draft_revision, confirmDiff: true },
    });
    expect(String(pub.body?.message_ru ?? "")).not.toContain("Техревью");
  }, 420_000);

  test("a reviewer blocker: the run fails with GATES_FAILED, the system is not published", async () => {
    const { done, ev, calls, sys, systemId } = await build("Клиника «Блокер»", "blocked");
    expect(done.status).toBe("failed");
    expect(done.failure).toMatchObject({ code: "GATES_FAILED" });
    expect(String((done.failure as { message_ru?: string }).message_ru)).toContain(
      "Техревью нашло ошибку, с которой систему нельзя публиковать: Права: Посетитель без входа видит чужие записи на приём",
    );
    expect(calls.filter((c) => c.call_type === "techreview")).toHaveLength(1);
    // Not published: the final gates never ran (no stage «gates», no G2), no «Система собрана» letter, no prod revision;
    // the client keeps the preview of the draft (stage ready by the preview) and the reason in the run.
    expect(stagesOf(ev)).toContain("techreview:done");
    expect(stagesOf(ev)).not.toContain("gates:started");
    expect(ev.filter((e) => e.type === "gate_result").map((e) => e.payload.level)).not.toContain("G2");
    expect(new OutboxMailer(outboxDir).list(DEV_USER_EMAIL)).toHaveLength(1);
    expect(sys.prod_revision).toBeNull();
    // Publication refuses the revision the blocked build left, with the reason in Russian; publishBlockers says so too.
    const reason =
      "Техревью последней сборки нашло ошибку, с которой эту версию нельзя публиковать: Права: Посетитель без входа видит чужие записи на приём. Исправьте её и соберите систему заново.";
    expect(await techreviewBlockersOf(api.deps.db, systemId, sys.draft_revision)).toHaveLength(1);
    expect(await techreviewBlockersOf(api.deps.db, systemId, sys.draft_revision + 1)).toEqual([]);
    const pub = await api.req("POST", `/systems/${systemId}/publish`, {
      body: { revision: sys.draft_revision, confirmDiff: true },
    });
    expect(pub.status).toBeGreaterThanOrEqual(400);
    expect(pub.body).toMatchObject({ code: "GATES_FAILED", message_ru: reason });
    const g = await api.req("GET", `/systems/${systemId}`);
    expect(g.body.publishBlockers).toContain("GATES_FAILED");
  }, 420_000);
});
