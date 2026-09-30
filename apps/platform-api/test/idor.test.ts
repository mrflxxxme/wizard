// Acceptance M0-15: a system/run of another organization → 404 NOT_FOUND (not 403) for every M0 operation with :id.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startBuild } from "./flow.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  loadYaml,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";

const OTHER = "other@wizard.local";
// biome-ignore lint/suspicious/noExplicitAny: OpenAPI document
const doc = loadYaml("specs/platform/api.yaml") as { paths: Record<string, Record<string, any>> };
const idOps = Object.entries(doc.paths).flatMap(([tpl, item]) =>
  ["get", "post"]
    .filter((m) => item[m]?.["x-milestone"] === "M0" && tpl.includes("{id}"))
    .map((m) => ({ id: item[m].operationId as string, method: m.toUpperCase(), tpl })),
);

const BODIES: Record<string, unknown> = {
  postMessage: { text: "Привет" },
  postAnswers: { restByRecommendation: true },
  approveCard: { cardVersion: 1 },
  startFixBuild: {},
  setStyle: { expectedVersion: 1, theme: { accent: "#112233" } },
  cancelRun: undefined,
  provideRunInput: { inputId: "x", choice: "retry" },
};

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let other: TestApi;
let foreign: { systemId: string; runId: string };
let own: { systemId: string; runId: string };

beforeAll(async () => {
  tdb = await createTestDb("idor");
  api = await startApi(tdb.url, {
    executors: fakeExecutors({ spec: "bakery" }),
    createRouter: fakeRouterFactory(),
  });
  const [org] = await api.deps.pg`insert into platform.orgs (name) values ('Чужая организация') returning id`;
  const [user] = await api.deps.pg`insert into platform.users (email) values (${OTHER}) returning id`;
  await api.deps
    .pg`insert into platform.memberships (org_id, user_id, role) values (${org?.id}, ${user?.id}, 'owner')`;
  other = {
    ...api,
    req: (m, p, i = {}) => api.req(m, p, { ...i, headers: { "x-wizard-dev-user": OTHER, ...i.headers } }),
  };
  const f = await startBuild(other, "Кондитерская другой организации");
  await waitRun(other, f.buildRunId, ["succeeded"]);
  foreign = { systemId: f.systemId, runId: f.buildRunId };
  const o = await startBuild(api, "Своя кондитерская");
  await waitRun(api, o.buildRunId, ["succeeded"]);
  own = { systemId: o.systemId, runId: o.buildRunId };
});
afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

function url(tpl: string, ids: { systemId: string; runId: string }) {
  const id = tpl.startsWith("/runs/") ? ids.runId : ids.systemId;
  return tpl.replace("{id}", id).replace("{v}", "1").replace("{path}", "ui/Home.tsx");
}

async function send(a: TestApi, op: (typeof idOps)[number], ids: { systemId: string; runId: string }) {
  if (op.id === "uploadAsset") {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), "logo.png");
    form.set("expectedVersion", "1");
    return a.req(op.method, url(op.tpl, ids), { body: form });
  }
  return a.req(op.method, url(op.tpl, ids), BODIES[op.id] !== undefined ? { body: BODIES[op.id] } : {});
}

describe("IDOR", () => {
  test("api.yaml lists the :id operations", () => {
    expect(idOps.length).toBe(17);
  });

  test.each(idOps.map((o) => [o.id, o] as const))(
    "%s on another org's object → 404 NOT_FOUND",
    async (_id, op) => {
      const r = await send(api, op, foreign);
      expect(r.status).toBe(404);
      expect(r.body.code).toBe("NOT_FOUND");
    },
  );

  test.each(idOps.filter((o) => o.method === "GET").map((o) => [o.id, o] as const))(
    "%s: the owner org still sees its object",
    async (_id, op) => {
      const r = await send(other, op, foreign);
      expect(r.status).toBeLessThan(300);
      const mine = await send(api, op, own);
      expect(mine.status).toBeLessThan(300);
      const cross = await send(other, op, own);
      expect(cross.status).toBe(404);
    },
  );

  test("listSystems does not leak other orgs", async () => {
    const r = await api.req("GET", "/systems");
    expect(r.body.items.map((s: { id: string }) => s.id)).not.toContain(foreign.systemId);
  });
});
