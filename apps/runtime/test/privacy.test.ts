// M2-05: 152-ФЗ package of a system — legal template registry, policy page and version, consent journal _w_consents,
// withdrawal with a configured delay, subject requests of an admin, retention with the deletion journal.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSpec, dropSystemRoleDDL, type Entity, quoteIdent } from "@wizard/appspec";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  complianceInfo,
  createRuntimeApp,
  DRAFT_MARK,
  defaultLegalTemplates,
  LegalTemplateError,
  loadLegalTemplates,
  MemoryRegistry,
  migrateSystem,
  parseLegalTemplate,
  type RuntimeApp,
  schemaName,
} from "../src/index.js";
import { DB_URL, devEnv, forumSpec, login, newKey, request, seedRow, userIdOf, valueFor } from "./helpers.js";

const DAY = 86_400_000;

let sql: postgres.Sql;
let role: string;
const schemas: string[] = [];
/** Runtime with immediate anonymization (default) and with a 7-day delay after withdrawal. */
let now0: RuntimeApp;
let late: RuntimeApp;

async function system(rt: RuntimeApp, slug: string, spec: AppSpec) {
  const key = newKey();
  const schema = schemaName(key, "draft");
  schemas.push(schema);
  await migrateSystem(sql, { systemId: key, env: "draft", spec, runtimeRole: role });
  await rt.loadSystem({ systemKey: key, env: "draft", spec, slug });
  return { schema, host: `${slug}--draft.localhost` };
}

beforeAll(async () => {
  sql = postgres(DB_URL, { max: 6, onnotice: () => {} });
  role = `wz_rt_test_${randomBytes(4).toString("hex")}`;
  await sql.unsafe(`CREATE ROLE ${quoteIdent(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  const base = { db: sql, dbRole: role, env: devEnv };
  now0 = createRuntimeApp({ ...base, registry: new MemoryRegistry() });
  late = createRuntimeApp({ ...base, registry: new MemoryRegistry(), privacy: { withdrawalDays: 7 } });
});

afterAll(async () => {
  for (const s of schemas) await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(s)} CASCADE`);
  for (const s of schemas) for (const st of dropSystemRoleDDL(s)) await sql.unsafe(st);
  await sql.unsafe(`DROP OWNED BY ${quoteIdent(role)}`).catch(() => {});
  await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
  await sql.end();
});

const q = (schema: string, table: string) => `${quoteIdent(schema)}.${quoteIdent(table)}`;

async function call(
  rt: RuntimeApp,
  method: string,
  host: string,
  path: string,
  body?: unknown,
  cookie?: string,
) {
  const res = await rt.fetch(request(method, host, path, { body, cookie: cookie ?? null }));
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, text, json };
}

async function consentBody(rt: RuntimeApp, host: string, cookie: string) {
  const spec = (await call(rt, "GET", host, "/_wizard/spec", undefined, cookie)).json as {
    compliance: { policyVersion: string; consentTextHash: string };
  };
  return { policyVersion: spec.compliance.policyVersion, textHash: spec.compliance.consentTextHash };
}

async function deletionLog(schema: string) {
  return sql.unsafe<
    { entity: string; mode: string; rows_affected: number; cutoff: Date | null; fields: string[] }[]
  >(`select entity, mode, rows_affected, cutoff, fields from ${q(schema, "_w_deletion_log")} order by id`);
}

/** speaker_application body for a speaker (refs: a seeded stream, the speaker as owner). */
async function speakerBody(schema: string, spec: AppSpec): Promise<Record<string, unknown>> {
  const e = spec.entities.find((x) => x.name === "speaker_application") as Entity;
  const out: Record<string, unknown> = {};
  for (const f of e.fields) {
    if (["speaker_user", "status", "moderator_comment"].includes(f.name)) continue;
    if (f.type === "ref") out[f.name] = await seedRow(sql, schema, spec, f.ref?.entity as string);
    else out[f.name] = valueFor(f);
  }
  return out;
}

