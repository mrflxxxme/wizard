// Acceptance M1-02 (contract IDOR test + x-roles): with session cookies, every implemented api.yaml operation with
// {id}/{orgId} answers 404 for another organization's object (system/run/file/revision/events/org/…) and 403 for a
// role below x-roles (owner ⊃ editor ⊃ viewer; owner-only publishing — FORBIDDEN or NOT_OWNER). Build lock per
// system: the second build waits with lock_waiting; «кто меняет» and forced release by the owner.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  loadYaml,
  type Res,
  startApi,
  type TestApi,
  waitFor,
} from "./helpers.js";
import { devLogin, expectContract, MemoryMailer, type Session } from "./session.js";

// biome-ignore lint/suspicious/noExplicitAny: OpenAPI document
const doc = loadYaml("specs/platform/api.yaml") as { paths: Record<string, Record<string, any>> };
const METHODS = ["get", "post", "put", "patch", "delete"];
const norm = (p: string) => p.replace(/\{path\}/g, "*").replace(/\{\w+\}|:\w+/g, ":");

interface Op {
  id: string;
  method: string;
  tpl: string;
  role: "viewer" | "editor" | "owner";
}
const allOps: Op[] = Object.entries(doc.paths).flatMap(([tpl, item]) =>
  METHODS.filter((m) => item[m] && /\{(id|orgId)\}/.test(tpl))
    .map((m) => ({
      id: item[m].operationId as string,
      method: m.toUpperCase(),
      tpl,
      role: item[m]["x-roles"]?.[0],
    }))
    .filter((o) => ["viewer", "editor", "owner"].includes(o.role)),
);

const BODIES: Record<string, unknown> = {
  postMessage: { text: "Привет" },
  postAnswers: { restByRecommendation: true },
  approveCard: { cardVersion: 1 },
  startFixBuild: {},
  setStyle: { expectedVersion: 1, theme: { accent: "#112233" } },
  provideRunInput: { inputId: "x", choice: "retry" },
  publish: { revision: 1, confirmDiff: true },
  rollback: { env: "draft", toRevision: 1 },
  setCompliance: {},
  updateOrg: { name: "Взлом" },
  updateMemberRole: { role: "viewer" },
  createInvite: { email: "intruder@example.ru", role: "owner" },
  updateOrgSettings: { ruOnly: true },
  updateImportMapping: { mapping: [] },
  createExport: { env: "draft" },
  changeSubscription: { plan: "start" },
  createTopup: { packs: 1 },
};

