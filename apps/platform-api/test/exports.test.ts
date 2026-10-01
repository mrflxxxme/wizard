// Acceptance M2-10 (workflows.yaml#workflows.export_data, L4-08, L3-37): owner-only export of prod/draft into a ZIP of
// CSV per entity + spec.json; formula injection neutralized; personal data only on the owner's explicit consent;
// encrypted at rest with a 24 h TTL; single-use download link (15 min) → second download 410.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { migrateDraft, seedDraft } from "../src/agents/draft.js";
import { csvCell, neutralizeFormula, planExport } from "../src/exports/csv.js";
import { ExportStore, sweepExpiredExports } from "../src/exports/storage.js";
import { listEvents } from "../src/runs/events.js";
import { loadEventSchemas } from "./event-schemas.js";
import { startBuild } from "./flow.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  loadYaml,
  type Res,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";
import { expectContract } from "./session.js";

const schemas = loadEventSchemas();
const forum = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../specs/appspec/examples/forum.json"), "utf8"),
);
const EDITOR = { "x-wizard-dev-user": "editor-export@example.test" };
const STRANGER = { "x-wizard-dev-user": "stranger-export@example.test" };
const dec = new TextDecoder("utf-8", { ignoreBOM: true });

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let systemId = "";
let key = "";

