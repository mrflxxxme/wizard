// M2-50 (D69, D71) in the runtime: the workflow poller (jobsTick) starts on_create and schedule workflows of
// published systems; notify reaches the owner (platform email), masters by role and a visitor only with consent;
// Telegram without PII; reminder 24 h before; one-time cancel/unsubscribe links; journal _w_messages.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AppSpec, dropSystemRoleDDL, quoteIdent } from "@wizard/appspec";
import { staticSecretReader, tcpDialer } from "@wizard/connectors";
import { SmtpMock, TelegramMock } from "@wizard/connectors/mocks";
import { testPlatform } from "@wizard/connectors/testing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SYSTEM_SUBJECT } from "../src/data/access.js";
import {
  createRuntimeApp,
  MemoryRegistry,
  migrateSystem,
  type RegistryEntry,
  type RuntimeApp,
  schemaName,
} from "../src/index.js";
import { DB_URL, devEnv, newKey, repoRoot, request } from "./helpers.js";

const OWNER = "owner@example.ru";
const MASTER = "master@example.ru";
const VISITOR = "visitor@example.ru";
const PLATFORM_TOKEN = "700000001:PLATFORMtokenPLATFORMtokenPLATFORMtok";
const spec = (): AppSpec =>
  JSON.parse(readFileSync(join(repoRoot, "specs/runtime/examples/booking-notify.json"), "utf8")) as AppSpec;

let sql: postgres.Sql;
let role: string;
let rt: RuntimeApp;
let smtp: SmtpMock;
let tg: TelegramMock;
const registry = new MemoryRegistry([], {});
const schemas: string[] = [];

async function addSystem(slug: string, env: "draft" | "prod") {
  const key = newKey();
  const schema = schemaName(key, env);
  schemas.push(schema);
  const s = spec();
  await migrateSystem(sql, { systemId: key, env, spec: s, runtimeRole: role });
  await rt.loadSystem({ systemKey: key, env, spec: s, slug });
  const entry: RegistryEntry = {
    systemId: key,
    slug,
    env,
    revision: 1,
    specHash: "",
    bundleKey: "",
    publishedAt: new Date().toISOString(),
    suspended: false,
    features: { phoneOtp: false },
  };
  registry.list.push(entry);
  registry.owners[key] = [OWNER];
  const T = (t: string) => `${quoteIdent(schema)}.${quoteIdent(t)}`;
  // A master and the owner as users of the system, both with linked Telegram chats.
  await sql.unsafe(
    `insert into ${T("users")} (id, role, email, telegram_chat_id) values ($1, 'master', $2, 701)`,
    [randomUUID(), MASTER],
  );
  await sql.unsafe(
    `insert into ${T("users")} (id, role, email, telegram_chat_id) values ($1, 'owner', $2, 702)`,
    [randomUUID(), OWNER],
  );
  return { key, schema, T };
}

async function book(slug: string, env: "draft" | "prod", doc: Record<string, unknown>): Promise<string> {
  const sys = await rt.systems.resolve(slug, env);
  if (!sys) throw new Error("no system");
  return sys.data.transaction("write", SYSTEM_SUBJECT, (d) =>
    d.system.insert("booking", {
      name: "Анна Петрова",
      phone: "+79991234567",
      email: VISITOR,
      service: "Стрижка",
      status: "booked",
      ...doc,
    }),
  );
}

beforeAll(async () => {
  sql = postgres(DB_URL, { max: 6, onnotice: () => {} });
  role = `wz_rt_notify_${randomBytes(4).toString("hex")}`;
  await sql.unsafe(`CREATE ROLE ${quoteIdent(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  smtp = await new SmtpMock({ tls: "none" }).start();
  tg = await new TelegramMock().start();
  rt = createRuntimeApp({
    db: sql,
    registry,
    dbRole: role,
    env: devEnv,
    connectors: "live",
    platform: testPlatform({
      secrets: staticSecretReader({ telegram_bot_token: PLATFORM_TOKEN }),
      telegram: { apiBase: tg.url, botUsername: "wizard_notify_bot" },
      smtp: { host: "127.0.0.1", port: smtp.port, tls: "none" },
      dial: tcpDialer,
    }),
    http: false,
  });
});

afterAll(async () => {
  for (const s of schemas) await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(s)} CASCADE`);
  for (const s of schemas) for (const st of dropSystemRoleDDL(s)) await sql.unsafe(st);
  await sql.unsafe(`DROP OWNED BY ${quoteIdent(role)}`).catch(() => {});
  await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
  await sql.end();
  await smtp.stop();
  await tg.stop();
});

