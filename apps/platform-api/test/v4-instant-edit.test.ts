// V4-15 acceptance 2: an instant edit without a model — a text and a photo of a built v3 system replaced by their
// source refs (GET /systems/:id/edit/literals → POST) give a new draft revision with its preview in ≤ 3 s and no model
// call; the edited literal is in the new revision's file and in the draft bundle's source map; a stale revision is
// 412, a bad value 400, a viewer can read but not edit.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefNiche } from "@wizard/agents/builder";
import { systemBriefSchema } from "@wizard/appspec";
import { createRouter, type Router, type RouterOptions } from "@wizard/llm";
import { closeExecutors } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  clinicBrief,
  fakeComposer,
  pageComposeMessages,
  v3Lines,
  writeFixture,
} from "../../../packages/agents/test/v3-harness-fixtures.js";
import { createAgentExecutors } from "../src/agents/executors.js";
import { OutboxMailer } from "../src/auth/mailer.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { startV3Build } from "../src/builds-v3/start.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { createTestDb, startApi, type TestApi, waitRun } from "./helpers.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let outboxDir: string;
let fixtureDir: string;
let systemId: string;

function smallBrief() {
  const b = clinicBrief();
  return { ...b, scenarios: (b.scenarios ?? []).filter((s) => ["s_book", "s_lead"].includes(s.id)) };
}

beforeAll(async () => {
  tdb = await createTestDb("v4edit", { migrator: true });
  outboxDir = mkdtempSync(join(tmpdir(), "wz-v4edit-outbox-"));
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
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `v4e-${key}`,
      schema_key: key,
      name: "Клиника «Правка»",
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  systemId = row.id;
  await saveBriefVersion(api.deps.db, { systemId, brief: smallBrief(), author: "agent" });
  const run = await startV3Build(api.deps, { systemId, userId: DEV_USER_ID });
  const done = await waitRun(api, run.id, ["succeeded", "failed"], 240_000);
  if (done.status !== "succeeded") throw new Error(JSON.stringify(done));
}, 300_000);