describe("legal templates", () => {
  test("built-in templates are drafts with the marker; registry rejects unmarked drafts and marked approvals", () => {
    const reg = defaultLegalTemplates();
    expect(reg.get("policy", "privacy")?.status).toBe("draft");
    for (const t of reg.list()) expect(t.body).toContain(DRAFT_MARK);
    expect(reg.pending()).toEqual(
      expect.arrayContaining([
        "policy:privacy",
        "consent:default",
        "consent:event_registration",
        "consent:orders",
      ]),
    );
    const head = (status: string) => `---\nid: x\nkind: consent\nversion: 1\nstatus: ${status}\n---\n`;
    expect(() => parseLegalTemplate(`${head("draft")}Текст без отметки`)).toThrow(LegalTemplateError);
    expect(() => parseLegalTemplate(`${head("approved")}${DRAFT_MARK}. Текст`)).toThrow(LegalTemplateError);
    expect(() => parseLegalTemplate("без заголовка")).toThrow(LegalTemplateError);
  });

  test("lawyer's files swap the drafts: consent text and policy version follow the approved template", () => {
    const dir = mkdtempSync(join(tmpdir(), "wz-legal-"));
    try {
      writeFileSync(
        join(dir, "any-name.md"),
        "---\nid: default\nkind: consent\nversion: 2026-10-01\nstatus: approved\n---\nСогласие для {{operatorName}} ({{appName}}).",
      );
      writeFileSync(
        join(dir, "policy.md"),
        "---\nid: privacy\nkind: policy\nversion: 2026-10-01\nstatus: approved\n---\n# Политика\n\n{{operator}}\n\n{{retention}}",
      );
      const reg = loadLegalTemplates(dir);
      expect(reg.pending()).not.toContain("consent:default");
      expect(reg.pending()).not.toContain("policy:privacy");
      const spec = forumSpec();
      spec.compliance = { ...spec.compliance, consentText: undefined, consentTemplateId: undefined };
      const own = complianceInfo(spec, reg);
      expect(own.consentText).toBe("Согласие для ООО «Северный ритейл» (Форум «Северный ритейл»).");
      const draft = complianceInfo(spec, defaultLegalTemplates());
      expect(draft.consentText).toContain(DRAFT_MARK);
      expect(own.policyVersion).not.toBe(draft.policyVersion);
      // An unknown template id falls back to default; the owner's own text wins over any template.
      spec.compliance = { ...spec.compliance, consentTemplateId: "nope" };
      expect(complianceInfo(spec, reg).consentText).toBe(own.consentText);
      expect(complianceInfo(forumSpec(), reg).consentText).toBe(forumSpec().compliance?.consentText);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("policy page", () => {
  test("forum: operator, address, every pii=basic label, retention, ЮKassa; version = RoleSpec.policyVersion", async () => {
    const spec = forumSpec();
    const A = await system(now0, "pol-a", spec);
    const page = await call(now0, "GET", A.host, "/privacy");
    expect(page.res.status).toBe(200);
    expect(page.res.headers.get("content-security-policy")).toContain("default-src 'self'");
    const text = page.text;
    expect(text).toContain(DRAFT_MARK);
    expect(text).toContain("ООО «Северный ритейл»");
    expect(text).toContain("г. Санкт-Петербург, Невский пр., д. 1, оф. 1");
    for (const e of spec.entities)
      for (const f of e.fields) if (f.pii === "basic") expect(text).toContain(f.label);
    expect(text).toContain(`Билет: 30 дн. от «${labelOf(spec)}», затем обезличивание`);
    expect(text).toContain("ЮKassa");
    expect(text).toContain("/_wizard/privacy");
    expect(text).not.toContain("{{");
    const version = /data-policy-version="([0-9a-f]{16})"/.exec(text)?.[1];
    const roleSpec = (await call(now0, "GET", A.host, "/_wizard/spec")).json as {
      compliance: { policyVersion: string; policyPage: string };
    };
    expect(version).toBe(roleSpec.compliance.policyVersion);
    expect(roleSpec.compliance.policyPage).toBe("/privacy");
  });

  test("retention change → new policy version; no policyPage in the spec → /privacy by default", async () => {
    const spec = forumSpec();
    const changed = forumSpec();
    const ticket = changed.entities.find((e) => e.name === "ticket") as Entity;
    ticket.retention = { ...ticket.retention, deleteAfterDays: 90 } as Entity["retention"];
    expect(complianceInfo(changed).policyVersion).not.toBe(complianceInfo(spec).policyVersion);

    const bare = forumSpec();
    bare.compliance = { ...bare.compliance, policyPage: undefined };
    expect(complianceInfo(bare).policyPage).toBe("/privacy");
    const B = await system(now0, "pol-b", bare);
    const page = await call(now0, "GET", B.host, "/privacy");
    expect(page.res.status).toBe(200);
    expect(page.text).toContain('data-testid="wz-policy"');
  });
});

function labelOf(spec: AppSpec): string {
  const ticket = spec.entities.find((e) => e.name === "ticket") as Entity;
  return ticket.fields.find((f) => f.name === "event_starts_at")?.label as string;
}

describe("consent journal", () => {
  test("create and pii update by a non-admin role write _w_consents; non-pii update and admin writes do not", async () => {
    const spec = forumSpec();
    const A = await system(now0, "cj-a", spec);
    const speaker = await login(now0, A.host, "speaker");
    const consent = await consentBody(now0, A.host, speaker);
    const body = await speakerBody(A.schema, spec);

    const denied = await call(now0, "POST", A.host, "/api/data/speaker_application", body, speaker);
    expect(denied.res.status).toBe(422);
    const created = await call(
      now0,
      "POST",
      A.host,
      "/api/data/speaker_application",
      { ...body, _consent: consent },
      speaker,
    );
    expect(created.res.status).toBe(201);
    const id = (created.json.item as { id: string }).id;
    const journal = () =>
      sql.unsafe<{ entity: string; row_id: string; policy_version: string; h: string }[]>(
        `select entity, row_id::text as row_id, policy_version, encode(consent_text_hash, 'hex') as h
         from ${q(A.schema, "_w_consents")} where entity = 'speaker_application' order by given_at`,
      );
    expect(await journal()).toEqual([
      {
        entity: "speaker_application",
        row_id: id,
        policy_version: consent.policyVersion,
        h: consent.textHash,
      },
    ]);

    const path = `/api/data/speaker_application/${id}`;
    expect((await call(now0, "PATCH", A.host, path, { company: "Другая" }, speaker)).res.status).toBe(200);
    expect(await journal()).toHaveLength(1);
    const pii = await call(
      now0,
      "PATCH",
      A.host,
      path,
      { phone: "+79990001122", _consent: consent },
      speaker,
    );
    expect(pii.res.status).toBe(200);
    expect(await journal()).toHaveLength(2);

    const organizer = await login(now0, A.host, "organizer");
    expect((await call(now0, "PATCH", A.host, path, { email: "x@example.ru" }, organizer)).res.status).toBe(
      200,
    );
    expect(await journal()).toHaveLength(2);
  });
});

describe("consent withdrawal", () => {
  test("immediate (default): blocked, owned rows anonymized, deletion journal mode consent_revoked", async () => {
    const spec = forumSpec();
    const A = await system(now0, "wd-a", spec);
    const cookie = await login(now0, A.host, "participant");
    const userId = await userIdOf(sql, A.schema, "participant");
    const ticket = await seedRow(sql, A.schema, spec, "ticket", { holder_name: "Пётр Тестов" }, userId);
    const rev = await call(now0, "POST", A.host, "/api/auth/consent/revoke", {}, cookie);
    expect(rev.res.status).toBe(200);
    const [t] = await sql.unsafe(
      `select holder_name, holder_phone from ${q(A.schema, "ticket")} where id = $1`,
      [ticket],
    );
    expect(t).toEqual({ holder_name: null, holder_phone: null });
    const log = await deletionLog(A.schema);
    expect(log.map((r) => [r.entity, r.mode, r.rows_affected])).toEqual([
      ["users", "consent_revoked", 1],
      ["ticket", "consent_revoked", 1],
    ]);
    expect(log[1]?.fields).toEqual(expect.arrayContaining(["holder_name", "holder_email", "holder_phone"]));
  });

  test("configured delay (7 days): login closed at once, anonymization by the job when due, journal once", async () => {
    const spec = forumSpec();
    const A = await system(late, "wd-b", spec);
    const cookie = await login(late, A.host, "participant");
    const userId = await userIdOf(sql, A.schema, "participant");
    const ticket = await seedRow(sql, A.schema, spec, "ticket", { holder_name: "Анна Тестова" }, userId);
    const before = Date.now();
    const rev = await call(late, "POST", A.host, "/api/auth/consent/revoke", {}, cookie);
    expect(rev.res.status).toBe(200);
    expect((await call(late, "GET", A.host, "/api/auth/me", undefined, cookie)).res.status).toBe(401);
    const user = async () =>
      (await sql.unsafe(`select email, blocked_at from ${q(A.schema, "users")} where id = $1`, [userId]))[0];
    const holder = async () =>
      (await sql.unsafe(`select holder_name from ${q(A.schema, "ticket")} where id = $1`, [ticket]))[0]
        ?.holder_name;
    expect((await user())?.blocked_at).not.toBeNull();
    expect((await user())?.email).toBe("dev-participant@dev.localhost");
    expect(await holder()).toBe("Анна Тестова");
    const [job] = await sql.unsafe(`select run_at from ${q(A.schema, "_w_jobs")} where kind = 'retention'`);
    const due = new Date(job?.run_at as Date).getTime();
    expect(due - before).toBeGreaterThanOrEqual(7 * DAY - 1000);
    expect(due - before).toBeLessThanOrEqual(7 * DAY + 60_000);

    const early = await late.runJobs({ slug: "wd-b", env: "draft", now: new Date(due - DAY) });
    expect(early.retention.filter((r) => r.mode === "consent_revoked")).toEqual([]);
    expect(await holder()).toBe("Анна Тестова");

    const run = await late.runJobs({ slug: "wd-b", env: "draft", now: new Date(due + 60_000) });
    expect(run.retention.filter((r) => r.mode === "consent_revoked")).toEqual([
      { entity: "users", mode: "consent_revoked", rows: 1 },
      { entity: "ticket", mode: "consent_revoked", rows: 1 },
    ]);
    expect((await user())?.email).toBeNull();
    expect(await holder()).toBeNull();
    await late.runJobs({ slug: "wd-b", env: "draft", now: new Date(due + 2 * DAY) });
    expect((await deletionLog(A.schema)).filter((r) => r.mode === "consent_revoked")).toHaveLength(2);
  });

  test("/_wizard/privacy shows the consent date and the delay", async () => {
    const A = await system(late, "wd-c", forumSpec());
    const cookie = await login(late, A.host, "participant");
    const page = await call(late, "GET", A.host, "/_wizard/privacy", undefined, cookie);
    expect(page.text).toContain('data-testid="wz-privacy-revoke"');
    expect(page.text).toContain("не позднее чем через 7 дн.");
    expect(page.text).toContain('href="/privacy"');
  });
});

describe("subject requests (/_wizard/pd-requests)", () => {
  test("admin finds, exports and erases a subject's rows; journal mode subject_request", async () => {
    const spec = forumSpec();
    const A = await system(now0, "sr-a", spec);
    const email = `subj${randomBytes(3).toString("hex")}@example.ru`;
    const subjectId = randomUUID();
    await sql.unsafe(
      `insert into ${q(A.schema, "users")} (id, role, email, display_name) values ($1, $2, $3, $4)`,
      [subjectId, "participant", email, "Субъект"],
    );
    const owned = await seedRow(
      sql,
      A.schema,
      spec,
      "ticket",
      { holder_email: "other@example.ru" },
      subjectId,
    );
    const byEmail = await seedRow(sql, A.schema, spec, "ticket", { holder_email: email.toUpperCase() });
    const app = await seedRow(sql, A.schema, spec, "speaker_application", { email, phone: "+79995550011" });
    const unrelated = await seedRow(sql, A.schema, spec, "ticket", { holder_email: "keep@example.ru" });
    await sql.unsafe(
      `insert into ${q(A.schema, "_w_consents")} (entity, row_id, policy_version, consent_text_hash) values ('users', $1, 'v1', '\\x00')`,
      [subjectId],
    );

    const admin = await login(now0, A.host, "organizer");
    const participant = await login(now0, A.host, "participant");
    const page = await call(now0, "GET", A.host, "/_wizard/pd-requests", undefined, admin);
    expect(page.res.status).toBe(200);
    expect(page.text).toContain('data-testid="wz-pd-form"');
    expect((await call(now0, "GET", A.host, "/_wizard/pd-requests", undefined, participant)).res.status).toBe(
      403,
    );
    expect((await call(now0, "GET", A.host, "/_wizard/pd-requests")).text).toContain("/login?next=");
    expect((await call(now0, "GET", A.host, "/_wizard/pd-requests.js")).text).toContain(
      "/api/admin/pd-requests/",
    );

    const api = "/api/admin/pd-requests";
    expect((await call(now0, "POST", A.host, `${api}/search`, { email }, participant)).res.status).toBe(403);
    expect((await call(now0, "POST", A.host, `${api}/search`, { email })).res.status).toBe(401);
    expect((await call(now0, "POST", A.host, `${api}/search`, {}, admin)).res.status).toBe(422);

    const found = await call(
      now0,
      "POST",
      A.host,
      `${api}/search`,
      { email: ` ${email.toUpperCase()} ` },
      admin,
    );
    expect(found.json).toEqual({
      users: 1,
      entities: [
        { entity: "ticket", label: "Билет", rows: 2 },
        { entity: "speaker_application", label: "Заявка спикера", rows: 1 },
      ],
    });
    const byPhone = await call(now0, "POST", A.host, `${api}/search`, { phone: "8 (999) 555-00-11" }, admin);
    expect((byPhone.json.entities as unknown[]).length).toBe(1);

    const exp = await call(now0, "POST", A.host, `${api}/export`, { email }, admin);
    expect(exp.res.headers.get("content-disposition")).toContain("attachment");
    const doc = exp.json as {
      users: { id: string; email: string }[];
      entities: { entity: string; rows: Record<string, unknown>[] }[];
      consents: { entity: string; rowId: string }[];
    };
    expect(doc.users).toEqual([expect.objectContaining({ id: subjectId, email })]);
    const tickets = doc.entities.find((e) => e.entity === "ticket")?.rows ?? [];
    expect(tickets.map((r) => r.id).sort()).toEqual([owned, byEmail].sort());
    expect(tickets[0]).not.toHaveProperty("qr_token");
    expect(doc.consents).toEqual([expect.objectContaining({ entity: "users", rowId: subjectId })]);

    const erased = await call(now0, "POST", A.host, `${api}/erase`, { email }, admin);
    expect(erased.res.status).toBe(200);
    expect(erased.json.entries).toEqual([
      { entity: "ticket", label: "Билет", rows: 2 },
      { entity: "speaker_application", label: "Заявка спикера", rows: 1 },
      { entity: "users", label: "Пользователи", rows: 1 },
    ]);
    const [u] = await sql.unsafe(`select email, blocked_at from ${q(A.schema, "users")} where id = $1`, [
      subjectId,
    ]);
    expect(u?.email).toBeNull();
    expect(u?.blocked_at).not.toBeNull();
    const [sa] = await sql.unsafe(
      `select email, phone from ${q(A.schema, "speaker_application")} where id = $1`,
      [app],
    );
    expect(sa?.email).not.toBe(email);
    const [keep] = await sql.unsafe(`select holder_email from ${q(A.schema, "ticket")} where id = $1`, [
      unrelated,
    ]);
    expect(keep?.holder_email).toBe("keep@example.ru");
    const log = (await deletionLog(A.schema)).filter((r) => r.mode === "subject_request");
    expect(log.map((r) => [r.entity, r.rows_affected])).toEqual([
      ["ticket", 2],
      ["speaker_application", 1],
      ["users", 1],
    ]);
    const after = await call(now0, "POST", A.host, `${api}/search`, { email }, admin);
    expect(after.json).toEqual({ users: 0, entities: [] });
    const [audit] = await sql.unsafe(
      `select count(*)::int as n from ${q(A.schema, "_w_audit")} where op in ('subject_export', 'subject_erase')`,
    );
    expect(audit?.n).toBe(2);
  });
});

describe("retention with the deletion journal", () => {
  test("anonymize/delete exactly the expired rows; journal rows with cutoff and counters; idempotent", async () => {
    const spec = forumSpec();
    const sa = spec.entities.find((e) => e.name === "speaker_application") as Entity;
    sa.retention = { deleteAfterDays: 180, mode: "delete" };
    const A = await system(now0, "rt-a", spec);
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
    const oldT = [
      await seedRow(sql, A.schema, spec, "ticket", { event_starts_at: at(40) }),
      await seedRow(sql, A.schema, spec, "ticket", { event_starts_at: at(31) }),
    ];
    const newT = await seedRow(sql, A.schema, spec, "ticket", { event_starts_at: at(10) });
    const oldA = await seedRow(sql, A.schema, spec, "speaker_application");
    const newA = await seedRow(sql, A.schema, spec, "speaker_application");
    await sql.unsafe(`update ${q(A.schema, "speaker_application")} set created_at = $2 where id = $1`, [
      oldA,
      at(200),
    ]);
    const oldU = randomUUID();
    const activeU = randomUUID();
    await sql.unsafe(
      `insert into ${q(A.schema, "users")} (id, role, email, display_name, created_at, last_login_at)
       values ($1, 'participant', $3, 'Старый', $5, null), ($2, 'participant', $4, 'Активный', $5, $6)`,
      [
        oldU,
        activeU,
        `old${oldU.slice(0, 6)}@example.ru`,
        `act${activeU.slice(0, 6)}@example.ru`,
        at(4 * 365),
        at(5),
      ],
    );

    const report = await now0.runJobs({ slug: "rt-a", env: "draft", now });
    expect(report.retention).toEqual(
      expect.arrayContaining([
        { entity: "ticket", mode: "anonymize", rows: 2 },
        { entity: "speaker_application", mode: "delete", rows: 1 },
        { entity: "users", mode: "anonymize", rows: 1 },
      ]),
    );
    const tickets = await sql.unsafe(`select id::text as id, holder_name from ${q(A.schema, "ticket")}`);
    for (const t of tickets) expect(t.holder_name === null).toBe(oldT.includes(String(t.id)));
    expect(tickets.find((t) => t.id === newT)?.holder_name).not.toBeNull();
    const apps = await sql.unsafe(`select id::text as id from ${q(A.schema, "speaker_application")}`);
    expect(apps.map((r) => r.id)).toEqual([newA]);
    const users = await sql.unsafe(
      `select id::text as id, email from ${q(A.schema, "users")} where id in ($1, $2)`,
      [oldU, activeU],
    );
    expect(users.find((u) => u.id === oldU)?.email).toBeNull();
    expect(users.find((u) => u.id === activeU)?.email).not.toBeNull();

    const log = await deletionLog(A.schema);
    const row = (entity: string) => log.find((r) => r.entity === entity);
    expect(row("ticket")).toMatchObject({ mode: "anonymize", rows_affected: 2 });
    expect(row("ticket")?.cutoff?.getTime()).toBe(now.getTime() - 30 * DAY);
    expect(row("speaker_application")).toMatchObject({ mode: "delete", rows_affected: 1, fields: [] });
    expect(row("users")).toMatchObject({ mode: "retention", rows_affected: 1 });
    expect(row("users")?.cutoff?.getTime()).toBe(now.getTime() - 3 * 365 * DAY);

    await now0.runJobs({ slug: "rt-a", env: "draft", now });
    expect(await deletionLog(A.schema)).toHaveLength(log.length);
  });
});
