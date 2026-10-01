// M3-01: POST /systems/:id/messages with target → build run mode=point_edit that may change target.file only
// (api.yaml#postMessage.target, agents/builder.yaml#point_and_edit). The fake builder tries the forbidden paths first.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { POINT_EDIT_CAP_CREDITS, wzFileKey } from "../src/routes/systems.js";
import { modeFixture } from "../src/runs/queue.js";
import type { BuildHost, BuildParams } from "../src/runs/types.js";
import {
  createTestDb,
  fakeBuild,
  fakeExecutors,
  fakeRouterFactory,
  ROOT,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
const seen: { params?: BuildParams; refusals: string[] } = { refusals: [] };
const EDITED = "export default function Landing() {\n  return <h1>Форум</h1>;\n}\n";

/** point_edit: other file, spec ops, then target.file; G0 as usual. */
async function pointEditBuild(host: BuildHost, p: BuildParams) {
  seen.params = p;
  const target = p.target?.file ?? "";
  for (const attempt of [
    () => host.store.writeFile("functions/registerTicket.ts", "export {};\n"),
    () => host.store.writeFile("ui/Other.tsx", "export default function O() { return null; }\n"),
    () => host.store.applyOps([], 0),
  ])
    await attempt().then(
      () => seen.refusals.push("accepted"),
      (e: Error) => seen.refusals.push(e.message.split(":")[0] ?? ""),
    );
  await host.store.writeFile(target, EDITED);
  await host.store.commitFiles();
  const g0 = await host.runGates("G0");
  return g0.passed ? { summary_ru: `Правка внесена в ${target}` } : undefined;
}

beforeAll(async () => {
  tdb = await createTestDb("pointedit");
  const base = fakeExecutors({ spec: "forum" });
  api = await startApi(tdb.url, {
    executors: {
      ...base,
      build: (host, p) =>
        p.mode === "point_edit" ? pointEditBuild(host, p) : fakeBuild(host, p, { spec: "forum" }),
    },
    createRouter: fakeRouterFactory(),
  });
});
afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

const call = (method: string, path: string, body?: unknown) =>
  api.req(method, path, body === undefined ? {} : { body });

async function builtSystem(): Promise<string> {
  const created = await call("POST", "/systems", { prompt: "Регистрация на форум на 600 участников" });
  const sid: string = created.body.system.id;
  await waitRun(api, created.body.run.id, ["succeeded"]);
  const ans = await call("POST", `/systems/${sid}/answers`, { restByRecommendation: true });
  await waitRun(api, ans.body.run.id, ["succeeded"]);
  const cv = (await call("GET", `/systems/${sid}`)).body.card.cardVersion;
  const ap = await call("POST", `/systems/${sid}/card/approve`, { cardVersion: cv });
  await waitRun(api, ap.body.run.id, ["succeeded"]);
  return sid;
}

const FILE = "ui/Landing.tsx";
const target = (over: Record<string, unknown> = {}) => ({
  wzId: `${wzFileKey(FILE)}:0`,
  componentName: "AppShell",
  file: FILE,
  line: 14,
  route: "/",
  ...over,
});

describe("postMessage with target (M3-01)", () => {
  let sid: string;
  beforeAll(async () => {
    sid = await builtSystem();
  });

  test("wzFileKey = first 8 hex of sha256(path) (ui-kit.yaml#wz_id.format)", () => {
    expect(wzFileKey(FILE)).toBe(createHash("sha256").update(FILE).digest("hex").slice(0, 8));
  });

  test("forged or foreign targets are rejected with VALIDATION_FAILED and start nothing", async () => {
    const runsBefore = (await api.deps.db.selectFrom("platform.runs").select("id").execute()).length;
    for (const t of [
      target({ file: "ui/Other.tsx", wzId: `${wzFileKey("ui/Other.tsx")}:0` }), // not in the draft revision
      target({ file: "functions/registerTicket.ts" }), // not ui/**
      target({ file: "ui/../functions/registerTicket.tsx" }), // path escape
      target({ wzId: "deadbeef:0" }), // wzId of another file
      target({ wzId: "demo:AppShell:0" }),
      target({ line: 0 }),
      target({ route: "//evil.example" }),
      { ...target(), extra: 1 },
    ]) {
      const r = await call("POST", `/systems/${sid}/messages`, { text: "крупнее", target: t });
      expect(r.status, JSON.stringify(t)).toBe(400);
      expect(r.body.code).toBe("VALIDATION_FAILED");
    }
    const long = await call("POST", `/systems/${sid}/messages`, { text: "я".repeat(501), target: target() });
    expect(long.status).toBe(400);
    expect((await api.deps.db.selectFrom("platform.runs").select("id").execute()).length).toBe(runsBefore);
  });

  test("a valid target starts point_edit; only target.file changes; the message keeps the target", async () => {
    const before = (await call("GET", `/systems/${sid}`)).body.system.draftRevision as number;
    const r = await call("POST", `/systems/${sid}/messages`, {
      text: "сделай заголовок крупнее",
      target: target(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.run).toMatchObject({
      kind: "build",
      mode: "point_edit",
      credits: { cap: POINT_EDIT_CAP_CREDITS },
    });
    expect(r.body.message).toMatchObject({
      role: "user",
      text: "сделай заголовок крупнее",
      payload: { target: { wzId: target().wzId, componentName: "AppShell", file: FILE, line: 14 } },
    });
    // The system is locked while the edit builds.
    const busy = await call("POST", `/systems/${sid}/messages`, { text: "ещё", target: target() });
    expect(busy.body.code).toBe("SYSTEM_LOCKED");

    const done = await waitRun(api, r.body.run.id, ["succeeded", "failed"]);
    expect(done.status, JSON.stringify(done.failure)).toBe("succeeded");
    expect(seen.params).toMatchObject({
      mode: "point_edit",
      cap: POINT_EDIT_CAP_CREDITS,
      target: { file: FILE, wzId: target().wzId, route: "/", instruction: "сделай заголовок крупнее" },
    });
    // The approved system card goes to the builder as is (roles, acceptance for G1).
    expect(seen.params?.card).toMatchObject({ kind: "create", cardVersion: 1, cap: { credits: 40 } });
    // Writes outside target.file and spec ops are refused by the platform store itself (defence in depth).
    expect(seen.refusals).toEqual(["TARGET_ONLY", "TARGET_ONLY", "TARGET_ONLY"]);

    const after = (await call("GET", `/systems/${sid}`)).body.system;
    expect(after.stage).toBe("ready");
    const d = await call("GET", `/systems/${sid}/revisions/${after.draftRevision}/diff?from=${before}`);
    expect(d.status).toBe(200);
    // Revision diff of the whole edit: one changed file, no spec changes.
    expect(d.body.changes).toEqual([{ kind: "file", text_ru: `Изменён файл ${FILE}` }]);
    const file = await call("GET", `/systems/${sid}/files/${FILE}`);
    expect(file.text).toBe(EDITED);
    const other = await call("GET", `/systems/${sid}/files/functions/registerTicket.ts`);
    expect(other.text).toBe(
      readFileSync(join(ROOT, "specs/runtime/examples/functions/registerTicket.ts"), "utf8"),
    );
  });
});

describe("modeFixture (fixture replay of point_edit runs)", () => {
  test("demo/<name>.point_edit.jsonl is used when it exists, only in fixture mode", () => {
    expect(modeFixture({ WIZARD_FIXTURE: "demo/forum" }, "point_edit")).toEqual({
      suite: "demo",
      name: "forum.point_edit",
      lenient: false,
    });
    expect(modeFixture({ WIZARD_FIXTURE: "demo/bakery" }, "point_edit")).toBeUndefined();
    expect(
      modeFixture({ WIZARD_FIXTURE: "demo/forum", WIZARD_LLM_MODE: "live" }, "point_edit"),
    ).toBeUndefined();
    expect(modeFixture({}, "point_edit")).toBeUndefined();
  });
});