interface OrgFixture {
  orgId: string;
  systemId: string;
  runId: string;
  inviteId: string;
  memberId: string;
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let ops: Op[];
let owner: Session;
let editor: Session;
let viewer: Session;
let foreign: Session;
let A: OrgFixture;
let B: OrgFixture;
const mailer = new MemoryMailer();

const runStatus = (s: Session, runId: string, statuses: string[]) =>
  waitFor(async () => {
    const r = await s.req("GET", `/runs/${runId}`);
    return statuses.includes(r.body.status) ? r.body : undefined;
  });

async function buildIn(
  s: Session,
  orgId: string,
  prompt: string,
): Promise<{ systemId: string; runId: string }> {
  const c = await s.req("POST", "/systems", { body: { prompt, orgId } });
  expect(c.status).toBe(201);
  const systemId = c.body.system.id as string;
  await runStatus(s, c.body.run.id, ["succeeded"]);
  const ans = await s.req("POST", `/systems/${systemId}/answers`, { body: { restByRecommendation: true } });
  await runStatus(s, ans.body.run.id, ["succeeded"]);
  const card = (await s.req("GET", `/systems/${systemId}`)).body.card;
  const ap = await s.req("POST", `/systems/${systemId}/card/approve`, {
    body: { cardVersion: card.cardVersion },
  });
  expect(ap.status).toBe(202);
  return { systemId, runId: ap.body.run.id };
}

async function orgWith(s: Session, name: string): Promise<OrgFixture> {
  const o = await s.req("POST", "/orgs", { body: { name, regionCode: "77" } });
  const orgId = o.body.id as string;
  const b = await buildIn(s, orgId, `Кондитерская ${name}`);
  await runStatus(s, b.runId, ["succeeded"]);
  const inv = await s.req("POST", `/orgs/${orgId}/invites`, {
    body: { email: `inv-${name}@example.ru`, role: "viewer" },
  });
  return { orgId, ...b, inviteId: inv.body.id, memberId: s.userId };
}

beforeAll(async () => {
  tdb = await createTestDb("roles");
  api = await startApi(tdb.url, {
    config: { authMode: "session", devLogin: true, runConcurrency: 4 },
    mailer,
    executors: fakeExecutors({ spec: "bakery" }),
    createRouter: fakeRouterFactory(),
  });
  const routes = new Set(api.app.routes.map((r) => `${r.method} ${norm(r.path)}`));
  ops = allOps.filter((o) => routes.has(`${o.method} ${norm(`/api/v1${o.tpl}`)}`));
  owner = await devLogin(api, "a-owner@example.ru");
  editor = await devLogin(api, "a-editor@example.ru");
  viewer = await devLogin(api, "a-viewer@example.ru");
  foreign = await devLogin(api, "b-owner@example.ru");
  A = await orgWith(owner, "A");
  B = await orgWith(foreign, "B");
  for (const [s, role] of [
    [editor, "editor"],
    [viewer, "viewer"],
  ] as const)
    await api.deps
      .pg`insert into platform.memberships (org_id, user_id, role) values (${A.orgId}, ${s.userId}, ${role})`;
  A.memberId = editor.userId;
});
afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

function url(tpl: string, f: OrgFixture): string {
  return tpl
    .replace("{id}", tpl.startsWith("/runs/") ? f.runId : f.systemId)
    .replace("{orgId}", f.orgId)
    .replace("{userId}", f.memberId)
    .replace("{inviteId}", f.inviteId)
    .replace("{v}", "1")
    .replace("{path}", "ui/Home.tsx")
    .replace(/\{\w+\}/g, "00000000-0000-4000-8000-000000000000");
}

async function send(s: Session, op: Op, f: OrgFixture): Promise<Res> {
  if (op.id === "uploadAsset") {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), "logo.png");
    form.set("expectedVersion", "1");
    return s.req(op.method, url(op.tpl, f), { body: form });
  }
  const body = BODIES[op.id] ?? (op.method === "GET" || op.method === "DELETE" ? undefined : {});
  return s.req(op.method, url(op.tpl, f), body !== undefined ? { body } : {});
}

describe("IDOR across organizations (session cookies)", () => {
  test("implemented operations with {id}/{orgId} include M0, M1-02, M1-04, M1-07, M2-05, M2-07 and M2-10 ones", () => {
    const ids = ops.map((o) => o.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "getSystem",
        "getFile",
        "getRevision",
        "streamRunEvents",
        "getRun",
        "getLock",
        "forceReleaseLock",
        "getOrg",
        "updateOrg",
        "listMembers",
        "updateMemberRole",
        "removeMember",
        "listInvites",
        "createInvite",
        "revokeInvite",
        "updateOrgSettings",
        "publish",
        "rollback",
        "listPublications",
        "getRevisionDiff",
        "setCompliance",
        "createImport",
        "getImport",
        "updateImportMapping",
        "createExport",
        "listExports",
        "getExport",
        "listDeletionLog",
        "getBilling",
        "startCardBinding",
        "changeSubscription",
        "cancelSubscription",
        "createTopup",
      ]),
    );
  });

  test("every operation on another org's object → 404 NOT_FOUND (both directions)", async () => {
    for (const op of ops) {
      for (const [s, f] of [
        [foreign, A],
        [owner, B],
        [viewer, B],
      ] as const) {
        const r = await send(s, op, f);
        expect(r.status, `${op.id} as ${s.email}`).toBe(404);
        expect(r.body.code).toBe("NOT_FOUND");
      }
    }
  });

  test("the org's own members still read its objects", async () => {
    // V3-32: the fixture has no PR preview and no agent repository — their own reads are covered by
    // v3-pr-preview.test.ts and v3-repo-agent.test.ts; here such a missing child object is a 404.
    const noChild = new Set(["getRepoSyncPull", "getAgentRepo"]);
    for (const op of ops.filter(
      (o) => o.method === "GET" && o.role === "viewer" && o.id !== "streamRunEvents",
    )) {
      const r = await send(viewer, op, A);
      if (noChild.has(op.id)) expect([r.status, r.body.code], op.id).toEqual([404, "NOT_FOUND"]);
      else expect(r.status, op.id).toBeLessThan(300);
    }
  });
});

