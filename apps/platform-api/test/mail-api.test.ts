// Platform mail over the Unisender Go HTTP API (email.yaml#transport; the pilot's server has the mail ports closed):
// transport and API base from WIZARD_SMTP_HOST / WIZARD_MAIL_TRANSPORT / WIZARD_MAIL_API_BASE, startup checks, the
// email/send.json request of ApiMailer (subject, text + HTML, sender name, X-Wizard-Kind, X-API-KEY), 4xx final,
// 429/5xx retried once, no key in errors.
import { describe, expect, test } from "vitest";
import type { MailMessage } from "../src/auth/mailer.js";
import { ApiMailer, platformMailer, SmtpMailer } from "../src/auth/smtp-mailer.js";
import { assertStartupAllowed, loadConfig } from "../src/config.js";

const KEY = "unisender-key-PLATFORM-41d0";
const env = {
  WIZARD_SMTP_HOST: "smtp.go1.unisender.ru",
  WIZARD_SMTP_USER: "7654321",
  WIZARD_SMTP_PASSWORD: KEY,
  WIZARD_SMTP_FROM: "Команда Wizard <noreply@wizard.example>",
};
const otp: MailMessage = {
  kind: "otp",
  to: "anna@coffee.example",
  subject: "Код входа: 123456",
  text: "Ваш код: 123456\nОн действует 10 минут.",
};

type Answer = { status: number; body: unknown };
function fakeFetch(answers: Answer[]) {
  const calls: {
    url: string;
    headers: Record<string, string>;
    body: { message: Record<string, unknown> & { body: Record<string, string>; subject: string } };
  }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)] as Answer;
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  return { f, calls };
}
const ok: Answer = { status: 200, body: { status: "success", job_id: "job-1", emails: [otp.to] } };
const fail = (status: number, code: number): Answer => ({
  status,
  body: { status: "error", message: "error", code },
});

describe("platform mail transport", () => {
  test("config: unisender-api for *.unisender.ru (goN base), smtp otherwise, explicit override", () => {
    expect(loadConfig(env).smtp).toMatchObject({
      transport: "unisender-api",
      apiBase: "https://go1.unisender.ru",
      password: KEY,
      from: { address: "noreply@wizard.example", name: "Команда Wizard" },
    });
    expect(loadConfig({ ...env, WIZARD_SMTP_HOST: "smtp.go2.unisender.ru" }).smtp?.apiBase).toBe(
      "https://go2.unisender.ru",
    );
    expect(loadConfig({ ...env, WIZARD_MAIL_API_BASE: "https://goapi.unisender.ru/" }).smtp?.apiBase).toBe(
      "https://goapi.unisender.ru",
    );
    const smtp = loadConfig({ ...env, WIZARD_MAIL_TRANSPORT: "smtp" }).smtp;
    expect(smtp?.transport).toBe("smtp");
    expect(smtp).not.toHaveProperty("apiBase");
    expect(loadConfig({ ...env, WIZARD_SMTP_HOST: "smtp.mail.example" }).smtp?.transport).toBe("smtp");
    expect(platformMailer(loadConfig(env))).toBeInstanceOf(ApiMailer);
    expect(platformMailer(loadConfig({ ...env, WIZARD_MAIL_TRANSPORT: "smtp" }))).toBeInstanceOf(SmtpMailer);
  });

  test("startup: unknown transport, API without a key, plain-http API base in production are refused", () => {
    expect(() => assertStartupAllowed(loadConfig({ ...env, WIZARD_MAIL_TRANSPORT: "http" }))).toThrow(
      /WIZARD_MAIL_TRANSPORT/,
    );
    expect(() => assertStartupAllowed(loadConfig({ ...env, WIZARD_SMTP_PASSWORD: "" }))).toThrow(
      /WIZARD_SMTP_PASSWORD/,
    );
    const prod = { NODE_ENV: "production", WIZARD_SECRETS_KEY: "k".repeat(40) };
    expect(() =>
      assertStartupAllowed(loadConfig({ ...env, ...prod, WIZARD_MAIL_API_BASE: "http://127.0.0.1:9" })),
    ).toThrow(/WIZARD_MAIL_API_BASE/);
    expect(() =>
      assertStartupAllowed(loadConfig({ ...env, WIZARD_MAIL_API_BASE: "http://127.0.0.1:9" })),
    ).not.toThrow();
  });
});

describe("ApiMailer", () => {
  const mailer = (f: typeof fetch) => platformMailer(loadConfig(env), { fetch: f, retryDelayMs: 0 });

  test("one POST email/send.json: X-API-KEY, subject, text and its HTML twin, sender with name, X-Wizard-Kind", async () => {
    const { f, calls } = fakeFetch([ok]);
    await mailer(f).send(otp);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c?.url).toBe("https://go1.unisender.ru/ru/transactional/api/v1/email/send.json");
    expect(c?.headers["x-api-key"]).toBe(KEY);
    const m = c?.body.message ?? { body: {}, subject: "" };
    expect(m).toMatchObject({
      recipients: [{ email: otp.to }],
      subject: otp.subject,
      from_email: "noreply@wizard.example",
      from_name: "Команда Wizard",
      headers: { "X-Wizard-Kind": "otp" },
      template_engine: "none",
    });
    expect(m.body.plaintext).toBe(otp.text);
    expect(m.body.html).toContain("Ваш код: 123456<br>Он действует 10 минут.");
    expect(m.body.html).not.toMatch(/<img|https?:\/\//);
    for (const k of ["track_links", "track_read", "skip_unsubscribe"]) expect(m).not.toHaveProperty(k);
    expect(JSON.stringify(c?.body)).not.toContain(KEY);
  });

  test("subject loses CR/LF; an invalid recipient never reaches the API", async () => {
    const { f, calls } = fakeFetch([ok]);
    await mailer(f).send({ ...otp, subject: "Тема\r\nBcc: x@y.ru" });
    expect(calls[0]?.body.message.subject).toBe("ТемаBcc: x@y.ru");
    await expect(mailer(f).send({ ...otp, to: "not an address" })).rejects.toThrow(/recipient/);
    expect(calls).toHaveLength(1);
  });

  test("4xx is final; 429 and 5xx are retried once", async () => {
    const auth = fakeFetch([fail(401, 102), ok]);
    const e = (await mailer(auth.f)
      .send(otp)
      .catch((x: unknown) => x)) as Error & { code: number };
    expect(e).toMatchObject({ name: "MailApiError", code: 535, httpStatus: 401 });
    expect(auth.calls).toHaveLength(1);
    expect(`${e.message} ${e.stack} ${JSON.stringify(e)}`).not.toContain(KEY);

    const limited = fakeFetch([fail(429, 0), ok]);
    await mailer(limited.f).send(otp);
    expect(limited.calls).toHaveLength(2);

    const down = fakeFetch([fail(500, 150), fail(503, 150), ok]);
    await expect(mailer(down.f).send(otp)).rejects.toMatchObject({ code: 451, httpStatus: 503 });
    expect(down.calls).toHaveLength(2);
  });
});
