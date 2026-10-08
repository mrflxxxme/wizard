// V3-04 acceptance, platform part (D77 (8), api.yaml uploadSystemBrief): the owner's ТЗ file (≤ 10 МБ, the format by
// signature) → text on the platform server → the T0 call brief_extract on recorded answers (fixture router, suite demo:
// answers in order) → a brief version author agent with the source in the assumptions and briefGaps in the answer; the
// draft fills only empty sections; without a recorded answer — the heuristic draft. Limits, a wrong type, another org's
// system, roles; the file and its name are not stored.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "@wizard/llm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  briefDraftTool,
  briefExtractMessages,
  draftToBrief,
  readBriefFile,
} from "../../../packages/agents/src/brief-extract/index.js";
import {
  COFFEE,
  encode8bit,
  PLAIN_TZ,
  sampleFile,
  TEA,
  type TzSample,
} from "../../../packages/agents/test/brief-extract-fixtures.js";
import { fixtureLine } from "../../../packages/agents/test/build-v2-fixtures.js";
import { sourceNote } from "../src/briefs/upload.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { createTestDb, fakeExecutors, startApi, type TestApi } from "./helpers.js";

const EDITOR = { "x-wizard-dev-user": "editor-upload@example.test" };
const VIEWER = { "x-wizard-dev-user": "viewer-upload@example.test" };
const STRANGER = { "x-wizard-dev-user": "stranger-upload@example.test" };

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;

/** Recorded answers in the order the uploads below call the model (suite demo answers by order). */
async function recordedLines(samples: readonly TzSample[]) {
  const out = [];
  for (const s of samples) {
    const { text } = await readBriefFile(sampleFile(s));
    out.push(
      fixtureLine("brief_extract", briefExtractMessages(text, 1, 1), [briefDraftTool().definition], {
        name: "submit_brief_draft",
        args: s.answer,
      }),
    );
  }
  return out;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "wz-brief-upload-"));
  mkdirSync(join(dir, "demo"), { recursive: true });
  const lines = await recordedLines([COFFEE, TEA, COFFEE]);
  writeFileSync(
    join(dir, "demo", "brief-upload.jsonl"),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  tdb = await createTestDb("v3upload");
  api = await startApi(tdb.url, {
    executors: fakeExecutors(),
    createRouter: (opts) =>
      createRouter({
        ...opts,
        mode: "fixture",
        fixture: { suite: "demo", name: "brief-upload", dir },
        env: {},
      }),
  });
  for (const h of [EDITOR, VIEWER, STRANGER])
    expect((await api.req("GET", "/me", { headers: h })).status).toBe(200);
  await api.deps.pg`update platform.memberships set role = 'viewer' where user_id =
    (select id from platform.users where email = 'viewer-upload@example.test')`;
  await api.deps.pg`delete from platform.memberships where user_id =
    (select id from platform.users where email = 'stranger-upload@example.test')`;
});

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