describe("x-roles: owner ⊃ editor ⊃ viewer", () => {
  test("a role below x-roles → 403 (FORBIDDEN / NOT_OWNER), never 2xx", async () => {
    const below: Record<Op["role"], Session[]> = { viewer: [], editor: [viewer], owner: [editor, viewer] };
    let checked = 0;
    for (const op of ops) {
      for (const s of below[op.role]) {
        const r = await send(s, op, A);
        expect(r.status, `${op.id} as ${s.email}`).toBe(403);
        expect(["FORBIDDEN", "NOT_OWNER"]).toContain(r.body.code);
        expectContract(op.id, r);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(15);
  });

  test("publish is owner-only (checked by the matrix once the operation exists, M1-04)", async () => {
    const pub = ops.find((o) => o.id === "publish");
    if (!pub) return;
    for (const s of [editor, viewer]) expect((await send(s, pub, A)).status).toBe(403);
  });
});

describe("build lock per system", () => {
  test("second build (another member) waits with lock_waiting; lock status; only owner force-releases", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = await startApi(tdb.url, {
      config: { authMode: "session", devLogin: true, runConcurrency: 4 },
      mailer,
      migrate: false,
      executors: fakeExecutors({ spec: "bakery", gate }),
      createRouter: fakeRouterFactory(),
    });
    try {
      const o = await devLogin(a, "a-owner@example.ru");
      const e = await devLogin(a, "a-editor@example.ru");
      const v = await devLogin(a, "a-viewer@example.ru");
      const first = await buildIn(o, A.orgId, "Кондитерская с очередью");
      await runStatus(o, first.runId, ["running"]);
      const [second] = await a.deps.pg`
        insert into platform.runs (org_id, system_id, kind, mode, credits_cap_milli, input, started_by)
        values (${A.orgId}, ${first.systemId}, 'build', 'fix', 3000, '{}'::jsonb, ${e.userId}) returning id`;
      a.engine.enqueue({ id: second?.id, kind: "build", system_id: first.systemId });
      await runStatus(e, second?.id, ["waiting_lock"]);
      const ev = await a.deps.pg`select type, payload from platform.run_events where run_id = ${second?.id}`;
      expect(ev.map((x) => x.type)).toEqual(["lock_waiting"]);
      expect(ev[0]?.payload).toMatchObject({ holderRunId: first.runId, position: 1 });

      const lock = await v.req("GET", `/systems/${first.systemId}/lock`);
      expect(lock.status).toBe(200);
      expectContract("getLock", lock);
      expect(lock.body).toMatchObject({
        held: true,
        runId: first.runId,
        holder: { userId: o.userId, name: "a-owner@example.ru" },
        queue: [second?.id],
      });
      expect((await e.req("DELETE", `/systems/${first.systemId}/lock`)).status).toBe(403);
      expect((await o.req("DELETE", `/systems/${first.systemId}/lock`)).status).toBe(204);
      await runStatus(o, first.runId, ["cancelled"]);
      await runStatus(e, second?.id, ["running"]);
      release();
      await runStatus(e, second?.id, ["succeeded"]);
      const after = await v.req("GET", `/systems/${first.systemId}/lock`);
      expect(after.body).toMatchObject({ held: false, runId: null, holder: null, queue: [] });
      // A stale lock of a finished run is dropped.
      await a.deps.pg`insert into platform.locks (system_id, run_id, lease_until)
        values (${first.systemId}, ${first.runId}, now() + interval '1 minute')`;
      expect((await o.req("DELETE", `/systems/${first.systemId}/lock`)).status).toBe(204);
      expect((await v.req("GET", `/systems/${first.systemId}/lock`)).body.held).toBe(false);
    } finally {
      release();
      await a.dispose();
    }
  });
});
