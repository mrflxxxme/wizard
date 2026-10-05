// Mail over the Unisender Go HTTP API (email.yaml#transport): transport choice by host, API base, the request body
// and X-API-KEY, the 4xx / 429 / 5xx / network split with one retry, no key in errors or logs, and the email
// connector's platform account sending a ticket with its inline QR through the API.
import type { AppSpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  emailConnector,
  invokeAction,
  MailApiError,
  mailApiFromEnv,
  mailTransportOf,
  platformConfigFromEnv,
  sendPlatformEmail,
  sendUnisenderApi,
  unisenderApiBase,
} from "../src/index.js";
import { createTestCtx, MemorySystemDb, testPlatform } from "../src/testing.js";
import { type Json, loadSpec } from "./helpers.js";

const KEY = "unisender-api-KEY-6c1e9f";
const BASE = "https://go2.unisender.ru";
const SEND_URL = `${BASE}/ru/transactional/api/v1/email/send.json`;
const EMAIL = "ivan.petrov@example.ru";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Json;
}

/** Fake fetch: answers in order (status, body) or throws for "network"; records every request. */
function fakeFetch(answers: ({ status: number; body: unknown } | "network")[]) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a === "network" || a === undefined) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(a.body), {
      status: a.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { f, calls };
}

const ok = { status: 200, body: { status: "success", job_id: "1ZymBc-00041N-9X", emails: [EMAIL] } };
const err = (status: number, code: number) => ({
  status,
  body: { status: "error", message: `bad thing for ${EMAIL}`, code },
});

const letter = {
  from: "noreply@wizard.example",
  fromName: "Команда Wizard",
  to: EMAIL,
  subject: "Код входа: 123456",
  text: "Ваш код: 123456",
  html: "<p>Ваш код: 123456</p>",
};

describe("transport choice and API base", () => {
  test("*.unisender.ru → unisender-api by default; explicit WIZARD_MAIL_TRANSPORT wins; unknown → null", () => {
    expect(mailTransportOf({ WIZARD_SMTP_HOST: "smtp.go1.unisender.ru" })).toBe("unisender-api");
    expect(mailTransportOf({ WIZARD_SMTP_HOST: "SMTP.GO2.UNISENDER.RU." })).toBe("unisender-api");
    expect(mailTransportOf({ WIZARD_SMTP_HOST: "smtp.mail.example" })).toBe("smtp");
    expect(mailTransportOf({ WIZARD_SMTP_HOST: "unisender.ru.evil.example" })).toBe("smtp");
    expect(mailTransportOf({})).toBe("smtp");
    expect(
      mailTransportOf({ WIZARD_SMTP_HOST: "smtp.go1.unisender.ru", WIZARD_MAIL_TRANSPORT: "smtp" }),
    ).toBe("smtp");
    expect(
      mailTransportOf({ WIZARD_SMTP_HOST: "smtp.mail.example", WIZARD_MAIL_TRANSPORT: "unisender-api" }),
    ).toBe("unisender-api");
    expect(mailTransportOf({ WIZARD_MAIL_TRANSPORT: "http" })).toBeNull();
  });

  test("goN from the SMTP host, else goapi; WIZARD_MAIL_API_BASE overrides", () => {
    expect(unisenderApiBase("smtp.go1.unisender.ru")).toBe("https://go1.unisender.ru");
    expect(unisenderApiBase("smtp.go2.unisender.ru")).toBe("https://go2.unisender.ru");
    expect(unisenderApiBase("smtp.unisender.ru")).toBe("https://goapi.unisender.ru");
    expect(unisenderApiBase("smtp.go1.unisender.ru", "http://127.0.0.1:9/")).toBe("http://127.0.0.1:9");
    expect(mailApiFromEnv({ WIZARD_SMTP_HOST: "smtp.go2.unisender.ru" })).toEqual({ base: BASE });
    expect(mailApiFromEnv({ WIZARD_SMTP_HOST: "smtp.mail.example" })).toBeNull();
    expect(mailApiFromEnv({ WIZARD_MAIL_TRANSPORT: "unisender-api" })).toBeNull();
    const cfg = platformConfigFromEnv(
      { WIZARD_SMTP_HOST: "smtp.go2.unisender.ru", WIZARD_SMTP_USER: "123", WIZARD_SMTP_PASSWORD: KEY },
      { systemsDomain: "systems.test", local: false },
    );
    expect(cfg.mailApi).toEqual({ base: BASE });
    expect(cfg.smtp?.host).toBe("smtp.go2.unisender.ru");
  });
});

