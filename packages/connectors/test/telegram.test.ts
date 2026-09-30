// M1-06 Telegram: G2-TG-01 in validateSpec, shared platform bot by default, deep links, webhooks, 403 → unlink,
// retries and limits, no token in logs — against a local Bot API stub (telegram.yaml#acceptance).
import type { AppSpec } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createTelegramLink,
  handlePlatformUpdate,
  handleTelegramUpdate,
  invokeAction,
  LINKED_TEXT,
  maskTelegramToken,
  parseTelegramUpdate,
  platformLinkTarget,
  runNotifyStep,
  secretMatches,
  staticSecretReader,
  telegramConnector,
  telegramGetMe,
  telegramHookToken,
  telegramSetWebhook,
  telegramWebhookSecret,
  validateIntegrations,
} from "../src/index.js";
import {
  createTestCtx,
  MemoryStore,
  MemorySystemDb,
  MemoryTelegramLinks,
  type TestCtxOptions,
  testPlatform,
} from "../src/testing.js";
import { type Json, loadSpec } from "./helpers.js";
import { TelegramMock } from "./mocks/index.js";

const PLATFORM_TOKEN = "700000001:PLATFORMtokenPLATFORMtokenPLATFORMtok";
const OWN_TOKEN = "700000002:OWNtokenOWNtokenOWNtokenOWNtokenOWNto";
const SYSTEM_ID = "abcdefabcdef";
const noSleep = async () => {};

let mock: TelegramMock;
beforeAll(async () => {
  mock = await new TelegramMock().start();
});
afterAll(async () => {
  await mock.stop();
});

/** Forum with the shared platform bot (no settings) and a notify step with `text`. */
function platformSpec(text = "Ваша заявка одобрена. Подробности — в личном кабинете."): AppSpec {
  const spec = structuredClone(loadSpec("forum")) as Json;
  const tg = spec.integrations.find((i: Json) => i.name === "telegram");
  tg.config = {};
  tg.secretRefs = [];
  for (const r of spec.roles)
    if (r.loginMethods) r.loginMethods = r.loginMethods.filter((m: string) => m !== "telegram");
  spec.workflows.push({
    name: "ticket_tg",
    trigger: { type: "on_status", entity: "ticket", field: "status", equals: "paid" },
    steps: [{ type: "notify", params: { integration: "telegram", to: "$record.holder_user", text } }],
  });
  return spec;
}

const platform = (o: { token?: boolean } = {}) =>
  testPlatform({
    secrets: staticSecretReader(
      o.token === false
        ? {}
        : { telegram_bot_token: PLATFORM_TOKEN, telegram_webhook_secret: "platform-hook-secret" },
    ),
    telegram: { apiBase: mock.url, botUsername: "wizard_notify_bot" },
  });

function liveCtx(spec: AppSpec, extra: Partial<TestCtxOptions> = {}) {
  return createTestCtx({
    spec,
    integration: "telegram",
    systemId: SYSTEM_ID,
    env: "prod",
    host: "forum.systems.test",
    platform: platform(),
    fetch,
    contacts: { u1: { telegram_chat: "100500" } },
    ...extra,
  });
}

const issuesOf = (spec: AppSpec) =>
  validateIntegrations(spec).filter((i) => i.rule.startsWith("G2-TG") || i.rule.startsWith("telegram."));

describe("G0: Telegram templates without PII (G2-TG-01)", () => {
  test("«Здравствуйте, {{holder_name}}» (pii=basic) blocks; a template without PII passes", () => {
    const bad = issuesOf(platformSpec("Здравствуйте, {{holder_name}}"));
    expect(bad).toEqual([
      expect.objectContaining({
        rule: "G2-TG-01",
        code: "CONFIG_INVALID",
        path: expect.stringMatching(/\/params\/text$/),
      }),
    ]);
    expect(issuesOf(platformSpec("Билет {{ticket_type.name}} оплачен, поток {{stream.name}}"))).toEqual([]);
    expect(issuesOf(platformSpec())).toEqual([]);
  });

  test("ref to users, literal PII, unknown field and a non-user recipient are reported", () => {
    expect(issuesOf(platformSpec("Привет, {{holder_user.display_name}}")).map((i) => i.rule)).toEqual([
      "G2-TG-01",
    ]);
    expect(issuesOf(platformSpec("Звоните +7 912 345-67-89")).map((i) => i.rule)).toEqual(["G2-TG-01"]);
    expect(issuesOf(platformSpec("Статус: {{nope}}")).map((i) => i.rule)).toEqual([
      "telegram.template_field",
    ]);
    const spec = platformSpec() as Json;
    spec.workflows.at(-1).steps[0].params.to = "$record.stream";
    expect(issuesOf(spec).map((i: Json) => i.rule)).toEqual(["telegram.notify_recipient"]);
  });

  test("golden specs stay valid; loginEnabled with the shared bot → CONFIG_INVALID", () => {
    expect(validateIntegrations(loadSpec("forum"))).toEqual([]);
    expect(validateIntegrations(loadSpec("bakery"))).toEqual([]);
    const spec = platformSpec() as Json;
    spec.integrations.find((i: Json) => i.name === "telegram").config = { loginEnabled: true };
    expect(issuesOf(spec).map((i: Json) => i.rule)).toEqual(["telegram.login_needs_own_bot"]);
  });
});