async function addSystem(name = "Кофейня"): Promise<string> {
  const key = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `u-${key}`,
      schema_key: key,
      name,
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

function form(bytes: Uint8Array, name: string): FormData {
  const f = new FormData();
  f.append("file", new File([new Uint8Array(bytes)], name));
  return f;
}

const upload = (id: string, bytes: Uint8Array, name: string, headers: Record<string, string> = EDITOR) =>
  api.req("POST", `/systems/${id}/brief/upload`, { body: form(bytes, name), headers });

describe("ТЗ file → brief draft (recorded answers of the model)", () => {
  let id: string;

  test("docx (named .txt — the type is taken from the signature) → version 1 author agent, gaps for the interview", async () => {
    id = await addSystem();
    const res = await upload(id, sampleFile(COFFEE), "ТЗ Иванова.txt");
    expect(res.status).toBe(201);
    expect(res.body.changed).toBe(true);
    expect(res.body.brief).toMatchObject({ version: 1, author: "agent" });
    const expected = draftToBrief(COFFEE.answer);
    expect(res.body.brief.brief).toMatchObject({
      goals: expected.goals,
      audience: expected.audience,
      scenarios: expected.scenarios,
      roles: expected.roles,
      assumptions: [{ text: sourceNote("docx"), source: "default" }],
    });
    expect(res.body.source).toMatchObject({
      kind: "file",
      format: "docx",
      truncated: false,
      method: "model",
      chunks: 1,
      answered: 1,
      piiReplaced: 0,
    });
    expect(res.body.gaps.missing).toEqual(COFFEE.missing);
    expect(res.body.gaps.blocking).toEqual(COFFEE.blocking);
    expect(res.body.diagrams.journey.nodes.length).toBeGreaterThan(0);
    // The call is journaled (no prompt text): T0 only, the system, no run.
    const calls = await api.deps.db
      .selectFrom("platform.llm_calls")
      .select(["call_type", "tier", "model_id", "run_id", "status", "org_id"])
      .where("system_id", "=", id)
      .execute();
    expect(calls).toEqual([
      {
        call_type: "brief_extract",
        tier: "T0",
        model_id: "gigachat-3.5",
        run_id: null,
        status: "ok",
        org_id: DEFAULT_ORG_ID,
      },
    ]);
    // Neither the file nor its name is stored.
    const rows = await api.deps
      .pg`select brief::text as b from platform.system_briefs where system_id = ${id}`;
    expect(rows.map((r) => r.b).join()).not.toContain("Иванова");
  });

  test("a second ТЗ fills only the empty sections; what was there stays", async () => {
    const res = await upload(id, sampleFile(TEA), "tea.md");
    expect(res.status).toBe(201);
    const b = res.body.brief.brief;
    const coffee = draftToBrief(COFFEE.answer);
    const tea = draftToBrief(TEA.answer);
    expect(res.body.brief.version).toBe(2);
    expect(b.goals).toEqual(coffee.goals);
    expect(b.audience).toBe(coffee.audience);
    expect(b.roles).toEqual(coffee.roles);
    expect(b.data).toEqual(tea.data);
    expect(b.integrations).toEqual(tea.integrations);
    expect(b.outOfScope).toEqual(tea.outOfScope);
    expect(b.design.references).toEqual(tea.design.references);
    expect(b.assumptions.map((a: { text: string }) => a.text)).toEqual([
      sourceNote("docx"),
      sourceNote("text"),
    ]);
    expect(res.body.brief.diff.length).toBeGreaterThan(0);
    // Left for the interview: the goal without a success sign and the buyer's retention period.
    expect(res.body.gaps.missing).toEqual(["goals", "data"]);
  });

  test("the same ТЗ again changes nothing: no new version (200)", async () => {
    const res = await upload(id, sampleFile(COFFEE), "tz.docx");
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.brief.version).toBe(2);
  });

  test("no recorded answer → the heuristic draft; a txt in Windows-1251", async () => {
    const other = await addSystem("Керамика");
    const res = await upload(other, encode8bit(PLAIN_TZ, "windows-1251"), "tz.txt");
    expect(res.status).toBe(201);
    expect(res.body.source).toMatchObject({ format: "text", method: "heuristic", answered: 0 });
    expect(res.body.brief.brief.goals.map((g: { text: string }) => g.text)).toEqual([
      "Записывать гостей на мастер-классы",
      "Продавать подарочные сертификаты",
    ]);
    expect(res.body.gaps.blocking).toEqual(["goals", "audience", "scenarios"]);
  });
});

describe("limits, types and access", () => {
  test("over 10 МБ → 413 (by the file and by the body); a wrong type → 415; no file or no text → 400", async () => {
    const id = await addSystem();
    const big = await upload(id, new Uint8Array(10 * 1024 * 1024 + 1).fill(0x41), "tz.txt");
    expect(big.status).toBe(413);
    expect(big.body).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(big.body.message_ru).toMatch(/10 МБ/);
    const huge = await upload(id, new Uint8Array(12 * 1024 * 1024).fill(0x41), "tz.txt");
    expect(huge.status).toBe(413);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
    const image = await upload(id, png, "tz.pdf");
    expect(image.status).toBe(415);
    expect(image.body).toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
      details: { reason: "UNSUPPORTED_FORMAT" },
    });
    expect(image.body.message_ru).toMatch(/\.docx, \.pdf, \.md и \.txt/);
    const noFile = await api.req("POST", `/systems/${id}/brief/upload`, {
      body: new FormData(),
      headers: EDITOR,
    });
    expect(noFile.status).toBe(400);
    const notForm = await api.req("POST", `/systems/${id}/brief/upload`, {
      body: { file: "x" },
      headers: EDITOR,
    });
    expect(notForm.status).toBe(400);
    const blank = await upload(id, new TextEncoder().encode("   \n\n"), "tz.md");
    expect(blank.status).toBe(400);
    expect(blank.body.details).toMatchObject({ reason: "EMPTY_TEXT" });
    // Nothing was written by refused uploads.
    expect((await api.req("GET", `/systems/${id}/brief`)).body.brief).toBeNull();
  });

  test("editor+: a viewer gets 403, another org's system and unknown ids 404", async () => {
    const id = await addSystem();
    const file = new TextEncoder().encode("Цели:\n- Принимать заявки");
    expect((await upload(id, file, "tz.md", VIEWER)).status).toBe(403);
    expect((await upload(id, file, "tz.md", STRANGER)).status).toBe(404);
    expect((await upload("not-a-uuid", file, "tz.md")).status).toBe(404);
    expect((await upload(crypto.randomUUID(), file, "tz.md")).status).toBe(404);
    expect((await api.req("GET", `/systems/${id}/brief`)).body.brief).toBeNull();
  });
});