beforeAll(async () => {
  tdb = await createTestDb("exports", { migrator: true });
  api = await startApi(tdb.url, {
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
    publish: {
      smoke: async () => ({ ok: true }),
      lockRetryDelaysMs: [10, 10, 10],
      telegram: { mode: "outbox", outboxDir: null },
    },
  });
  const b = await startBuild(api);
  systemId = b.systemId;
  expect((await waitRun(api, b.buildRunId, ["succeeded"], 20_000)).status).toBe("succeeded");
  const s0 = await sys();
  key = s0.schema_key;
  const put = await api.req("PUT", `/systems/${systemId}/compliance`, {
    body: {
      expectedVersion: s0.draft_revision,
      operatorName: "ООО «Форум»",
      operatorContact: "privacy@forum.example",
    },
  });
  expect(put.status, put.text).toBe(200);
  const pub = await api.req("POST", `/systems/${systemId}/publish`, {
    body: { revision: put.body.revision.version, confirmDiff: true },
  });
  expect(pub.status, pub.text).toBe(202);
  expect((await waitRun(api, pub.body.run.id, ["succeeded", "failed"], 20_000)).status).toBe("succeeded");
  await seedProd();
}, 90_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

function sys() {
  return api.deps.db
    .selectFrom("platform.systems")
    .selectAll()
    .where("id", "=", systemId)
    .executeTakeFirstOrThrow();
}

async function seedProd() {
  const p = `"app_${key}_prod"`;
  const pg = api.deps.pg;
  const [u] = await pg.unsafe(
    `insert into ${p}."users" (role, display_name, email, phone) values ('participant', 'Иван Петров', 'ivan.petrov@mail.ru', '+79161234567') returning id`,
  );
  const [s1] = await pg.unsafe(
    `insert into ${p}."stream" (name, capacity, description) values ('=1+1', 10, '-5') returning id`,
  );
  await pg.unsafe(
    `insert into ${p}."stream" (name, capacity, description) values ($1, 20, $2), ($3, 30, $4), ($5, 40, $6)`,
    ['Зал "А"; второй', "строка 1\nстрока 2", "@SUM(A1:A9)", "+cmd|' /C calc'!A0", "\tтаб", "\rвозврат"],
  );
  const [tt] = await pg.unsafe(
    `insert into ${p}."ticket_type" (name, kind, price, capacity) values ('Стандарт', 'standard', 1500, 100) returning id`,
  );
  const [t] = await pg.unsafe(
    `insert into ${p}."ticket" (ticket_type, stream, holder_user, holder_name, holder_email, holder_phone, status, amount, qr_token, event_starts_at)
     values ($1, $2, $3, 'Иван Петров', 'ivan.petrov@mail.ru', '+79161234567', 'paid', 1500, 'QR-SECRET-TOKEN', now()) returning id`,
    [tt?.id, s1?.id, u?.id],
  );
  await pg.unsafe(
    `insert into ${p}."payment" (ticket, provider_payment_id, kind, amount, status) values ($1, 'pay-1', 'refund', 100.5, 'succeeded')`,
    [t?.id],
  );
}

async function exportOf(
  env: "draft" | "prod",
  extra: Record<string, unknown> = {},
): Promise<{ exportId: string; runId: string }> {
  const res = await api.req("POST", `/systems/${systemId}/exports`, { body: { env, ...extra } });
  expect(res.status, res.text).toBe(202);
  expectContract("createExport", res);
  expect(res.body.run.kind).toBe("export");
  const run = await waitRun(api, res.body.run.id, ["succeeded", "failed", "cancelled"], 20_000);
  expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
  return { exportId: res.body.exportId, runId: res.body.run.id };
}

async function download(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const u = new URL(url);
  return api.fetch(
    new Request(`http://localhost:4000${u.pathname}${u.search}`, {
      headers: { host: "localhost:4000", ...headers },
    }),
  );
}

async function zipOf(exportId: string): Promise<Record<string, string>> {
  const got = await api.req("GET", `/systems/${systemId}/exports/${exportId}`);
  expect(got.status).toBe(200);
  expectContract("getExport", got);
  expect(got.body.status).toBe("ready");
  const res = await download(got.body.downloadUrl);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  return Object.fromEntries(Object.entries(files).map(([n, b]) => [n, dec.decode(b)]));
}

/** RFC 4180 reader with ';' (test oracle). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ";") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  return rows;
}

function table(csv: string | undefined): Record<string, string>[] {
  expect(csv?.startsWith("\uFEFF")).toBe(true);
  const [head, ...rest] = parseCsv((csv as string).slice(1));
  return rest.map((r) => Object.fromEntries((head ?? []).map((h, i) => [h, r[i] ?? ""])));
}

describe("CSV encoding (unit)", () => {
  test("formula injection: = + - @ TAB CR get a leading apostrophe; plain numbers of numeric columns stay", () => {
    expect(neutralizeFormula("=1+1")).toBe("'=1+1");
    expect(neutralizeFormula("+7 916")).toBe("'+7 916");
    expect(neutralizeFormula("-5")).toBe("'-5");
    expect(neutralizeFormula("-5", true)).toBe("-5");
    expect(neutralizeFormula("-100.50", true)).toBe("-100.50");
    expect(neutralizeFormula("-1+cmd|' /C calc'!A0", true)).toBe("'-1+cmd|' /C calc'!A0");
    expect(neutralizeFormula("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(neutralizeFormula("\tx")).toBe("'\tx");
    expect(neutralizeFormula("\rx")).toBe("'\rx");
    expect(neutralizeFormula("a=1")).toBe("a=1");
    expect(neutralizeFormula("")).toBe("");
  });

  test("RFC 4180 quoting with ';': separators, quotes and line breaks are quoted, quotes doubled", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell("просто")).toBe("просто");
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('Зал "А"')).toBe('"Зал ""А"""');
    expect(csvCell("1\n2")).toBe('"1\n2"');
    expect(csvCell('=HYPERLINK("http://x";"y")')).toBe('"\'=HYPERLINK(""http://x"";""y"")"');
    expect(csvCell("\rx")).toBe('"\'\rx"');
    expect(csvCell(" x")).toBe('" x"');
  });

  test("plan: qr_token and fields hidden from every reader are never exported; PII only with includePii", () => {
    const spec = structuredClone(forum);
    spec.permissions = spec.permissions.map((p: { entity: string; hiddenFields?: string[] }) =>
      p.entity === "stream" ? { ...p, hiddenFields: ["description"] } : p,
    );
    const cols = (includePii: boolean, t: string) =>
      planExport(spec, { includePii })
        .tables.find((x) => x.table === t)
        ?.columns.map((c) => c.name);
    expect(cols(true, "ticket")).not.toContain("qr_token");
    expect(cols(true, "ticket")).toEqual(
      expect.arrayContaining(["id", "created_at", "holder_email", "amount"]),
    );
    expect(cols(false, "ticket")).not.toEqual(expect.arrayContaining(["holder_name"]));
    expect(cols(false, "ticket")).not.toContain("holder_email");
    expect(cols(false, "ticket")).not.toContain("holder_phone");
    expect(cols(true, "stream")).toEqual([
      "id",
      "created_at",
      "updated_at",
      "created_by",
      "name",
      "capacity",
    ]);
    expect(cols(false, "users")).toEqual([
      "id",
      "role",
      "invited_by",
      "created_at",
      "last_login_at",
      "blocked_at",
    ]);
    expect(cols(true, "users")).toEqual(expect.arrayContaining(["display_name", "email", "phone"]));
    expect(planExport(spec, { includePii: false }).omittedPii).toBeGreaterThan(5);
    // speaker_application.phone is hidden only for the moderator: other readers see it, so it is exported.
    expect(cols(true, "speaker_application")).toContain("phone");
    expect(planExport(spec, { includePii: true }).tables.map((t) => t.table)).toEqual([
      "users",
      ...forum.entities.map((e: { name: string }) => e.name),
    ]);
  });
});

describe("export_data run and API", () => {
  test("only the owner: editor → 403 NOT_OWNER; another org → 404; body is validated", async () => {
    const asEditor = await api.req("POST", `/systems/${systemId}/exports`, {
      body: { env: "prod" },
      headers: EDITOR,
    });
    expect(asEditor.status).toBe(403);
    expect(asEditor.body.code).toBe("NOT_OWNER");
    expectContract("createExport", asEditor);
    expect((await api.req("GET", `/systems/${systemId}/exports`, { headers: EDITOR })).status).toBe(403);
    // A user outside the organization sees no system at all.
    await api.req("GET", "/me", { headers: STRANGER });
    await api.deps.pg`delete from platform.memberships where user_id in
      (select id from platform.users where email = 'stranger-export@example.test')`;
    for (const [m, p] of [
      ["POST", `/systems/${systemId}/exports`],
      ["GET", `/systems/${systemId}/exports`],
      ["GET", `/systems/${systemId}/exports/00000000-0000-4000-8000-000000000000`],
    ] as const) {
      const r = await api.req(m, p, {
        headers: STRANGER,
        ...(m === "POST" ? { body: { env: "prod" } } : {}),
      });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    const bad = await api.req("POST", `/systems/${systemId}/exports`, { body: { env: "stage" } });
    expect(bad.status).toBe(400);
    const extra = await api.req("POST", `/systems/${systemId}/exports`, {
      body: { env: "prod", code: true },
    });
    expect(extra.status).toBe(400);
  });

  test("system that is neither built nor published → 409 PREVIEW_NOT_READY", async () => {
    const created = await api.req("POST", "/systems", { body: { prompt: "Учёт заявок на ремонт" } });
    expect(created.status).toBe(201);
    await waitRun(api, created.body.run.id, ["succeeded"]);
    for (const env of ["draft", "prod"]) {
      const r = await api.req("POST", `/systems/${created.body.system.id}/exports`, { body: { env } });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("PREVIEW_NOT_READY");
    }
  });

  let first = "";
  test("prod without consent: every entity + users + spec.json; =1+1 → '=1+1; no qr_token, no PII", async () => {
    const { exportId, runId } = await exportOf("prod");
    first = exportId;
    const ev = await listEvents(api.deps.db, runId, 0);
    const bad = ev.map((e) => schemas.validate(e)).filter((x) => x !== null);
    expect(bad, JSON.stringify(bad)).toEqual([]);
    expect(ev.filter((e) => e.type === "step_started").map((e) => e.payload.step)).toEqual(["dump", "store"]);
    const fin = ev.at(-1);
    expect(fin?.type).toBe("run_finished");
    expect(fin?.payload.summary_ru).toMatch(
      /рабочей версии готова: 9 таблиц, \d+ строк.*без персональных данных/,
    );

    const files = await zipOf(exportId);
    expect(Object.keys(files).sort()).toEqual(
      ["spec.json", "users.csv", ...forum.entities.map((e: { name: string }) => `${e.name}.csv`)].sort(),
    );
    const s = await sys();
    const rev = await api.req("GET", `/systems/${systemId}/revisions/${s.prod_revision}`);
    expect(JSON.parse(files["spec.json"] as string)).toEqual(rev.body.spec);
    expect(Object.keys(files).some((n) => /\.(tsx?|js)$/.test(n))).toBe(false);

    const raw = files["stream.csv"] as string;
    expect(raw.startsWith("\uFEFFid;created_at;updated_at;created_by;name;capacity;description\r\n")).toBe(
      true,
    );
    expect(raw).toContain(";'=1+1;10;'-5\r\n");
    const streams = table(raw);
    // Rows inserted by one statement share created_at, so compare as sets.
    expect(streams.map((r) => `${r.name} | ${r.description}`).sort()).toEqual(
      [
        "'=1+1 | '-5",
        'Зал "А"; второй | строка 1\nстрока 2',
        "'@SUM(A1:A9) | '+cmd|' /C calc'!A0",
        "'\tтаб | '\rвозврат",
      ].sort(),
    );
    expect(streams[0]?.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:[\d.]+\+00:00$/);

    const tickets = table(files["ticket.csv"]);
    expect(tickets).toHaveLength(1);
    expect(Object.keys(tickets[0] ?? {})).not.toEqual(expect.arrayContaining(["qr_token"]));
    for (const c of ["holder_name", "holder_email", "holder_phone", "qr_token"])
      expect(Object.keys(tickets[0] ?? {})).not.toContain(c);
    expect(tickets[0]?.amount).toBe("1500.00");
    expect(table(files["payment.csv"])[0]?.amount).toBe("100.50");
    const users = table(files["users.csv"]);
    expect(users).toHaveLength(1);
    expect(Object.keys(users[0] ?? {})).not.toContain("email");
    const all = Object.values(files).join("\n");
    for (const secret of ["QR-SECRET-TOKEN", "ivan.petrov@mail.ru", "+79161234567", "Иван Петров"])
      expect(all).not.toContain(secret);
  });

  test("single-use link: the same link again → 410 EXPORT_LINK_USED; an expired link → 410", async () => {
    const got = await api.req("GET", `/systems/${systemId}/exports/${first}`);
    const url = got.body.downloadUrl as string;
    expect(url).toMatch(
      /^http:\/\/localhost:5173\/api\/v1\/systems\/[0-9a-f-]+\/exports\/[0-9a-f-]+\/download\?token=/,
    );
    expect((await download(url)).status).toBe(200);
    const again = await download(url);
    expect(again.status).toBe(410);
    expect(((await again.json()) as { code: string }).code).toBe("EXPORT_LINK_USED");
    // A new link from getExport invalidates the previous unused one.
    const a = (await api.req("GET", `/systems/${systemId}/exports/${first}`)).body.downloadUrl as string;
    const b = (await api.req("GET", `/systems/${systemId}/exports/${first}`)).body.downloadUrl as string;
    expect((await download(a)).status).toBe(410);
    await api.deps
      .pg`update platform.exports set download_token_expires_at = now() - interval '1 second' where id = ${first}`;
    expect((await download(b)).status).toBe(410);
    // The link also needs the owner's session.
    const c = (await api.req("GET", `/systems/${systemId}/exports/${first}`)).body.downloadUrl as string;
    expect((await download(c, EDITOR)).status).toBe(403);
    expect((await download(c, STRANGER)).status).toBe(404);
    expect((await download(c)).status).toBe(200);
    const list = await api.req("GET", `/systems/${systemId}/exports`);
    expect(list.status).toBe(200);
    expectContract("listExports", list);
    const item = list.body.items.find((x: { id: string }) => x.id === first);
    expect(item).toMatchObject({ env: "prod", status: "ready", downloads: 3, includePii: false });
    expect(item.size).toBeGreaterThan(0);
  });

  test("owner's explicit consent (includePii) adds personal data; the journal records it", async () => {
    const { exportId } = await exportOf("prod", { includePii: true });
    const files = await zipOf(exportId);
    const t = table(files["ticket.csv"])[0];
    expect(t).toMatchObject({
      holder_name: "Иван Петров",
      holder_email: "ivan.petrov@mail.ru",
      holder_phone: "'+79161234567",
    });
    expect(Object.keys(t ?? {})).not.toContain("qr_token");
    expect(files["ticket.csv"]).not.toContain("QR-SECRET-TOKEN");
    expect(table(files["users.csv"])[0]).toMatchObject({
      display_name: "Иван Петров",
      email: "ivan.petrov@mail.ru",
    });
    const list = await api.req("GET", `/systems/${systemId}/exports`);
    expect(list.body.items[0]).toMatchObject({ id: exportId, includePii: true, downloads: 1 });
    const [owner] = await api.deps.pg`select id from platform.users where email = 'dev@wizard.local'`;
    expect(list.body.items[0].createdBy).toBe(owner?.id);
  });

  test("archive is encrypted at rest; TTL removes it and the export becomes expired", async () => {
    const { exportId } = await exportOf("prod");
    const dir = join(api.artifactsDir, "exports");
    expect(readdirSync(dir)).toContain(`${exportId}.enc`);
    const raw = readFileSync(join(dir, `${exportId}.enc`));
    expect(raw.subarray(0, 4).toString()).toBe("WZE1");
    expect(raw.includes(Buffer.from("PK\u0003\u0004"))).toBe(false);
    const [row] = await api.deps
      .pg`select storage_key, expires_at - created_at as ttl from platform.exports where id = ${exportId}`;
    expect(row?.storage_key).toBe(`exports/${exportId}.enc`);
    await api.deps
      .pg`update platform.exports set expires_at = now() - interval '1 second' where id = ${exportId}`;
    const before = await api.req("GET", `/systems/${systemId}/exports/${exportId}`);
    expect(before.body).toMatchObject({ status: "expired", downloadUrl: null });
    expect(
      await sweepExpiredExports(api.deps.db, new ExportStore(api.artifactsDir, "")),
    ).toBeGreaterThanOrEqual(1);
    expect(readdirSync(dir)).not.toContain(`${exportId}.enc`);
    const after = await api.req("GET", `/systems/${systemId}/exports/${exportId}`);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ status: "expired", downloadUrl: null });
  });

  test("draft export reads app_<key>_draft (seed data) and the preview revision's spec", async () => {
    const s = await sys();
    const spec = (await api.req("GET", `/systems/${systemId}/revisions/${s.preview_revision}`)).body.spec;
    await migrateDraft(api.deps.pg, { systemKey: key, spec, prevSpec: null });
    await seedDraft(api.deps.pg, { systemKey: key, spec });
    const { exportId } = await exportOf("draft");
    const files = await zipOf(exportId);
    expect(JSON.parse(files["spec.json"] as string)).toEqual(spec);
    expect(table(files["stream.csv"]).length).toBeGreaterThan(0);
    expect(files["stream.csv"]).not.toContain("=1+1");
    const list = await api.req("GET", `/systems/${systemId}/exports`);
    expect(list.body.items[0]).toMatchObject({ id: exportId, env: "draft" });
  });

  test("api.yaml: Export statuses and the 410 code are the documented ones", () => {
    const doc = loadYaml("specs/platform/api.yaml") as {
      components: { schemas: { Export: { properties: { status: { enum: string[] } } } } };
    };
    expect(doc.components.schemas.Export.properties.status.enum).toEqual([
      "running",
      "ready",
      "failed",
      "expired",
    ]);
    const r: Res = {
      status: 410,
      headers: new Headers(),
      body: { code: "EXPORT_LINK_USED", message_ru: "x" },
      text: "",
    };
    expectContract("getExport", r);
  });
});