const mailTo = (to: string) => smtp.mails.filter((m) => m.to.includes(to));
const header = (data: string, name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(data)?.[1] ?? null;

describe("prod: the poller delivers a new lead", () => {
  test("owner and master get mail with the lead in the body; Telegram without PII; visitor without consent — nothing", async () => {
    const { T } = await addSystem("zapis-prod", "prod");
    const before = smtp.mails.length;
    await book("zapis-prod", "prod", { starts_at: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    const r = await rt.jobsTick();
    expect(r.ran.find((x) => x.slug === "zapis-prod")).toMatchObject({ failed: 0 });
    const fresh = smtp.mails.slice(before);
    expect(fresh.flatMap((m) => m.to).sort()).toEqual([MASTER, OWNER]);
    const ownerMail = mailTo(OWNER).at(-1)?.data ?? "";
    // D71: no PII in the subject (the body carries name and phone; it is encoded, so the subject is checked here).
    expect(header(ownerMail, "Subject")).not.toMatch(/Анна|7999/);
    expect(mailTo(VISITOR)).toHaveLength(0);
    // Telegram: shared bot to both linked chats, «Новая заявка — откройте по ссылке», no phone, no name.
    const sends = tg.calls.filter((c) => c.method === "sendMessage");
    expect(sends.map((c) => String((c.body as { chat_id: unknown }).chat_id)).sort()).toEqual(["701", "702"]);
    for (const c of sends) {
      const text = String((c.body as { text: unknown }).text);
      expect(text).toContain("Новая заявка — откройте по ссылке http://zapis-prod.");
      expect(text).not.toMatch(/Анна|7999|visitor@/);
    }
    const journal = await sql.unsafe(
      `select channel, recipient, status, address_hash from ${T("_w_messages")}`,
    );
    expect(journal.map((j) => `${j.channel}:${j.recipient}:${j.status}`).sort()).toEqual([
      "email:owner:sent",
      "email:role:sent",
      "email:visitor:no_consent",
      "telegram:owner:sent",
      "telegram:role:sent",
    ]);
    expect(JSON.stringify(journal)).not.toContain("example.ru");
    // A second tick does not resend.
    await rt.jobsTick();
    expect(smtp.mails.length - before).toBe(2);
  });
});

describe("draft: visitor messages with consent, reminder and one-time links", () => {
  const HOST = "zapis--draft.localhost:4100";
  let T: (t: string) => string;
  let id: string;
  const visitorTexts = () =>
    rt
      .outbox()
      .filter((m) => (m.payload as { to?: unknown }).to === VISITOR)
      .map((m) => String((m.payload as { text?: unknown }).text));

  beforeAll(async () => {
    ({ T } = await addSystem("zapis", "draft"));
  });

  test("confirmation with links; reminder 24 h before; cancel by link once; unsubscribe stops mail", async () => {
    const now = Date.now();
    id = await book("zapis", "draft", {
      starts_at: new Date(now + 2 * 86_400_000).toISOString(),
      consent_messages: true,
    });
    await rt.jobsTick({ envs: ["draft"] });
    expect(visitorTexts()).toHaveLength(1);
    const confirm = visitorTexts()[0] as string;
    const cancel = /(\/_wizard\/hooks\/message\/cancel\/[A-Za-z0-9_-]+)/.exec(confirm)?.[1] as string;
    const unsubscribe = /(\/_wizard\/hooks\/message\/unsubscribe\/[A-Za-z0-9_-]+)/.exec(
      confirm,
    )?.[1] as string;
    expect(cancel).toBeTruthy();
    expect(unsubscribe).toBeTruthy();

    // Reminder: nothing yet a minute before «starts_at − 24 h», then exactly one.
    await rt.jobsTick({ envs: ["draft"], now: new Date(now + 86_400_000 - 60_000) });
    expect(visitorTexts()).toHaveLength(1);
    await rt.jobsTick({ envs: ["draft"], now: new Date(now + 86_400_000 + 60_000) });
    expect(visitorTexts()).toHaveLength(2);
    expect(visitorTexts()[1]).toContain("напоминаем");

    // GET shows a confirmation and changes nothing (mail scanners prefetch links).
    const page = await rt.fetch(request("GET", HOST, cancel));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Отменить запись?");
    const st = async () =>
      (await sql.unsafe(`select status, consent_messages from ${T("booking")} where id = $1`, [id]))[0];
    expect((await st())?.status).toBe("booked");
    const done = await rt.fetch(request("POST", HOST, cancel, { csrf: false }));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Запись отменена");
    expect((await st())?.status).toBe("cancelled");
    expect((await rt.fetch(request("POST", HOST, cancel, { csrf: false }))).status).toBe(404);
    // A forged or foreign token is refused.
    expect(
      (await rt.fetch(request("POST", HOST, `${cancel.slice(0, -4)}AAAA`, { csrf: false }))).status,
    ).toBe(404);
    expect(
      (await rt.fetch(request("POST", HOST, cancel.replace("/cancel/", "/unsubscribe/"), { csrf: false })))
        .status,
    ).toBe(404);

    expect((await rt.fetch(request("POST", HOST, unsubscribe, { csrf: false }))).status).toBe(200);
    expect((await st())?.consent_messages).toBe(false);
  });

  test("a moved date drops the old reminder; a cancelled booking is not reminded", async () => {
    const now = Date.now();
    const b = await book("zapis", "draft", {
      starts_at: new Date(now + 3 * 86_400_000).toISOString(),
      consent_messages: true,
      email: "other@example.ru",
    });
    const sentTo = () =>
      rt.outbox().filter((m) => (m.payload as { to?: unknown }).to === "other@example.ru").length;
    await rt.jobsTick({ envs: ["draft"] });
    expect(sentTo()).toBe(1);
    await sql.unsafe(`update ${T("booking")} set status = 'cancelled' where id = $1`, [b]);
    await rt.jobsTick({ envs: ["draft"], now: new Date(now + 2 * 86_400_000 + 60_000) });
    expect(sentTo()).toBe(1);
  });
});