describe("sendToUser via the shared platform bot", () => {
  test("draft: outbox with «<app.name>: »; prod: Bot API with the platform token, not a system secret", async () => {
    const spec = platformSpec();
    const draft = createTestCtx({ spec, integration: "telegram", contacts: { u1: { telegram_chat: "1" } } });
    expect(
      await invokeAction(telegramConnector, "sendToUser", draft, { userId: "u1", text: "Скоро начало" }),
    ).toEqual({
      delivered: true,
      reason: "test_mode",
    });
    expect(draft.outbox.messages[0]?.payload.text).toBe(`${spec.app.name}: Скоро начало`);

    mock.calls.length = 0;
    const ctx = liveCtx(spec, { secrets: {} });
    const out = await invokeAction(telegramConnector, "sendToUser", ctx, {
      userId: "u1",
      text: "Скоро начало",
      buttons: [{ text: "Билет", url: "/ticket/1" }],
    });
    expect(out).toEqual({ delivered: true });
    const [call] = mock.calls;
    expect(call).toMatchObject({ token: PLATFORM_TOKEN, method: "sendMessage" });
    expect(call?.body).toMatchObject({
      chat_id: "100500",
      text: `${spec.app.name}: Скоро начало`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "Билет", url: "https://forum.systems.test/ticket/1" }]] },
    });
  });

  test("no platform token → SECRET_MISSING; own bot uses the system secret and no prefix", async () => {
    const noToken = createTestCtx({
      spec: platformSpec(),
      integration: "telegram",
      env: "prod",
      platform: platform({ token: false }),
      fetch,
      contacts: { u1: { telegram_chat: "1" } },
    });
    await expect(
      invokeAction(telegramConnector, "sendToUser", noToken, { userId: "u1", text: "x" }),
    ).rejects.toMatchObject({
      code: "SECRET_MISSING",
    });
    mock.calls.length = 0;
    const own = liveCtx(loadSpec("forum"), { secrets: { telegram_bot_token: OWN_TOKEN } });
    await invokeAction(telegramConnector, "sendToUser", own, { userId: "u1", text: "Готово" });
    expect(mock.calls[0]).toMatchObject({ token: OWN_TOKEN, body: { text: "Готово" } });
  });

  test("403 blocked → telegram_chat_id cleared, next sendToUser → not_linked", async () => {
    const ctx = liveCtx(platformSpec());
    mock.queue.push(TelegramMock.blocked());
    expect(
      await invokeAction(telegramConnector, "sendToUser", ctx, { userId: "u1", text: "Привет" }),
    ).toEqual({
      delivered: false,
      reason: "blocked",
    });
    expect(await ctx.users.contact("u1", "telegram_chat")).toBeNull();
    expect(
      await invokeAction(
        telegramConnector,
        "sendToUser",
        { ...ctx, idempotencyKey: "k2" },
        { userId: "u1", text: "Привет" },
      ),
    ).toEqual({ delivered: false, reason: "not_linked" });
  });

  test("502, 502, 200 → success with 3 requests; 429 waits retry_after", async () => {
    const ctx = liveCtx(platformSpec());
    mock.calls.length = 0;
    mock.queue.push(TelegramMock.unavailable(), TelegramMock.unavailable());
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    await invokeAction(
      telegramConnector,
      "sendToUser",
      ctx,
      { userId: "u1", text: "Привет" },
      { sleep, random: () => 0.5 },
    );
    expect(mock.calls).toHaveLength(3);
    expect(waits).toEqual([1000, 4000]);
    mock.queue.push(TelegramMock.tooMany(7));
    waits.length = 0;
    await invokeAction(
      telegramConnector,
      "sendToUser",
      { ...ctx, idempotencyKey: "k429" },
      { userId: "u1", text: "Ещё" },
      { sleep },
    );
    expect(waits).toEqual([7000]);
    const logs = JSON.stringify(ctx.logs);
    expect(logs).toContain('"status":"retry"');
    expect(logs).toContain('"providerStatus":502');
  });

  test("logs, errors and outputs carry neither the token nor /bot<token>/", async () => {
    const ctx = liveCtx(platformSpec());
    mock.queue.push({
      status: 401,
      body: { ok: false, error_code: 401, description: `Unauthorized /bot${PLATFORM_TOKEN}/` },
    });
    const err = await invokeAction(telegramConnector, "sendToUser", ctx, {
      userId: "u1",
      text: "Привет",
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "AUTH_FAILED" });
    const dead = liveCtx(platformSpec(), {
      platform: testPlatform({
        secrets: staticSecretReader({ telegram_bot_token: PLATFORM_TOKEN }),
        telegram: { apiBase: "http://127.0.0.1:9", botUsername: "x_bot" },
      }),
    });
    const netErr = await invokeAction(
      telegramConnector,
      "sendToUser",
      dead,
      { userId: "u1", text: "x" },
      { sleep: noSleep },
    ).catch((e: unknown) => e);
    expect(netErr).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    const everything = JSON.stringify([
      ctx.logs,
      dead.logs,
      String(err),
      String(netErr),
      (netErr as Error).stack,
    ]);
    expect(everything).not.toContain(PLATFORM_TOKEN);
    expect(everything).not.toMatch(/\/bot\d+:/);
    expect(maskTelegramToken(`GET /bot${PLATFORM_TOKEN}/sendMessage`)).toBe("GET /bot***/sendMessage");
  });

  test("Free: ≤ 60 a minute per system → RATE_LIMITED; ≤ 500 a day", async () => {
    const ok = (async () => Response.json({ ok: true, result: {} })) as typeof fetch;
    const store = new MemoryStore(() => new Date("2026-10-01T10:00:30Z"));
    const ctx = liveCtx(platformSpec(), { fetch: ok, store, now: () => new Date("2026-10-01T10:00:30Z") });
    for (let i = 0; i < 60; i++) {
      await invokeAction(
        telegramConnector,
        "sendToUser",
        { ...ctx, idempotencyKey: `m${i}` },
        { userId: "u1", text: "x" },
      );
    }
    await expect(
      invokeAction(
        telegramConnector,
        "sendToUser",
        { ...ctx, idempotencyKey: "m60" },
        { userId: "u1", text: "x" },
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const day = Math.floor(new Date("2026-10-01T11:00:00Z").getTime() / 86_400_000);
    await store.set(`quota:telegram_platform_day:${day}`, 500);
    const later = { ...ctx, now: () => new Date("2026-10-01T11:00:00Z"), idempotencyKey: "d1" };
    await expect(
      invokeAction(telegramConnector, "sendToUser", later, { userId: "u1", text: "x" }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    const paid = { ...later, system: { ...later.system, plan: "paid" as const }, idempotencyKey: "d2" };
    expect(await invokeAction(telegramConnector, "sendToUser", paid, { userId: "u1", text: "x" })).toEqual({
      delivered: true,
    });
  });
});

describe("deep link and webhooks", () => {
  test("shared bot: /start with a valid token links the chat once; the token routes to the system", async () => {
    const links = new MemoryTelegramLinks();
    const ctx = liveCtx(platformSpec(), { contacts: {}, telegramLinks: links, env: "draft" });
    const { url } = await createTelegramLink(ctx, "u7");
    const token = /^https:\/\/t\.me\/wizard_notify_bot\?start=([A-Za-z0-9_-]{32})$/.exec(url)?.[1] as string;
    expect(token).toBeDefined();
    expect(platformLinkTarget(token)).toEqual({ systemId: SYSTEM_ID, env: "draft" });
    expect([...links.links.keys()][0]).not.toContain(token);
    const seen = new Set<number>();
    const deps = {
      locate: async () => ctx,
      clearEverywhere: async () => {},
      seen: (id: number) => {
        if (seen.has(id)) return true;
        seen.add(id);
        return false;
      },
    };
    const start = (id: number) =>
      parseTelegramUpdate({
        update_id: id,
        message: { chat: { id: 555, type: "private" }, text: `/start ${token}` },
      });
    const first = await handlePlatformUpdate(start(1) as never, deps);
    expect(first.reply).toEqual({ method: "sendMessage", chat_id: "555", text: LINKED_TEXT });
    expect(await ctx.users.contact("u7", "telegram_chat")).toBe("555");
    await ctx.users.setTelegramChat("u7", null);
    const again = await handlePlatformUpdate(start(2) as never, deps);
    expect(again.reply?.text).not.toBe(LINKED_TEXT);
    expect(await ctx.users.contact("u7", "telegram_chat")).toBeNull();
    expect(await handlePlatformUpdate(start(1) as never, deps)).toEqual({ reply: null });
  });

  test("expired token does not link; kicked clears everywhere; other messages get the auto-answer", async () => {
    let now = new Date("2026-10-01T10:00:00Z");
    const ctx = liveCtx(platformSpec(), { contacts: {}, now: () => now });
    const { url } = await createTelegramLink(ctx, "u8");
    const token = url.split("start=")[1] as string;
    now = new Date("2026-10-02T10:00:01Z");
    const r = await handleTelegramUpdate(ctx, { updateId: 10, kind: "start", chatId: "9", token });
    expect(r.reply?.text).toMatch(/устарела/);
    await ctx.users.setTelegramChat("u8", "9");
    const cleared: string[] = [];
    await handlePlatformUpdate(
      parseTelegramUpdate({
        update_id: 11,
        my_chat_member: { chat: { id: 9 }, new_chat_member: { status: "kicked" } },
      }) as never,
      { locate: async () => null, clearEverywhere: async (c) => void cleared.push(c), seen: () => false },
    );
    expect(cleared).toEqual(["9"]);
    const own = await handleTelegramUpdate(liveCtx(loadSpec("forum")), {
      updateId: 12,
      kind: "other",
      chatId: "9",
    });
    expect(own.reply?.text).toBe(`Этот бот отправляет уведомления системы ${loadSpec("forum").app.name}`);
  });

  test("own bot: kicked clears the chat; update_id is processed once", async () => {
    const ctx = liveCtx(loadSpec("forum"), { contacts: { u1: { telegram_chat: "77" } } });
    const kicked = { updateId: 20, kind: "kicked" as const, chatId: "77" };
    await handleTelegramUpdate(ctx, kicked);
    expect(await ctx.users.contact("u1", "telegram_chat")).toBeNull();
    await ctx.users.setTelegramChat("u1", "77");
    await handleTelegramUpdate(ctx, kicked);
    expect(await ctx.users.contact("u1", "telegram_chat")).toBe("77");
  });

  test("secret check is exact; own-bot webhook secret derives from the bot token when not set", async () => {
    expect(secretMatches("abc", "abc")).toBe(true);
    expect(secretMatches("abd", "abc")).toBe(false);
    expect(secretMatches(null, "abc")).toBe(false);
    expect(secretMatches("abcd", "abc")).toBe(false);
    const ctx = liveCtx(loadSpec("forum"), { secrets: { telegram_bot_token: OWN_TOKEN } });
    const secret = await telegramWebhookSecret(ctx);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(secret).not.toContain(OWN_TOKEN.slice(0, 10));
    const set = liveCtx(loadSpec("forum"), {
      secrets: { telegram_bot_token: OWN_TOKEN, telegram_webhook_secret: "S".repeat(32) },
    });
    expect(await telegramWebhookSecret(set)).toBe("S".repeat(32));
  });

  test("own bot management: getMe, setWebhook with secret_token and allowed_updates", async () => {
    const ctx = liveCtx(loadSpec("forum"), { secrets: { telegram_bot_token: OWN_TOKEN } });
    mock.calls.length = 0;
    expect(await telegramGetMe(ctx)).toMatchObject({ username: "own_test_bot" });
    await telegramSetWebhook(ctx);
    const hook = mock.calls.find((c) => c.method === "setWebhook");
    expect(hook?.body).toEqual({
      url: `https://forum.systems.test/_wizard/hooks/telegram/telegram/${await telegramHookToken(ctx)}`,
      secret_token: await telegramWebhookSecret(ctx),
      allowed_updates: ["message", "my_chat_member"],
    });
  });
});

describe("notify step", () => {
  test("bakery order_prepaid: {{number}} and {{slot.slot_date}} rendered; the same job/step sends once", async () => {
    const spec = loadSpec("bakery");
    const db = new MemorySystemDb(spec);
    const slot = await db.insert("production_slot", { slot_date: "2026-10-05" });
    const ctx = createTestCtx({
      spec,
      integration: "telegram",
      db,
      contacts: { c1: { telegram_chat: "42" } },
    });
    const wf = (spec.workflows ?? []).find((w) => w.name === "order_prepaid") as Json;
    const step = {
      params: wf.steps[0].params,
      entity: "cake_order",
      record: { id: "o1", number: 17, slot, customer_user: "c1" },
      jobId: "job-1",
      stepIndex: 0,
    };
    await runNotifyStep(ctx, step);
    await runNotifyStep(ctx, step);
    expect(ctx.outbox.messages).toHaveLength(1);
    expect(ctx.outbox.messages[0]?.payload.text).toBe(
      "Заказ №17 принят в работу. Дата готовности: 2026-10-05.",
    );
    expect(ctx.outbox.messages[0]?.idempotencyKey).toBe("job-1:0:sendToUser:0");
  });
});
