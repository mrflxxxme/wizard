// Test-mode stubs of M1 actions, idempotency, secrets and the PII-free logger (connector-interface.md §2).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  cachedSecretReader,
  createConnectorLogger,
  emailConnector,
  envSecretReader,
  invokeAction,
  JsonlOutbox,
  parseSecretRef,
  SECRET_CACHE_MAX_MS,
  secretEnvVar,
  secretRef,
  telegramConnector,
} from "../src/index.js";
import { createTestCtx, MemorySystemDb } from "../src/testing.js";
import { type Json, loadSpec } from "./helpers.js";

const forum = loadSpec("forum");
const SECRET_VALUE = "test_SECRET_marker_9f3a";
const EMAIL = "ivan.petrov@example.ru";

function platformBotSpec(): AppSpec {
  const spec = structuredClone(forum) as Json;
  const tg = spec.integrations.find((i: Json) => i.name === "telegram");
  tg.config = { loginEnabled: false };
  tg.secretRefs = [];
  return spec;
}

describe("telegram.sendToUser (test mode)", () => {
  const contacts = { u1: { telegram_chat: "100500" } };

  test("platform bot: «<app.name>: » prefix, outbox, HTML escaped", async () => {
    const spec = platformBotSpec();
    const ctx = createTestCtx({ spec, integration: "telegram", contacts });
    const out = await invokeAction(telegramConnector, "sendToUser", ctx, {
      userId: "u1",
      text: "Заявка <b> одобрена & ждём вас",
      buttons: [{ text: "Открыть", url: "/ticket/1" }],
    });
    expect(out).toEqual({ delivered: true, reason: "test_mode" });
    const [msg] = ctx.outbox.messages;
    expect(msg?.payload.text).toBe(`${spec.app.name}: Заявка &lt;b&gt; одобрена &amp; ждём вас`);
    expect(msg?.payload.buttons).toEqual([{ text: "Открыть", url: `https://${ctx.system.host}/ticket/1` }]);
  });

  test("own bot: no prefix", async () => {
    const ctx = createTestCtx({ spec: forum, integration: "telegram", contacts });
    await invokeAction(telegramConnector, "sendToUser", ctx, { userId: "u1", text: "Готово" });
    expect(ctx.outbox.messages[0]?.payload.text).toBe("Готово");
  });

  test("same idempotency key → one message; new key → another", async () => {
    const ctx = createTestCtx({
      spec: forum,
      integration: "telegram",
      contacts,
      idempotencyKey: "run1:0:send:0",
    });
    const input = { userId: "u1", text: "Напоминание о начале" };
    await invokeAction(telegramConnector, "sendToUser", ctx, input);
    await invokeAction(telegramConnector, "sendToUser", ctx, input);
    expect(ctx.outbox.messages).toHaveLength(1);
    await invokeAction(telegramConnector, "sendToUser", { ...ctx, idempotencyKey: "run1:0:send:1" }, input);
    expect(ctx.outbox.messages).toHaveLength(2);
  });

  test("not linked → delivered:false; PII → PII_BLOCKED; foreign button → INVALID_REQUEST", async () => {
    const ctx = createTestCtx({ spec: forum, integration: "telegram", contacts });
    expect(
      await invokeAction(telegramConnector, "sendToUser", ctx, { userId: "u2", text: "Привет" }),
    ).toEqual({
      delivered: false,
      reason: "not_linked",
    });
    await expect(
      invokeAction(
        telegramConnector,
        "sendToUser",
        { ...ctx, idempotencyKey: "k2" },
        {
          userId: "u1",
          text: `Пишите на ${EMAIL}`,
        },
      ),
    ).rejects.toMatchObject({ code: "PII_BLOCKED" });
    await expect(
      invokeAction(
        telegramConnector,
        "sendToUser",
        { ...ctx, idempotencyKey: "k3" },
        {
          userId: "u1",
          text: "Ссылка",
          buttons: [{ text: "x", url: "https://evil.example/" }],
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(ctx.outbox.messages).toHaveLength(0);
  });

  test("prod (live) → EGRESS_DISABLED in M0", async () => {
    const ctx = createTestCtx({ spec: forum, integration: "telegram", contacts, env: "prod" });
    expect(ctx.mode).toBe("live");
    await expect(
      invokeAction(telegramConnector, "sendToUser", ctx, { userId: "u1", text: "Привет" }),
    ).rejects.toMatchObject({ code: "EGRESS_DISABLED" });
  });
});

describe("email.sendTemplate (test mode)", () => {
  test("header injection in subject is neutralised; body HTML-escaped", async () => {
    const spec = structuredClone(forum) as Json;
    spec.integrations.find((i: Json) => i.name === "email").config.templates.t = {
      subject: "Билет {{x}}",
      body: "Привет, {{x}}",
    };
    const ctx = createTestCtx({ spec, integration: "email", contacts: { u1: { email: EMAIL } } });
    const out = (await invokeAction(emailConnector, "sendTemplate", ctx, {
      userId: "u1",
      template: "t",
      params: { x: "x\r\nBcc: a@b.ru <i>" },
    })) as { messageId: string };
    expect(out.messageId).toMatch(/^<.+@.+>$/);
    const msg = ctx.outbox.messages[0]?.payload as Json;
    expect(msg.headers.Subject).toBe("Билет xBcc: a@b.ru <i>");
    expect(msg.headers.Subject).not.toMatch(/[\r\n]/);
    expect(Object.keys(msg.headers)).not.toContain("Bcc");
    expect(msg.headers["Auto-Submitted"]).toBe("auto-generated");
    expect(msg.html).toContain("&lt;i&gt;");
    expect(msg.to).toBe(EMAIL);
  });

  test("no address → RECIPIENT_UNAVAILABLE; unknown template → CONFIG_INVALID", async () => {
    const ctx = createTestCtx({ spec: forum, integration: "email" });
    await expect(
      invokeAction(emailConnector, "sendTemplate", ctx, {
        userId: "u1",
        template: "ticket_issued",
        params: {},
      }),
    ).rejects.toMatchObject({ code: "RECIPIENT_UNAVAILABLE" });
    await expect(
      invokeAction(emailConnector, "sendTemplate", ctx, { userId: "u1", template: "nope", params: {} }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  test("QR attachment only for the record owner", async () => {
    const db = new MemorySystemDb(forum);
    const ctx = createTestCtx({ spec: forum, integration: "email", db, contacts: { u1: { email: EMAIL } } });
    const t = await db.insert("ticket", { holder_user: "u1", status: "paid" });
    const other = await db.insert("ticket", { holder_user: "u2", status: "paid" });
    await invokeAction(emailConnector, "sendTemplate", ctx, {
      userId: "u1",
      template: "ticket_issued",
      params: { link: "/ticket/1" },
      attachQrOf: { entity: "ticket", id: t },
    });
    await expect(
      invokeAction(
        emailConnector,
        "sendTemplate",
        { ...ctx, idempotencyKey: "k2" },
        { userId: "u1", template: "ticket_issued", params: {}, attachQrOf: { entity: "ticket", id: other } },
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  test("logs contain neither the address, the text nor secret values", async () => {
    const ctx = createTestCtx({
      spec: forum,
      integration: "email",
      contacts: { u1: { email: EMAIL } },
      secrets: { smtp_password: SECRET_VALUE },
    });
    await invokeAction(emailConnector, "sendTemplate", ctx, {
      userId: "u1",
      template: "ticket_issued",
      params: { link: SECRET_VALUE },
    });
    await invokeAction(
      emailConnector,
      "sendTemplate",
      { ...ctx, idempotencyKey: "k3" },
      { userId: "u9", template: "ticket_issued", params: {} },
    ).catch(() => {});
    const logs = JSON.stringify(ctx.logs);
    expect(ctx.logs.length).toBeGreaterThanOrEqual(2);
    expect(logs).not.toContain(EMAIL);
    expect(logs).not.toContain(SECRET_VALUE);
    expect(logs).not.toContain("Оплата получена");
  });
});

describe("logger allowlist", () => {
  test("drops non-allowlisted fields and non-scalar values", () => {
    const seen: unknown[] = [];
    const log = createConnectorLogger(
      { system: "s", env: "draft", integration: "tg", connector: "telegram" },
      (e) => seen.push(e),
    );
    log.log({ action: "sendToUser", status: "ok", durationMs: 3, text: EMAIL, to: EMAIL } as never);
    expect(seen[0]).toMatchObject({ system: "s", action: "sendToUser", status: "ok", durationMs: 3 });
    expect(JSON.stringify(seen)).not.toContain(EMAIL);
  });
});

describe("secrets", () => {
  test("secret:// refs", () => {
    expect(secretRef("qr_signing_key")).toBe("secret://qr_signing_key");
    expect(parseSecretRef("secret://yookassa_secret_key")).toBe("yookassa_secret_key");
    expect(parseSecretRef("test_abc")).toBeNull();
    expect(parseSecretRef("secret://Bad-Name")).toBeNull();
  });

  test("M0 .env reader: WIZARD_SECRET_<SYSTEMID>_<NAME>; missing → SECRET_MISSING without the value", async () => {
    expect(secretEnvVar("sys-forum", "qr_signing_key")).toBe("WIZARD_SECRET_SYS_FORUM_QR_SIGNING_KEY");
    const r = envSecretReader("sys-forum", { WIZARD_SECRET_SYS_FORUM_QR_SIGNING_KEY: SECRET_VALUE });
    expect(await r.get("qr_signing_key")).toBe(SECRET_VALUE);
    const err = await r.get("smtp_password").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "SECRET_MISSING", retryable: false });
    expect(String((err as Error).message)).toMatch(/smtp_password/);
  });

  test("cache is capped at 5 minutes", async () => {
    let t = 0;
    let calls = 0;
    const r = cachedSecretReader({ get: async () => `v${++calls}` }, 60 * 60_000, () => t);
    expect(await r.get("a")).toBe("v1");
    t = SECRET_CACHE_MAX_MS - 1;
    expect(await r.get("a")).toBe("v1");
    t = SECRET_CACHE_MAX_MS + 1;
    expect(await r.get("a")).toBe("v2");
  });
});

describe("JsonlOutbox", () => {
  test("appends to <root>/<system>/<connector>.jsonl and rejects unsafe system ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "wz-outbox-"));
    try {
      const box = new JsonlOutbox(root);
      const msg = {
        ts: "t",
        system: "sys_forum",
        env: "draft" as const,
        connector: "telegram" as const,
        integration: "telegram",
        action: "sendToUser",
        idempotencyKey: "k",
        payload: { text: "hi" },
      };
      await box.write(msg);
      await box.write(msg);
      const lines = (await readFile(join(root, "sys_forum", "telegram.jsonl"), "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      await expect(box.write({ ...msg, system: "../etc" })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
