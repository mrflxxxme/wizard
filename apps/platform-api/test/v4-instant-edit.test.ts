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
import { fileKey } from "@wizard/build";
import {
  createRouter,
  type RouteInput,
  type RouteOutput,
  type Router,
  type RouterOptions,
} from "@wizard/llm";
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
/** The scripted answer of the point edit's model call (submit_file); null — the model fails. */
let pointAnswer: { content: string; summary: string } | null = null;
const pointCalls: RouteInput[] = [];

/** The fixture build's router; the point edit's call (tool submit_file) answers pointAnswer. */
function testRouter(opts: RouterOptions): Router {
  const fx = createRouter({
    ...opts,
    mode: "fixture",
    fixture: { suite: "demo", name: "v3/clinic", dir: fixtureDir },
    env: {},
  });
  return {
    ...fx,
    async route(input: RouteInput): Promise<RouteOutput> {
      if (!input.tools?.some((t) => t.name === "submit_file")) return fx.route(input);
      pointCalls.push(input);
      if (!pointAnswer) throw new Error("model unavailable");
      return {
        tier: "T1",
        model: "glm-5.3",
        result: {
          toolCalls: [{ id: "c1", name: "submit_file", args: pointAnswer }],
          finishReason: "tool-calls",
        },
        usage: { inputTokens: 3000, cachedTokens: 0, outputTokens: 1500 },
        creditsCharged: 0.2,
        creditsMilli: 200,
        routeReason: "default_T1",
        scrubbed: false,
        ruFallback: false,
      };
    },
  };
}

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
    createRouter: testRouter,
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
    // The preview of every slider value: the --ds-* variables it changes (apply-theme-tokens, no request).
    expect(Object.keys(g.body.preview.radius).sort()).toEqual(["crisp", "round", "sharp", "soft"]);
    expect(g.body.preview.radius[radius]).toHaveProperty("--ds-radius-md");
    expect(g.body.preview.radius[g.body.radius]).toEqual({});
    expect(g.body.preview.contrast.high).toHaveProperty("--ds-color-muted");
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

  test("«Укажи и измени» of a v3 system: only the clicked element's file changes, G0 and G1 after it, ≤ 60 s", async () => {
    const sys = await api.deps.db
      .selectFrom("platform.systems")
      .select(["draft_revision"])
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    const literals = (await api.req("GET", `/systems/${systemId}/edit/literals`)).body.literals as Literal[];
    const home = literals.find((l) => l.route === "/" && l.kind === "text") as Literal;
    const file = home.file;
    const manifestOf = async (version: number) => {
      const rev = await api.deps.db
        .selectFrom("platform.revisions")
        .select("files_manifest_sha")
        .where("system_id", "=", systemId)
        .where("version", "=", version)
        .executeTakeFirstOrThrow();
      return JSON.parse((await api.deps.blobs.get(rev.files_manifest_sha)).toString("utf8")) as Record<
        string,
        string
      >;
    };
    const before = await manifestOf(sys.draft_revision);
    const source = (await api.deps.blobs.get(before[file] as string)).toString("utf8");
    pointAnswer = {
      content: source.replace(home.value, "Запишитесь онлайн за минуту"),
      summary: "Заголовок стал короче и про запись онлайн",
    };
    const t0 = Date.now();
    const m = await api.req("POST", `/systems/${systemId}/messages`, {
      body: {
        text: "Сделай заголовок короче, про онлайн-запись",
        target: { wzId: `${fileKey(file)}:0`, componentName: "HeroSplit", file, line: 1, route: "/" },
      },
    });
    expect(m.status, JSON.stringify(m.body)).toBe(202);
    const done = await waitRun(api, m.body.run.id, ["succeeded", "failed"], 60_000);
    expect(done.status, JSON.stringify(done)).toBe("succeeded");
    expect(Date.now() - t0).toBeLessThanOrEqual(60_000);
    expect(pointCalls).toHaveLength(1);
    expect(JSON.stringify(pointCalls[0]?.messages)).toContain("про онлайн-запись");
    const after = await api.deps.db
      .selectFrom("platform.systems")
      .select(["draft_revision", "preview_revision"])
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    const changed = await manifestOf(after.draft_revision);
    const diff = Object.keys({ ...before, ...changed }).filter((p) => before[p] !== changed[p]);
    expect(diff).toEqual([file]);
    expect(after.preview_revision).toBe(after.draft_revision);
    const gates = await api.deps.db
      .selectFrom("platform.gate_reports")
      .select(["level", "passed"])
      .where("run_id", "=", m.body.run.id)
      .execute();
    expect(gates.map((g) => `${g.level}:${g.passed}`).sort()).toEqual(["G0:true", "G1:true"]);
  }, 120_000);

  test("a point edit whose answer breaks the file is refused: the draft stays, the run fails with the reason", async () => {
    const sys = await api.deps.db
      .selectFrom("platform.systems")
      .select(["draft_revision"])
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    const literals = (await api.req("GET", `/systems/${systemId}/edit/literals`)).body.literals as Literal[];
    const file = (literals.find((l) => l.route === "/") as Literal).file;
    pointAnswer = { content: "export default function Broken( {", summary: "сломано" };
    pointCalls.length = 0;
    const m = await api.req("POST", `/systems/${systemId}/messages`, {
      body: {
        text: "Сломай",
        target: { wzId: `${fileKey(file)}:0`, componentName: "HeroSplit", file, line: 1, route: "/" },
      },
    });
    expect(m.status).toBe(202);
    const done = await waitRun(api, m.body.run.id, ["succeeded", "failed"], 60_000);
    expect(done.status).toBe("failed");
    const after = await api.deps.db
      .selectFrom("platform.systems")
      .select(["draft_revision"])
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    expect(after.draft_revision).toBe(sys.draft_revision);
  }, 120_000);

  test("V4-24: «Собрать» after manual edits asks first — 409 REBUILD_REPLACES_EDITS with their number, no build", async () => {
    const brief = (await api.req("GET", `/systems/${systemId}/brief`)).body.brief as { version: number };
    const runs = async () =>
      (
        await api.deps.db
          .selectFrom("platform.runs")
          .select("id")
          .where("system_id", "=", systemId)
          .where("kind", "=", "build")
          .execute()
      ).length;
    const before = await runs();
    const r = await api.req("POST", `/systems/${systemId}/brief/approve`, {
      body: { version: brief.version },
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("REBUILD_REPLACES_EDITS");
    // The text and the photo, the sliders, the point edit of the tests above.
    expect(r.body.details.edits).toBeGreaterThanOrEqual(3);
    expect(r.body.message_ru).toBe(
      `Пересборка заменит ваши правки (${r.body.details.edits}). Пересобрать или выбрать блок и поправить его?`,
    );
    expect(await runs()).toBe(before);
  });
});
