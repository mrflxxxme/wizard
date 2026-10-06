// M1-06 runtime wiring: Telegram deep link + shared/own bot webhooks, live sendToUser against a local Bot API stub
// (403 → unlink, no token in logs), invitations quota with the platform mail, reserved slugs.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSpec, dropSystemRoleDDL, quoteIdent } from "@wizard/appspec";
import {
  invokeAction,
  LINKED_TEXT,
  platformHookToken,
  staticSecretReader,
  telegramConnector,
  telegramHookToken,
} from "@wizard/connectors";
import { TelegramMock } from "@wizard/connectors/mocks";
import { testPlatform } from "@wizard/connectors/testing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { liveConnectors } from "../src/exec/connectors-live.js";
import {
  createRuntimeApp,
  MemoryRegistry,
  migrateSystem,
  type RuntimeApp,
  SystemLoadError,
  schemaName,
} from "../src/index.js";
import { createConnectorHost } from "../src/preview/connectors.js";
import { parseRegistry } from "../src/registry.js";
import { DB_URL, devEnv, forumSpec, login, newKey, request, seedUser, userIdOf } from "./helpers.js";

const PLATFORM_TOKEN = "700000001:PLATFORMtokenPLATFORMtokenPLATFORMtok";
const OWN_TOKEN = "700000002:OWNtokenOWNtokenOWNtokenOWNtokenOWNto";
const PLATFORM_SECRET = "platform_webhook_secret_0123456789";

let sql: postgres.Sql;
let role: string;
let rt: RuntimeApp;
let mock: TelegramMock;
const logs: Record<string, unknown>[] = [];
const schemas: string[] = [];
const outboxDir = mkdtempSync(join(tmpdir(), "wz-rt-outbox-"));
let platform: ReturnType<typeof testPlatform>;

/** Forum with the shared platform bot (no settings). */
function platformForum(): AppSpec {
  const spec = forumSpec();
  const tg = spec.integrations?.find((i) => i.name === "telegram");
  if (tg) {
    tg.config = {};
    tg.secretRefs = [];
  }
  return spec;
}

async function addSystem(slug: string, spec: AppSpec, env: "draft" | "prod" = "draft", key = newKey()) {
  schemas.push(schemaName(key, env));
  await migrateSystem(sql, { systemId: key, env, spec, runtimeRole: role });
  await rt.loadSystem({ systemKey: key, env, spec, slug });
  return { key, schema: schemaName(key, env) };
}

const chatOf = async (schema: string, userId: string) =>
  (
    await sql.unsafe(`select telegram_chat_id::text as c from ${quoteIdent(schema)}."users" where id = $1`, [
      userId,
    ])
  )[0]?.c ?? null;

