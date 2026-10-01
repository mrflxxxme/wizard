// FU-6: live connectors in the job runner (notify steps go through @wizard/connectors runNotifyStep against the Bot
// API stub) and own-bot management at publication (publishTelegramBots: getMe + setWebhook, outbox mode records).
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSpec, dropSystemRoleDDL, quoteIdent } from "@wizard/appspec";
import { derivedToken, staticSecretReader } from "@wizard/connectors";
import { TelegramMock } from "@wizard/connectors/mocks";
import { testPlatform } from "@wizard/connectors/testing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createRuntimeApp,
  isReservedSystemSlug,
  type LoadedSystem,
  MemoryRegistry,
  migrateSystem,
  type OutboxMessage,
  publishTelegramBots,
  type RuntimeApp,
  SYSTEM_SUBJECT,
  schemaName,
} from "../src/index.js";
import { DB_URL, devEnv, forumSpec, newKey, seedUser } from "./helpers.js";

const PLATFORM_TOKEN = "700000011:PLATFORMtokenPLATFORMtokenPLATFORMtok";
const OWN_TOKEN = "700000012:OWNtokenOWNtokenOWNtokenOWNtokenOWNto";

let sql: postgres.Sql;
let role: string;
let rt: RuntimeApp;
let mock: TelegramMock;
let platform: ReturnType<typeof testPlatform>;
const schemas: string[] = [];
const outboxDir = mkdtempSync(join(tmpdir(), "wz-rt-tglive-"));

/** Forum on the shared bot; speaker_approved keeps only its Telegram step (email prod would dial SMTP). */
function sharedBotForum(): AppSpec {
  const spec = forumSpec();
  const tg = spec.integrations?.find((i) => i.name === "telegram");
  if (tg) {
    tg.config = {};
    tg.secretRefs = [];
  }
  const wf = spec.workflows?.find((w) => w.name === "speaker_approved");
  if (wf) wf.steps = wf.steps.filter((s) => s.params?.integration === "telegram");
  return spec;
}

beforeAll(async () => {
  sql = postgres(DB_URL, { max: 6, onnotice: () => {} });
  role = `wz_rt_tgl_${randomBytes(4).toString("hex")}`;
  await sql.unsafe(`CREATE ROLE ${quoteIdent(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  mock = await new TelegramMock().start();
  platform = testPlatform({
    secrets: staticSecretReader({ telegram_bot_token: PLATFORM_TOKEN }),
    telegram: { apiBase: mock.url, botUsername: "wizard_notify_bot" },
  });
  rt = createRuntimeApp({
    db: sql,
    registry: new MemoryRegistry(),
    dbRole: role,
    env: devEnv,
    connectors: "live",
    platform,
    outboxDir,
    secrets: () => staticSecretReader({ telegram_bot_token: OWN_TOKEN }),
  });
});

afterAll(async () => {
  for (const s of schemas) await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(s)} CASCADE`);
  for (const s of schemas) for (const st of dropSystemRoleDDL(s)) await sql.unsafe(st);
  await sql.unsafe(`DROP OWNED BY ${quoteIdent(role)}`).catch(() => {});
  await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
  await sql.end();
  await mock.stop();
  rmSync(outboxDir, { recursive: true, force: true });
});