describe("sendUnisenderApi", () => {
  test("POST email/send.json with X-API-KEY; body without tracking options; key not in the body", async () => {
    const { f, calls } = fakeFetch([ok]);
    const out = await sendUnisenderApi(
      {
        ...letter,
        replyTo: "help@wizard.example",
        headers: { "X-Wizard-Kind": "otp", Bcc: "spy@example.ru" },
        attachments: [{ filename: "a/b.txt", contentType: "text/plain", data: Buffer.from("hi") }],
      },
      { base: `${BASE}/`, apiKey: KEY, fetch: f },
    );
    expect(out).toEqual({ jobId: "1ZymBc-00041N-9X" });
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c?.url).toBe(SEND_URL);
    expect(c?.headers["x-api-key"]).toBe(KEY);
    expect(c?.headers["content-type"]).toBe("application/json");
    expect(c?.body).toEqual({
      message: {
        recipients: [{ email: EMAIL }],
        subject: letter.subject,
        from_email: letter.from,
        from_name: letter.fromName,
        reply_to: "help@wizard.example",
        template_engine: "none",
        body: { plaintext: letter.text, html: letter.html },
        headers: { "X-Wizard-Kind": "otp" },
        attachments: [{ type: "text/plain", name: "a_b.txt", content: Buffer.from("hi").toString("base64") }],
      },
    });
    const m = c?.body.message as Json;
    for (const k of ["track_links", "track_read", "skip_unsubscribe"]) expect(m).not.toHaveProperty(k);
    expect(JSON.stringify(c?.body)).not.toContain(KEY);
  });

  test("400 / 401 are final (one call); 401 → SMTP-equivalent 535, code 204 → 550", async () => {
    const bad = fakeFetch([err(400, 205)]);
    await expect(
      sendUnisenderApi(letter, { base: BASE, apiKey: KEY, fetch: bad.f, retryDelayMs: 0 }),
    ).rejects.toMatchObject({
      name: "MailApiError",
      code: 554,
      httpStatus: 400,
      apiCode: 205,
      transient: false,
    });
    expect(bad.calls).toHaveLength(1);
    const auth = fakeFetch([err(401, 102)]);
    await expect(sendUnisenderApi(letter, { base: BASE, apiKey: KEY, fetch: auth.f })).rejects.toMatchObject({
      code: 535,
    });
    const rcpt = fakeFetch([err(400, 204)]);
    await expect(sendUnisenderApi(letter, { base: BASE, apiKey: KEY, fetch: rcpt.f })).rejects.toMatchObject({
      code: 550,
    });
  });

  test("429, 5xx and network failures are retried once", async () => {
    const limited = fakeFetch([err(429, 0), ok]);
    await expect(
      sendUnisenderApi(letter, { base: BASE, apiKey: KEY, fetch: limited.f, retryDelayMs: 0 }),
    ).resolves.toEqual({ jobId: "1ZymBc-00041N-9X" });
    expect(limited.calls).toHaveLength(2);
    const net = fakeFetch(["network", ok]);
    await sendUnisenderApi(letter, { base: BASE, apiKey: KEY, fetch: net.f, retryDelayMs: 0 });
    expect(net.calls).toHaveLength(2);
    const down = fakeFetch([err(503, 150), err(502, 150), ok]);
    const e = await sendUnisenderApi(letter, {
      base: BASE,
      apiKey: KEY,
      fetch: down.f,
      retryDelayMs: 0,
    }).catch((x: unknown) => x);
    expect(down.calls).toHaveLength(2);
    expect(e).toBeInstanceOf(MailApiError);
    expect(e).toMatchObject({ code: 451, httpStatus: 502, transient: true });
    const gone = fakeFetch(["network"]);
    await expect(
      sendUnisenderApi(letter, { base: BASE, apiKey: KEY, fetch: gone.f, retryDelayMs: 0 }),
    ).rejects.toMatchObject({ code: 0, httpStatus: 0 });
  });

  test("errors carry neither the key nor the provider's message (it may hold the address)", async () => {
    const { f } = fakeFetch([err(401, 102)]);
    const e = (await sendUnisenderApi(letter, { base: BASE, apiKey: KEY, fetch: f }).catch(
      (x: unknown) => x,
    )) as Error;
    const shown = `${e.message} ${e.stack ?? ""} ${JSON.stringify(e)}`;
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain(EMAIL);
  });
});