afterAll(async () => {
  await api?.dispose();
  await closeExecutors();
  await tdb?.drop();
  rmSync(outboxDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
}, 120_000);

type Literal = { ref: string; kind: string; value: string; file: string; route?: string };

describe("V4-15: instant edits without a model", () => {
  test("a text and a photo by ref → a new revision and its preview in ≤ 3 s, no model call", async () => {
    const g = await api.req("GET", `/systems/${systemId}/edit/literals`);
    expect(g.status).toBe(200);
    const literals = g.body.literals as Literal[];
    const text = literals.find((l) => l.kind === "text" && l.route === "/");
    const photo = literals.find((l) => l.kind === "image");
    expect(text, JSON.stringify(literals.slice(0, 5))).toBeTruthy();
    if (!text) return;
    const calls = async () =>
      (
        await api.deps.db
          .selectFrom("platform.llm_calls")
          .select("id")
          .where("system_id", "=", systemId)
          .execute()
      ).length;
    const before = await calls();
    const NEW_PHOTO = "/_wizard/photos/11111111-1111-4111-8111-111111111111/1600";
    const edits = [
      { ref: text.ref, value: "Новый заголовок без модели" },
      // The fake composer's pages have no photos; the photo replacement is packages/build/test/source-map.test.ts.
      ...(photo ? [{ ref: photo.ref, value: NEW_PHOTO }] : []),
    ];
    const t0 = Date.now();
    const r = await api.req("POST", `/systems/${systemId}/edit/literals`, {
      body: { revision: g.body.revision, edits },
    });
    const wall = Date.now() - t0;
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.revision).toBe(g.body.revision + 1);
    expect(r.body.previewRevision).toBe(r.body.revision);
    expect(wall).toBeLessThanOrEqual(3_000);
    expect(await calls()).toBe(before);

    const sys = await api.deps.db
      .selectFrom("platform.systems")
      .select(["draft_revision", "preview_revision"])
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    expect(sys).toEqual({ draft_revision: r.body.revision, preview_revision: r.body.revision });
    const after = (await api.req("GET", `/systems/${systemId}/edit/literals`)).body.literals as Literal[];
    expect(after.map((l) => l.value)).toContain("Новый заголовок без модели");
    if (photo) expect(after.map((l) => l.value)).toContain(NEW_PHOTO);
    expect(after.length).toBe(literals.length);
    // The draft bundle of the new revision carries the source map the bridge reads.
    const rev = await api.deps.db
      .selectFrom("platform.revisions")
      .select(["bundle_key", "g0_passed"])
      .where("system_id", "=", systemId)
      .where("version", "=", r.body.revision)
      .executeTakeFirstOrThrow();
    expect(rev.bundle_key).toBeTruthy();
    const mapFile = join(api.artifactsDir, rev.bundle_key as string, "source-map.json");
    expect(existsSync(mapFile), mapFile).toBe(true);
    expect(readFileSync(mapFile, "utf8")).toContain("Новый заголовок без модели");

    // The draft moved on: the old revision is refused.
    const stale = await api.req("POST", `/systems/${systemId}/edit/literals`, {
      body: { revision: g.body.revision, edits: [{ ref: text.ref, value: "x" }] },
    });
    expect(stale.status).toBe(412);
    const ref2 = after.find((l) => l.value === "Новый заголовок без модели")?.ref as string;
    const empty = await api.req("POST", `/systems/${systemId}/edit/literals`, {
      body: { revision: r.body.revision, edits: [{ ref: ref2, value: "   " }] },
    });
    expect(empty.status).toBe(400);
    const outside = await api.req("POST", `/systems/${systemId}/edit/literals`, {
      body: { revision: r.body.revision, edits: [{ ref: "00000000:1", value: "Текст" }] },
    });
    expect(outside.status).toBe(400);
  }, 60_000);

  test("the sliders: radius, density, contrast and font pair rebuild ui/design.css, are saved into the design", async () => {
    const g = await api.req("GET", `/systems/${systemId}/edit/design`);
    expect(g.status).toBe(200);
    const pair = (g.body.fontPairs as { id: string }[]).find((p) => p.id !== g.body.fontPair);
    const radius = g.body.radius === "sharp" ? "round" : "sharp";
    const density = g.body.density === "airy" ? "compact" : "airy";
    const t0 = Date.now();
    const r = await api.req("POST", `/systems/${systemId}/edit/design`, {
      body: {
        revision: g.body.revision,
        radius,
        density,
        contrast: "high",
        ...(pair ? { fontPair: pair.id } : {}),
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Date.now() - t0).toBeLessThanOrEqual(3_000);
    expect(r.body.previewRevision).toBe(r.body.revision);
    expect(r.body.controls).toMatchObject({
      radius,
      density,
      contrast: "high",
      ...(pair ? { fontPair: pair.id } : {}),
    });

    // Saved: the design checkpoint holds it (the next build reuses it), GET reads it back.
    const again = await api.req("GET", `/systems/${systemId}/edit/design`);
    expect(again.body).toMatchObject({ radius, density, contrast: "high", revision: r.body.revision });
    const cp = await api.deps.pg<{ checkpoint: { data: { design: { radius: { set: string } } } } }[]>`
      select checkpoint from platform.system_build_checkpoints where system_id = ${systemId} and key = 'design'`;
    expect(cp[0]?.checkpoint.data.design.radius.set).toBe(radius);
    // The new revision's ui/design.css is the new design's (the radius tokens changed).
    const css = async (version: number) => {
      const rev = await api.deps.db
        .selectFrom("platform.revisions")
        .select("files_manifest_sha")
        .where("system_id", "=", systemId)
        .where("version", "=", version)
        .executeTakeFirstOrThrow();
      const manifest = JSON.parse((await api.deps.blobs.get(rev.files_manifest_sha)).toString("utf8"));
      return (await api.deps.blobs.get(manifest["ui/design.css"])).toString("utf8");
    };
    expect(await css(r.body.revision)).not.toBe(await css(g.body.revision));

    const bad = await api.req("POST", `/systems/${systemId}/edit/design`, {
      body: { revision: r.body.revision, fontPair: "Comic Sans+Arial" },
    });
    expect(bad.status).toBe(400);
  }, 60_000);
});