describe("job runner with connectors: 'live'", () => {
  test("notify step → runNotifyStep → Bot API sendMessage once; the same job is not resent", async () => {
    const key = newKey();
    schemas.push(schemaName(key, "prod"));
    const spec = sharedBotForum();
    await migrateSystem(sql, { systemId: key, env: "prod", spec, runtimeRole: role });
    await rt.loadSystem({ systemKey: key, env: "prod", spec, slug: "tglivejobs" });
    const sys = (await rt.systems.resolve("tglivejobs", "prod")) as LoadedSystem;
    const schema = schemaName(key, "prod");
    const speaker = await seedUser(sql, schema, "speaker");
    await sql.unsafe(`update ${quoteIdent(schema)}."users" set telegram_chat_id = 31337 where id = $1`, [
      speaker,
    ]);
    const app = await sys.data.create(SYSTEM_SUBJECT, "speaker_application", {
      speaker_user: speaker,
      full_name: "Спикер Живой",
      email: "user1@example.test",
      topic: "Тема",
      abstract: "Кейс",
    });
    const now = new Date();
    expect((await rt.runJobs({ slug: "tglivejobs", env: "prod", now })).failed).toEqual([]);
    mock.calls.length = 0;
    await sys.data.update(SYSTEM_SUBJECT, "speaker_application", String(app.id), { status: "approved" });
    const r = await rt.runJobs({ slug: "tglivejobs", env: "prod", now });
    expect(r.failed).toEqual([]);
    expect(r.ran).toBe(1);
    const sent = mock.calls.filter((c) => c.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ token: PLATFORM_TOKEN, body: { chat_id: "31337" } });
    expect(String(sent[0]?.body.text)).toContain("Ваша заявка спикера одобрена");
    expect(String(sent[0]?.body.text)).not.toContain("Спикер Живой");
    expect(rt.outbox().filter((m) => m.userId === speaker)).toEqual([]); // not the outbox facade

    expect((await rt.runJobs({ slug: "tglivejobs", env: "prod", now })).ran).toBe(0);
    expect(mock.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });
});

describe("publishTelegramBots", () => {
  const sys = (spec: AppSpec) => ({ systemKey: "tgpub0000001", slug: "tgpub", revision: 3, spec });
  const opts = () => ({
    env: devEnv,
    platform,
    secrets: () => staticSecretReader({ telegram_bot_token: OWN_TOKEN }),
  });

  test("live, own bot: getMe then setWebhook to the prod host with the derived secret", async () => {
    mock.calls.length = 0;
    const res = await publishTelegramBots({ ...opts(), mode: "live" }, sys(forumSpec()));
    expect(res).toEqual([{ integration: "telegram", username: "own_test_bot", status: "webhook_set" }]);
    expect(mock.calls.map((c) => [c.method, c.token])).toEqual([
      ["getMe", OWN_TOKEN],
      ["setWebhook", OWN_TOKEN],
    ]);
    const body = mock.calls[1]?.body as { url: string; secret_token: string; allowed_updates: string[] };
    expect(body.url).toMatch(
      /^http:\/\/tgpub\.localhost\/_wizard\/hooks\/telegram\/telegram\/[A-Za-z0-9_-]{32}$/,
    );
    expect(body.secret_token).toBe(derivedToken(OWN_TOKEN, "telegram-webhook-secret"));
    expect(body.allowed_updates).toEqual(["message", "my_chat_member"]);
  });

  test("live, invalid token → ConnectorError, no setWebhook", async () => {
    mock.calls.length = 0;
    mock.queue.push({ status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } });
    await expect(publishTelegramBots({ ...opts(), mode: "live" }, sys(forumSpec()))).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(mock.calls.map((c) => c.method)).toEqual(["getMe"]);
  });

  test("outbox mode records the calls without the Bot API; the shared bot needs nothing", async () => {
    mock.calls.length = 0;
    const outbox: OutboxMessage[] = [];
    const res = await publishTelegramBots({ ...opts(), mode: "outbox", outbox, outboxDir }, sys(forumSpec()));
    expect(res).toEqual([
      { integration: "telegram", username: "north_retail_forum_bot", status: "recorded" },
    ]);
    expect(outbox.map((m) => m.action)).toEqual(["getMe", "setWebhook"]);
    const lines = readFileSync(join(outboxDir, "tgpub0000001", "telegram.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain(OWN_TOKEN);
    expect(mock.calls).toEqual([]);
    expect(await publishTelegramBots({ ...opts(), mode: "live" }, sys(sharedBotForum()))).toEqual([]);
    expect(mock.calls).toEqual([]);
  });

  test("reserved slugs are exported for platform-api", () => {
    expect(isReservedSystemSlug("mail")).toBe(true);
    expect(isReservedSystemSlug("forum")).toBe(false);
  });
});