beforeAll(async () => {
  sql = postgres(DB_URL, { max: 6, onnotice: () => {} });
  role = `wz_rt_tg_${randomBytes(4).toString("hex")}`;
  await sql.unsafe(`CREATE ROLE ${quoteIdent(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  mock = await new TelegramMock().start();
  platform = testPlatform({
    secrets: staticSecretReader({
      telegram_bot_token: PLATFORM_TOKEN,
      telegram_webhook_secret: PLATFORM_SECRET,
    }),
    telegram: { apiBase: mock.url, botUsername: "wizard_notify_bot" },
  });
  rt = createRuntimeApp({
    db: sql,
    registry: new MemoryRegistry(),
    dbRole: role,
    env: devEnv,
    platform,
    outboxDir,
    secrets: () => staticSecretReader({ telegram_bot_token: OWN_TOKEN }),
    log: (l) => logs.push(l),
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

describe("shared bot: deep link and webhook", () => {
  const HOST = "tgshared--draft.localhost:4100";
  let schema: string;
  let hookPath: string;
  const hook = (body: unknown, secret: string | null) =>
    rt.fetch(
      request("POST", "localhost:4100", hookPath, {
        body,
        csrf: false,
        headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {},
      }),
    );

  beforeAll(async () => {
    ({ schema } = await addSystem("tgshared", platformForum()));
    hookPath = `/_wizard/hooks/telegram/_platform/${await platformHookToken(platform)}`;
  });

  test("link needs a session; /start with the right secret links the chat once; kicked unlinks", async () => {
    expect((await rt.fetch(request("POST", HOST, "/api/telegram/telegram/link"))).status).toBe(401);
    const cookie = await login(rt, HOST, "participant");
    const res = await rt.fetch(request("POST", HOST, "/api/telegram/telegram/link", { cookie }));
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const token = /^https:\/\/t\.me\/wizard_notify_bot\?start=([A-Za-z0-9_-]{32})$/.exec(url)?.[1] as string;
    const user = await userIdOf(sql, schema, "participant");
    const start = (id: number) => ({
      update_id: id,
      message: { chat: { id: 4242, type: "private" }, text: `/start ${token}` },
    });

    expect((await hook(start(1), "wrong")).status).toBe(401);
    expect((await hook(start(1), null)).status).toBe(401);
    expect(await chatOf(schema, user)).toBeNull();
    expect(
      (
        await rt.fetch(
          request("POST", "localhost:4100", "/_wizard/hooks/telegram/_platform/nope", {
            body: start(1),
            csrf: false,
          }),
        )
      ).status,
    ).toBe(404);

    const ok = await hook(start(2), PLATFORM_SECRET);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ method: "sendMessage", chat_id: "4242", text: LINKED_TEXT });
    expect(await chatOf(schema, user)).toBe("4242");

    await sql.unsafe(`update ${quoteIdent(schema)}."users" set telegram_chat_id = null where id = $1`, [
      user,
    ]);
    const again = (await (await hook(start(3), PLATFORM_SECRET)).json()) as { text: string };
    expect(again.text).not.toBe(LINKED_TEXT);
    expect(await chatOf(schema, user)).toBeNull();

    await sql.unsafe(`update ${quoteIdent(schema)}."users" set telegram_chat_id = 4242 where id = $1`, [
      user,
    ]);
    const kicked = {
      update_id: 4,
      my_chat_member: { chat: { id: 4242 }, new_chat_member: { status: "kicked" } },
    };
    expect((await hook(kicked, PLATFORM_SECRET)).status).toBe(200);
    expect(await chatOf(schema, user)).toBeNull();

    const text = JSON.stringify(logs);
    expect(text).not.toContain(await platformHookToken(platform));
    expect(text).not.toContain(PLATFORM_SECRET);
  });
});

describe("own bot webhook", () => {
  const HOST = "tgown--draft.localhost:4100";
  test("wrong hookToken → 404, no secret header → 401 (no change), valid → linked", async () => {
    const { schema } = await addSystem("tgown", forumSpec());
    const cookie = await login(rt, HOST, "volunteer");
    const { url } = (await (
      await rt.fetch(request("POST", HOST, "/api/telegram/telegram/link", { cookie }))
    ).json()) as {
      url: string;
    };
    expect(url).toMatch(/^https:\/\/t\.me\/north_retail_forum_bot\?start=/);
    const token = url.split("start=")[1] as string;
    const sys = await rt.systems.resolve("tgown", "draft");
    const host = createConnectorHost({
      env: devEnv,
      clock: () => new Date(),
      outbox: [],
      devSecretsDir: outboxDir,
      platform,
      secrets: () => staticSecretReader({ telegram_bot_token: OWN_TOKEN }),
    });
    const integ = sys?.spec.integrations?.find((i) => i.name === "telegram");
    if (!sys || !integ) throw new Error("no system");
    const hookToken = await telegramHookToken(host.ctx(sys, integ));
    const body = { update_id: 1, message: { chat: { id: 777, type: "private" }, text: `/start ${token}` } };
    const post = (path: string, headers: Record<string, string> = {}) =>
      rt.fetch(request("POST", HOST, path, { body, csrf: false, headers }));
    expect((await post("/_wizard/hooks/telegram/telegram/wrongtoken")).status).toBe(404);
    expect((await post(`/_wizard/hooks/telegram/telegram/${hookToken}`)).status).toBe(401);
    const user = await userIdOf(sql, schema, "volunteer");
    expect(await chatOf(schema, user)).toBeNull();
    const { derivedToken } = await import("@wizard/connectors");
    const secret = derivedToken(OWN_TOKEN, "telegram-webhook-secret");
    const ok = await post(`/_wizard/hooks/telegram/telegram/${hookToken}`, {
      "x-telegram-bot-api-secret-token": secret,
    });
    expect(ok.status).toBe(200);
    expect(await chatOf(schema, user)).toBe("777");
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(hookToken);
    expect(logged).toContain("/_wizard/hooks/telegram/telegram/***");
  });
});

describe("live sendToUser (prod) through the runtime connector host", () => {
  test("shared bot token from the platform; 403 → chat cleared → not_linked; no token in logs", async () => {
    const { schema } = await addSystem("tgprod", platformForum(), "prod");
    const user = await seedUser(sql, schema, "participant");
    await sql.unsafe(`update ${quoteIdent(schema)}."users" set telegram_chat_id = 99 where id = $1`, [user]);
    const hostLogs: Record<string, unknown>[] = [];
    const host = createConnectorHost({
      env: devEnv,
      clock: () => new Date(),
      outbox: [],
      devSecretsDir: outboxDir,
      platform,
      secrets: () => staticSecretReader({}),
      log: (l) => hostLogs.push(l),
    });
    const sys = await rt.systems.resolve("tgprod", "prod");
    const integ = sys?.spec.integrations?.find((i) => i.name === "telegram");
    if (!sys || !integ) throw new Error("no system");
    const ctx = { ...host.ctx(sys, integ), idempotencyKey: "run-1:send:0" };
    expect(ctx.system.host).toBe("http://tgprod.localhost");
    mock.calls.length = 0;
    expect(
      await invokeAction(telegramConnector, "sendToUser", ctx, { userId: user, text: "Скоро начало" }),
    ).toEqual({
      delivered: true,
    });
    expect(mock.calls[0]).toMatchObject({ token: PLATFORM_TOKEN, body: { chat_id: "99" } });
    mock.queue.push(TelegramMock.blocked());
    expect(
      await invokeAction(
        telegramConnector,
        "sendToUser",
        { ...ctx, idempotencyKey: "run-1:send:1" },
        { userId: user, text: "x" },
      ),
    ).toEqual({ delivered: false, reason: "blocked" });
    expect(await chatOf(schema, user)).toBeNull();
    expect(
      await invokeAction(
        telegramConnector,
        "sendToUser",
        { ...ctx, idempotencyKey: "run-1:send:2" },
        { userId: user, text: "x" },
      ),
    ).toEqual({ delivered: false, reason: "not_linked" });
    const text = JSON.stringify([hostLogs, logs]);
    expect(hostLogs.length).toBeGreaterThanOrEqual(3);
    expect(text).not.toContain(PLATFORM_TOKEN);
    expect(text).not.toMatch(/\/bot\d+:/);
  });
});

describe("connectors: 'live' facade of action functions", () => {
  test("draft sendToUser → outbox via @wizard/connectors; repeated explicit key → one message; errors → WizardError", async () => {
    const { schema } = await addSystem("tglive", platformForum());
    const user = await seedUser(sql, schema, "participant");
    await sql.unsafe(`update ${quoteIdent(schema)}."users" set telegram_chat_id = 5 where id = $1`, [user]);
    const outbox: { action: string }[] = [];
    const host = createConnectorHost({
      env: devEnv,
      clock: () => new Date(),
      outbox: outbox as never,
      devSecretsDir: outboxDir,
      platform,
      secrets: () => staticSecretReader({}),
    });
    const sys = await rt.systems.resolve("tglive", "draft");
    if (!sys) throw new Error("no system");
    const tg = liveConnectors(sys, host).telegram as Record<string, (i: unknown) => Promise<unknown>>;
    const input = { userId: user, text: "Напоминание", idempotencyKey: "remind-1" };
    expect(await tg.sendToUser?.(input)).toEqual({ delivered: true, reason: "test_mode" });
    expect(await liveConnectors(sys, host).telegram?.sendToUser?.(input)).toEqual({
      delivered: true,
      reason: "test_mode",
    });
    expect(outbox).toHaveLength(1);
    await expect(tg.sendToUser?.({ userId: user, text: "Пишите на ivan@example.ru" })).rejects.toMatchObject({
      name: "WizardError",
      code: "PII_BLOCKED",
    });
  });
});

describe("invitations (L3-29)", () => {
  const HOST = "invites--draft.localhost:4100";
  test("isAdmin only; Free: 5 a day → 429; duplicate → 409; email invitation in .data/outbox", async () => {
    const { key } = await addSystem("invites", forumSpec());
    const participant = await login(rt, HOST, "participant");
    const invite = (cookie: string, body: unknown) =>
      rt.fetch(request("POST", HOST, "/api/admin/invite", { cookie, body }));
    expect((await invite(participant, { role: "speaker", email: "a@example.ru" })).status).toBe(403);
    const admin = await login(rt, HOST, "organizer");
    expect((await invite(admin, { role: "nope", email: "a@example.ru" })).status).toBe(422);
    expect((await invite(admin, { role: "speaker", email: "not-an-email" })).status).toBe(422);
    const first = await invite(admin, { role: "speaker", email: "speaker1@example.ru" });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ user: { role: "speaker" }, emailSent: true });
    expect((await invite(admin, { role: "speaker", email: "speaker1@example.ru" })).status).toBe(409);
    for (let i = 2; i <= 4; i++) {
      expect((await invite(admin, { role: "volunteer", phone: `+7900000000${i}` })).status).toBe(201);
    }
    const sixth = await invite(admin, { role: "speaker", email: "late@example.ru" });
    expect(sixth.status).toBe(429);
    const files = readdirSync(join(outboxDir, key, "email"));
    expect(files).toHaveLength(1);
    const mails = rt.outbox().filter((m) => m.action === "invite");
    expect(mails).toHaveLength(1);
    expect(JSON.stringify(mails[0]?.payload)).toContain(`${HOST}/login?role=speaker`);
    expect(JSON.stringify(logs)).not.toContain("speaker1@example.ru");
  });

  test("/_wizard/team (B2-16): the admin's form over the invite API, roles closed to self sign-up", async () => {
    const host = "invites-page--draft.localhost:4100";
    await addSystem("invites-page", forumSpec());
    const get = (path: string, cookie?: string) =>
      rt.fetch(request("GET", host, path, cookie ? { cookie } : {}));
    const admin = await login(rt, host, "organizer");
    const page = await get("/_wizard/team", admin);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-testid="wz-team-form"');
    expect(html).toContain('<option value="moderator">');
    expect(html).not.toContain('value="organizer"');
    expect(html).not.toContain('value="participant"');
    expect((await get("/_wizard/team", await login(rt, host, "participant"))).status).toBe(403);
    expect(await (await get("/_wizard/team")).text()).toContain("/login?next=%2F_wizard%2Fteam");
    expect(await (await get("/_wizard/team.js")).text()).toContain('fetch("/api/admin/invite"');
  });
});

describe("reserved slugs (L3-29)", () => {
  test("registry entries and pinned systems with reserved slugs are refused", async () => {
    const entry = {
      systemId: newKey(),
      env: "draft",
      revision: 1,
      specHash: "x",
      bundleKey: "b",
      publishedAt: "",
    };
    expect(
      parseRegistry([
        { ...entry, slug: "mail" },
        { ...entry, slug: "mta-sts" },
        { ...entry, slug: "forum-ok" },
      ]).map((e) => e.slug),
    ).toEqual(["forum-ok"]);
    await expect(
      rt.loadSystem({ systemKey: newKey(), env: "draft", spec: forumSpec(), slug: "autodiscover" }),
    ).rejects.toThrow(SystemLoadError);
  });
});