describe("email connector: platform account over the API", () => {
  function platformForum(): AppSpec {
    const s = structuredClone(loadSpec("forum")) as Json;
    const integ = s.integrations.find((i: Json) => i.name === "email");
    integ.config = { provider: "platform", templates: integ.config.templates };
    integ.secretRefs = [];
    return s;
  }

  test("ticket with its QR inline (cid), sender noreply@<mailDomain>; logs without key or address", async () => {
    const spec = platformForum();
    const db = new MemorySystemDb(spec);
    const ticket = await db.insert("ticket", {
      holder_user: "u1",
      status: "paid",
      qr_token: "WZ1.1.ABCDEFGH.sig",
    });
    const { f, calls } = fakeFetch([ok]);
    const ctx = createTestCtx({
      spec,
      integration: "email",
      env: "prod",
      contacts: { u1: { email: EMAIL } },
      db,
      fetch: f,
      platform: testPlatform({
        smtp: { host: "smtp.go2.unisender.ru", port: 465, tls: "implicit", user: "123" },
        mailApi: { base: BASE },
        secrets: { get: async (n: string) => (n === "smtp_password" ? KEY : Promise.reject(new Error(n))) },
      }),
    });
    const out = (await invokeAction(emailConnector, "sendTemplate", ctx, {
      userId: "u1",
      template: "ticket_issued",
      params: { link: "https://forum.example/ticket/1" },
      attachQrOf: { entity: "ticket", id: ticket },
    })) as { messageId: string };
    expect(out.messageId).toBe("1ZymBc-00041N-9X");
    expect(calls).toHaveLength(1);
    const m = calls[0]?.body.message as Json;
    expect(calls[0]?.url).toBe(SEND_URL);
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
    expect(m.recipients).toEqual([{ email: EMAIL }]);
    expect(m.from_email).toBe("noreply@systems.test");
    expect(m.from_name).toBeTruthy();
    expect(m.subject).toBeTruthy();
    const [qr] = m.inline_attachments as Json[];
    expect(qr.type).toBe("image/png");
    expect(qr.name).toMatch(/^qr-/);
    expect(m.body.html).toContain(`cid:${qr.name}`);
    expect(Buffer.from(qr.content, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(m.body.plaintext).toContain("https://forum.example/ticket/1");
    const logs = JSON.stringify(ctx.logs);
    expect(logs).not.toContain(KEY);
    expect(logs).not.toContain(EMAIL);
  });

  test("401 → AUTH_FAILED, 400 code 204 → RECIPIENT_UNAVAILABLE; sendPlatformEmail goes through the API too", async () => {
    const spec = platformForum();
    const mk = (f: typeof fetch) =>
      createTestCtx({
        spec,
        integration: "email",
        env: "prod",
        contacts: { u1: { email: EMAIL } },
        fetch: f,
        platform: testPlatform({
          smtp: { host: "smtp.go2.unisender.ru", port: 465, tls: "implicit", user: "123" },
          mailApi: { base: BASE },
          secrets: { get: async () => KEY },
        }),
      });
    const input = { userId: "u1", template: "ticket_issued", params: { link: "https://x.example" } };
    await expect(
      invokeAction(emailConnector, "sendTemplate", mk(fakeFetch([err(401, 102)]).f), input),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(
      invokeAction(emailConnector, "sendTemplate", mk(fakeFetch([err(400, 204)]).f), input),
    ).rejects.toMatchObject({ code: "RECIPIENT_UNAVAILABLE" });
    const { f, calls } = fakeFetch([ok]);
    await sendPlatformEmail(mk(f), {
      to: "guest@example.ru",
      subject: "Приглашение",
      text: "Вас пригласили",
      action: "invite",
    });
    expect((calls[0]?.body.message as Json | undefined)?.recipients).toEqual([{ email: "guest@example.ru" }]);
  });
});
