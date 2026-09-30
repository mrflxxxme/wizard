// Acceptance M0-15: contract test — every response of a scenario is matched to an api.yaml operation by our own
// path matcher and validated with ajv against components.schemas; every x-milestone=M0 operation gets a 2xx.
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import formatsCjs from "ajv-formats";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ERROR_STATUS } from "../src/errors.js";
import {
  createTestDb,
  type FakeBuildOpts,
  fakeExecutors,
  fakeRouterFactory,
  loadYaml,
  parseSse,
  type Res,
  startApi,
  type TestApi,
  waitFor,
  waitRun,
} from "./helpers.js";

const addFormats = formatsCjs.default;

// biome-ignore lint/suspicious/noExplicitAny: arbitrary OpenAPI/JSON documents
type Json = Record<string, any>;
const doc = loadYaml("specs/platform/api.yaml") as Json;
const METHODS = ["get", "post", "put", "patch", "delete"];

interface Op {
  id: string;
  method: string;
  template: string;
  re: RegExp;
  literals: number;
  responses: Json;
}

const ops: Op[] = [];
for (const [template, item] of Object.entries(doc.paths as Json)) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    const wildcard = !!op["x-path-wildcard"];
    const re = new RegExp(
      `^${template.replace(/\{(\w+)\}/g, (_m, name: string) => (wildcard && name === "path" ? "(.+)" : "([^/]+)"))}$`,
    );
    ops.push({
      id: op.operationId,
      method,
      template,
      re,
      literals: template.split("/").filter((s) => s && !s.startsWith("{")).length,
      responses: op.responses,
      ...(op["x-milestone"] ? { milestone: op["x-milestone"] } : {}),
    } as Op);
  }
}
const m0 = ops.filter((o) => (o as Op & { milestone?: string }).milestone === "M0");

/** Own matcher: method + path template; the most literal template wins. */
function matchOp(method: string, path: string): Op | undefined {
  return ops
    .filter((o) => o.method === method.toLowerCase() && o.re.test(path))
    .sort((a, b) => b.literals - a.literals)[0];
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "api", components: doc.components });
const rewrite = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(rewrite)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [
            k,
            k === "$ref" && typeof x === "string" ? `api${x}` : rewrite(x),
          ]),
        )
      : v;
const compiled = new Map<string, ValidateFunction>();
function validator(key: string, schema: unknown): ValidateFunction {
  let v = compiled.get(key);
  if (!v) {
    v = ajv.compile(rewrite(schema) as Json);
    compiled.set(key, v);
  }
  return v;
}
const errorSchema = { $ref: "#/components/schemas/Error" };
const xHttpStatus = doc.components.schemas.Error.properties.code["x-http-status"] as Record<string, number>;

interface Rec {
  method: string;
  path: string;
  res: Res;
}
const records: Rec[] = [];

function check(r: Rec): string | null {
  const path = r.path.split("?")[0] as string;
  const op = matchOp(r.method, path);
  if (!op) return `${r.method} ${path}: no operation in api.yaml`;
  const status = r.res.status;
  const ct = r.res.headers.get("content-type") ?? "";
  let resp: Json | undefined = op.responses[String(status)];
  if (resp?.$ref) resp = doc.components.responses[String(resp.$ref).split("/").pop() as string];
  if (status >= 400) {
    const v = validator("Error", errorSchema);
    const code = String((r.res.body as Json).code);
    if (!v(r.res.body)) return `${op.id} ${status}: Error schema: ${ajv.errorsText(v.errors)}`;
    if (xHttpStatus[code] !== status) return `${op.id}: code ${code} ≠ status ${status}`;
    return null;
  }
  if (!resp) return `${op.id}: undocumented status ${status}`;
  const content = resp.content as Json | undefined;
  if (!content) return null;
  if (content["application/json"]) {
    if (!ct.includes("application/json")) return `${op.id}: content-type ${ct}`;
    const v = validator(`${op.id}:${status}`, content["application/json"].schema);
    return v(r.res.body)
      ? null
      : `${op.id} ${status}: ${ajv.errorsText(v.errors)} ${JSON.stringify(r.res.body).slice(0, 300)}`;
  }
  const types = Object.keys(content);
  return types.some((t) => ct.startsWith(t)) ? null : `${op.id}: content-type ${ct} ∉ ${types.join(", ")}`;
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
const state: FakeBuildOpts & { bundle?: boolean } = { spec: "forum", askInput: true, g0Pass: true };

async function call(method: string, path: string, init?: Parameters<TestApi["req"]>[2]): Promise<Res> {
  const res = await api.req(method, path, init);
  records.push({ method, path, res });
  return res;
}

function png(w: number, h: number): Blob {
  const img = new PNG({ width: w, height: h });
  img.data.fill(200);
  return new Blob([new Uint8Array(PNG.sync.write(img))], { type: "image/png" });
}

beforeAll(async () => {
  tdb = await createTestDb("contract");
  api = await startApi(tdb.url, { executors: fakeExecutors(state), createRouter: fakeRouterFactory() });
});
afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

describe("contract (api.yaml, x-milestone M0)", () => {
  test("ERROR_STATUS mirrors x-http-status", () => {
    expect(ERROR_STATUS).toEqual(xHttpStatus);
  });

  test("the path matcher resolves every M0 template", () => {
    expect(m0).toHaveLength(19);
    expect(matchOp("GET", "/systems/1/files/ui/a/b.tsx")?.id).toBe("getFile");
    expect(matchOp("GET", "/systems/1/gates/latest")?.id).toBe("getLatestGates");
    expect(matchOp("POST", "/systems/1/card/approve")?.id).toBe("approveCard");
    expect(matchOp("GET", "/runs/1/events")?.id).toBe("streamRunEvents");
  });

  test("scenario: all M0 operations respond per contract", async () => {
    // Errors on the way in.
    expect((await call("POST", "/systems", { body: { prompt: "x" } })).status).toBe(400);
    expect((await call("GET", "/systems/00000000-0000-0000-0000-00000000dead")).status).toBe(404);
    expect((await call("GET", "/runs/not-a-uuid")).status).toBe(404);

    // createSystem … answers (with Idempotency-Key) … card.
    const created = await call("POST", "/systems", {
      body: { prompt: "Регистрация на форум на 600 участников" },
    });
    expect(created.status).toBe(201);
    const sid: string = created.body.system.id;
    await waitRun(api, created.body.run.id, ["succeeded"]);
    const got = await call("GET", `/systems/${sid}`);
    expect(got.body.pendingQuestions.length).toBeGreaterThan(0);
    expect(got.body.messages.map((m: Json) => m.kind)).toEqual(["text", "notice", "questions"]);
    await call("GET", "/systems");
    await call("GET", `/systems/${sid}/messages?limit=2`);
    const q1 = got.body.pendingQuestions[0];
    const answersBody = {
      answers: [{ questionId: q1.id, optionId: q1.options[0].id }],
      restByRecommendation: true,
    };
    const key = { "idempotency-key": "answers-1" };
    const ans = await call("POST", `/systems/${sid}/answers`, { body: answersBody, headers: key });
    expect(ans.status).toBe(202);
    const replay = await call("POST", `/systems/${sid}/answers`, { body: answersBody, headers: key });
    expect(replay.body).toEqual(ans.body);
    expect(
      (await call("POST", `/systems/${sid}/answers`, { body: { restByRecommendation: true }, headers: key }))
        .body.code,
    ).toBe("IDEMPOTENCY_MISMATCH");
    await waitRun(api, ans.body.run.id, ["succeeded"]);
    const withCard = await call("GET", `/systems/${sid}`);
    expect(withCard.body.system.stage).toBe("card");
    expect(withCard.body.system.name).toBe(withCard.body.card.title);

    // approveCard → build asks for a decision → provideRunInput → succeeded.
    const cv = withCard.body.card.cardVersion;
    expect(
      (await call("POST", `/systems/${sid}/card/approve`, { body: { cardVersion: cv + 1 } })).body.code,
    ).toBe("CARD_VERSION_STALE");
    expect(
      (await call("POST", `/systems/${sid}/card/approve`, { body: { cardVersion: cv, capCredits: 1000 } }))
        .status,
    ).toBe(400);
    const ap = await call("POST", `/systems/${sid}/card/approve`, {
      body: { cardVersion: cv, capCredits: 30 },
    });
    expect(ap.status).toBe(202);
    expect(ap.body.run).toMatchObject({ kind: "build", mode: "create", credits: { cap: 30, estimate: 20 } });
    const runId: string = ap.body.run.id;
    const waiting = await waitRun(api, runId, ["needs_input"]);
    expect(waiting.status).toBe("needs_input");
    expect((await call("POST", `/systems/${sid}/messages`, { body: { text: "ещё" } })).body.code).toBe(
      "SYSTEM_LOCKED",
    );
    expect(
      (await call("POST", `/systems/${sid}/style`, { body: { expectedVersion: 1, theme: {} } })).body.code,
    ).toBe("SYSTEM_LOCKED");
    const pending = (
      await api.deps.db
        .selectFrom("platform.runs")
        .select("pending_input")
        .where("id", "=", runId)
        .executeTakeFirstOrThrow()
    ).pending_input as Json;
    expect(
      (await call("POST", `/runs/${runId}/input`, { body: { inputId: pending.inputId, choice: "nope" } }))
        .status,
    ).toBe(400);
    const input = await call("POST", `/runs/${runId}/input`, {
      body: { inputId: pending.inputId, choice: "retry" },
    });
    expect(input.status).toBe(202);
    expect(
      (await call("POST", `/runs/${runId}/input`, { body: { inputId: pending.inputId, choice: "retry" } }))
        .body.code,
    ).toBe("RUN_NOT_WAITING_INPUT");
    const done = await waitRun(api, runId, ["succeeded"]);
    await call("GET", `/runs/${runId}`);
    const sse = await call("GET", `/runs/${runId}/events`);
    expect(parseSse(sse.text).at(-1)?.event).toBe("run_finished");
    expect((await call("POST", `/runs/${runId}/cancel`)).body.code).toBe("RUN_NOT_CANCELLABLE");

    // Revisions, files, gates, preview.
    const revs = await call("GET", `/systems/${sid}/revisions?limit=100`);
    expect(revs.body.items[0].version).toBe(done.resultRevision);
    const rev = await call("GET", `/systems/${sid}/revisions/${done.resultRevision}`);
    expect(rev.body.files.map((f: Json) => f.path)).toEqual([
      "functions/registerTicket.ts",
      "ui/Landing.tsx",
    ]);
    expect((await call("GET", `/systems/${sid}/revisions/9999`)).status).toBe(404);
    const file = await call("GET", `/systems/${sid}/files/ui/Landing.tsx`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("content-security-policy")).toBe("sandbox");
    expect(file.headers.get("etag")).toBe(`"${rev.body.files[1].sha256}"`);
    expect((await call("GET", `/systems/${sid}/files/ui/..%2Fsecret`)).status).toBe(400);
    expect((await call("GET", `/systems/${sid}/files/ui/none.tsx`)).status).toBe(404);
    const gates = await call("GET", `/systems/${sid}/gates/latest`);
    expect(gates.body.reports.map((g: Json) => g.level)).toEqual(["G0"]);
    const prev = await call("GET", `/systems/${sid}/preview-url?role=participant`);
    expect(prev.body.url).toMatch(
      /^http:\/\/[a-z0-9-]+--draft\.localhost:4100\/_wizard\/dev-login\?role=participant&next=\/$/,
    );
    expect(prev.body.revision).toBe(done.resultRevision);
    // Default role is the public one: no login, the draft session is dropped instead.
    const pub = await call("GET", `/systems/${sid}/preview-url`);
    expect(pub.body.url).toMatch(
      /^http:\/\/[a-z0-9-]+--draft\.localhost:4100\/_wizard\/dev-logout\?next=\/$/,
    );

    // Style and logo (no credits, author=user).
    const draft = (await call("GET", `/systems/${sid}`)).body.system.draftRevision;
    const style = await call("POST", `/systems/${sid}/style`, {
      body: { expectedVersion: draft, theme: { accent: "#3355ff", radius: 8 } },
    });
    expect(style.status).toBe(200);
    expect(style.body.revision).toMatchObject({ author: "user", kind: "style", version: draft + 1 });
    expect(
      (await call("POST", `/systems/${sid}/style`, { body: { expectedVersion: draft, theme: {} } })).status,
    ).toBe(412);
    expect(
      (
        await call("POST", `/systems/${sid}/style`, {
          body: { expectedVersion: draft + 1, theme: { radius: 7 } },
        })
      ).body.code,
    ).toBe("OPS_INVALID");
    const form = new FormData();
    form.set("file", png(600, 300), "logo.png");
    form.set("expectedVersion", String(draft + 1));
    form.set("purpose", "logo");
    const logo = await call("POST", `/systems/${sid}/assets`, { body: form });
    expect(logo.status).toBe(201);
    expect(logo.body).toMatchObject({ path: "assets/logo.png", width: 512, height: 256 });
    const svg = new FormData();
    svg.set(
      "file",
      new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: "image/png" }),
      "logo.png",
    );
    svg.set("expectedVersion", String(draft + 2));
    expect((await call("POST", `/systems/${sid}/assets`, { body: svg })).status).toBe(415);
    const bin = await call("GET", `/systems/${sid}/files/assets/logo.png`);
    expect(bin.headers.get("content-type")).toBe("application/octet-stream");
    expect(bin.headers.get("content-disposition")).toContain("attachment");

    // Fix: nothing to fix → 409; a change build that fails G0 → fix → succeeded.
    expect((await call("POST", `/systems/${sid}/fix`, { body: {} })).body.code).toBe("NO_GATE_FAILURE");
    const change = await call("POST", `/systems/${sid}/messages`, { body: { text: "Хочу изменить форму" } });
    expect(change.status).toBe(202);
    await waitRun(api, change.body.run.id, ["succeeded"]);
    const changeCard = (await call("GET", `/systems/${sid}`)).body;
    expect(changeCard.card).toMatchObject({ kind: "change" });
    state.g0Pass = false;
    const ap2 = await call("POST", `/systems/${sid}/card/approve`, {
      body: { cardVersion: changeCard.card.cardVersion },
    });
    expect(ap2.body.run.mode).toBe("change");
    const failed = await waitRun(api, ap2.body.run.id, ["failed"]);
    expect(failed.failure.code).toBe("GATES_FAILED");
    expect((await call("GET", `/systems/${sid}`)).body.system.stage).toBe("ready");
    state.g0Pass = true;
    const fix = await call("POST", `/systems/${sid}/fix`, { body: {} });
    expect(fix.status).toBe(202);
    expect(fix.body.run).toMatchObject({ mode: "fix", credits: { cap: 5 } });
    await waitRun(api, fix.body.run.id, ["succeeded"]);

    // Cancel a running interview turn (cooperative).
    const slow = await call("POST", `/systems/${sid}/messages`, { body: { text: "подожди немного" } });
    await waitRun(api, slow.body.run.id, ["running"]);
    const cancel = await call("POST", `/runs/${slow.body.run.id}/cancel`);
    expect(cancel.status).toBe(202);
    const cancelled = await waitRun(api, slow.body.run.id, ["cancelled"]);
    expect(cancelled.status).toBe("cancelled");
    await waitFor(async () => (await api.req("GET", `/systems/${sid}`)).body.activeRunId === null);

    // Every recorded response conforms; every M0 operation had a 2xx.
    const problems = records.map(check).filter(Boolean);
    expect(problems).toEqual([]);
    const ok = new Set(
      records
        .filter((r) => r.res.status < 300)
        .map((r) => matchOp(r.method, r.path.split("?")[0] as string)?.id),
    );
    expect(m0.map((o) => o.id).filter((id) => !ok.has(id))).toEqual([]);
  });
});
