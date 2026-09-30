// M1-06 email: subject/body PII rules in validateSpec, header hygiene (CR/LF/NUL, RFC 2047, from.name), SSRF guard
// for the client's SMTP host, live delivery over STARTTLS/implicit TLS to a local SMTP receiver, error mapping,
// retries, limits, the forum ticket with a QR attachment in the draft outbox (email.yaml#acceptance).
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  decodeWords,
  emailConnector,
  encodeWords,
  formatAddress,
  invokeAction,
  JsonlOutbox,
  parseHeaders,
  runNotifyStep,
  sendPlatformEmail,
  staticSecretReader,
  tcpDialer,
  validateIntegrations,
} from "../src/index.js";
import {
  createTestCtx,
  MemoryStore,
  MemorySystemDb,
  type TestCtxOptions,
  testPlatform,
} from "../src/testing.js";
import { type Json, loadSpec } from "./helpers.js";
import { SmtpMock, testCert } from "./mocks/index.js";

const EMAIL = "ivan.petrov@example.ru";
const PASSWORD = "smtp-pass-SECRET-7f1c";
const PUBLIC_IP = "93.184.216.34";
const cert = testCert();
const noSleep = async () => {};

function forumWith(mutate: (spec: Json) => void = () => {}): AppSpec {
  const spec = structuredClone(loadSpec("forum")) as Json;
  mutate(spec);
  return spec;
}

const emailIntegration = (spec: Json) => spec.integrations.find((i: Json) => i.name === "email");
const rules = (spec: AppSpec) => validateIntegrations(spec).map((i) => i.rule);

/** Live context for the forum's own SMTP (smtp.mail.ru:465) with DNS → `ip` and TCP → the mock. */
function liveCtx(mock: SmtpMock | null, o: Partial<TestCtxOptions> & { ip?: string; dials?: string[] } = {}) {
  const { ip = PUBLIC_IP, dials, ...rest } = o;
  return createTestCtx({
    spec: withSmtp(loadSpec("forum"), { host: "smtp.example.test" }),
    integration: "email",
    env: "prod",
    secrets: { smtp_password: PASSWORD },
    contacts: { u1: { email: EMAIL } },
    platform: testPlatform({
      resolve: async () => [ip],
      dial: async (addr) => {
        dials?.push(`${addr.host}:${addr.port}`);
        if (!mock) throw new Error("no server");
        const { Socket } = await import("node:net");
        return await new Promise((resolve, reject) => {
          const s = new Socket();
          s.once("error", reject);
          s.connect(mock.port, "127.0.0.1", () => resolve(s));
        });
      },
      ...(cert ? { tlsCa: cert.cert } : {}),
    }),
    ...rest,
  });
}

function withSmtp(spec: AppSpec, config: Record<string, unknown>): AppSpec {
  const s = structuredClone(spec) as Json;
  Object.assign(emailIntegration(s).config, config);
  return s;
}

describe("G0: email templates", () => {
  test("subject «Билет для {{holder_name}}» blocks publication; the golden forum passes", () => {
    expect(rules(loadSpec("forum"))).toEqual([]);
    const spec = forumWith((s) => {
      emailIntegration(s).config.templates.ticket_issued.subject = "Билет для {{holder_name}}";
    });
    expect(validateIntegrations(spec)).toEqual([
      expect.objectContaining({
        rule: "email.subject_pii",
        path: "/integrations/2/config/templates/ticket_issued/subject",
      }),
    ]);
    const unused = forumWith((s) => {
      emailIntegration(s).config.templates.other = { subject: "Для {{holder_email}}", body: "x" };
    });
    expect(rules(unused)).toEqual(["email.subject_pii"]);
  });

  test("body PII only when the recipient owns the record", () => {
    const toOwner = forumWith((s) => {
      emailIntegration(s).config.templates.ticket_issued.body = "Здравствуйте, {{holder_name}}! {{link}}";
    });
    expect(rules(toOwner)).toEqual([]);
    const speaker = forumWith((s) => {
      emailIntegration(s).config.templates.speaker_approved.body = "Заявка {{full_name}}";
      const wf = s.workflows.find((w: Json) => w.name === "speaker_approved");
      wf.trigger.entity = "ticket";
      wf.steps[0].params.to = "$record.holder_user";
      emailIntegration(s).config.templates.speaker_approved.body = "Заявка {{holder_name}}";
      s.entities.find((e: Json) => e.name === "ticket").ownerField = undefined;
    });
    expect(rules(speaker)).toContain("email.body_pii_recipient");
  });
});

describe("headers", () => {
  test("«x\\r\\nBcc: a@b.ru» in the subject → one Subject field, no Bcc header", async () => {
    const spec = forumWith((s) => {
      emailIntegration(s).config.templates.t = { subject: "Билет {{x}}", body: "Привет, {{x}}" };
    });
    const ctx = createTestCtx({ spec, integration: "email", contacts: { u1: { email: EMAIL } } });
    await invokeAction(emailConnector, "sendTemplate", ctx, {
      userId: "u1",
      template: "t",
      params: { x: "x\r\nBcc: a@b.ru\0 <i>" },
    });
    const payload = ctx.outbox.messages[0]?.payload as Json;
    const headers = parseHeaders(payload.eml);
    expect(headers.filter(([k]) => k.toLowerCase() === "subject")).toHaveLength(1);
    expect(headers.some(([k]) => k.toLowerCase() === "bcc")).toBe(false);
    expect(payload.eml).not.toMatch(/\r\nBcc:/i);
    const subject = headers.find(([k]) => k === "Subject")?.[1] as string;
    expect(subject).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeWords(subject)).toBe("Билет xBcc: a@b.ru <i>");
    expect(payload.html).toContain("&lt;i&gt;");
    for (const [k, v] of headers) expect(`${k}${v}`).not.toMatch(/[\r\n\0]/);
  });

  test("RFC 2047: encoded words ≤ 75 chars, split on code points; long subjects fold", () => {
    const long = "Ваш билет на форум «Северный ритейл» — 😀 ".repeat(4);
    const words = encodeWords(long);
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    expect(decodeWords(words.join(" "))).toBe(long);
    expect(encodeWords("ASCII only")).toEqual(["ASCII only"]);
  });

  test("from.name: ≤ 60 chars, no @ < > or line breaks (platform sender uses app.name)", async () => {
    expect(formatAddress("a@b.ru", 'Evil <x@y.ru>\r\nBcc: z@z.ru "q"')).toBe(
      '"Evil x' + "y.ruBcc: z" + 'z.ru q" <a@b.ru>',
    );
    expect(() => formatAddress("a@b.ru\r\nBcc: x@y.ru")).toThrow();
    const spec = forumWith((s) => {
      s.app.name = `Школа <script>@${"я".repeat(80)}`;
      emailIntegration(s).config = {
        provider: "platform",
        templates: { t: { subject: "Тема", body: "Текст" } },
      };
      emailIntegration(s).secretRefs = [];
    });
    const ctx = createTestCtx({ spec, integration: "email", contacts: { u1: { email: EMAIL } } });
    await invokeAction(emailConnector, "sendTemplate", ctx, { userId: "u1", template: "t", params: {} });
    const from = parseHeaders((ctx.outbox.messages[0] as Json).payload.eml).find(
      ([k]) => k === "From",
    )?.[1] as string;
    const name = decodeWords(from.replace(/\s*<[^>]+>$/, ""));
    expect(from).toMatch(/<noreply@systems\.test>$/);
    expect([...name].length).toBeLessThanOrEqual(60);
    expect(name).not.toMatch(/[@<>]/);
  });
});

describe("client SMTP: SSRF guard", () => {
  test.each(["10.0.0.5", "127.0.0.1", "169.254.169.254", "100.64.1.1", "::1", "fd00::1", "::ffff:10.0.0.5"])(
    "host resolving to %s → CONFIG_INVALID, no connection",
    async (ip) => {
      const dials: string[] = [];
      const ctx = liveCtx(null, { ip, dials });
      await expect(
        invokeAction(emailConnector, "sendTemplate", ctx, {
          userId: "u1",
          template: "ticket_issued",
          params: {},
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(dials).toEqual([]);
    },
  );
});

describe.skipIf(!cert)("client SMTP: live delivery to a local receiver", () => {
  let starttls: SmtpMock;
  let implicit: SmtpMock;
  beforeAll(async () => {
    const auth = { user: "forum@north-retail.example", pass: PASSWORD };
    starttls = await new SmtpMock({ tls: "starttls", auth, cert: cert ?? undefined }).start();
    implicit = await new SmtpMock({ tls: "implicit", auth, cert: cert ?? undefined }).start();
  });
  afterAll(async () => {
    await starttls.stop();
    await implicit.stop();
  });

  test("465 implicit TLS with AUTH; QR inline attachment for the owner; logs without address", async () => {
    const db = new MemorySystemDb(loadSpec("forum"));
    const ticket = await db.insert("ticket", {
      holder_user: "u1",
      status: "paid",
      qr_token: "WZ1.1.ABCDEFGH.sig",
    });
    const dials: string[] = [];
    const ctx = liveCtx(implicit, { db, dials });
    const out = (await invokeAction(emailConnector, "sendTemplate", ctx, {
      userId: "u1",
      template: "ticket_issued",
      params: { link: "https://forum.example/ticket/1" },
      attachQrOf: { entity: "ticket", id: ticket },
    })) as { messageId: string };
    expect(dials).toEqual([`${PUBLIC_IP}:465`]);
    const [mail] = implicit.mails;
    expect(mail).toMatchObject({
      from: "forum@north-retail.example",
      to: [EMAIL],
      secure: true,
      authUser: "forum@north-retail.example",
    });
    expect(out.messageId).toMatch(/@north-retail\.example>$/);
    const headers = Object.fromEntries(parseHeaders(mail?.data ?? ""));
    expect(headers["Auto-Submitted"]).toBe("auto-generated");
    expect(headers["Message-ID"]).toBe(out.messageId);
    expect(mail?.data).toContain("Content-Type: image/png");
    expect(mail?.data).toMatch(/Content-ID: <qr-[^>]+>/);
    expect(mail?.data).toContain("multipart/related");
    const logs = JSON.stringify(ctx.logs);
    expect(logs).not.toContain(EMAIL);
    expect(logs).not.toContain(PASSWORD);
  });

  test("587 requires STARTTLS; a server without it → CONFIG_INVALID", async () => {
    const ctx = liveCtx(starttls, {
      spec: withSmtp(loadSpec("forum"), { host: "smtp.example.test", port: 587, secure: false }),
    });
    await invokeAction(emailConnector, "sendTemplate", ctx, {
      userId: "u1",
      template: "speaker_approved",
      params: {},
    });
    expect(starttls.mails.at(-1)).toMatchObject({ secure: true, to: [EMAIL] });
    const plain = await new SmtpMock({
      tls: "none",
      auth: { user: "forum@north-retail.example", pass: PASSWORD },
    }).start();
    try {
      const bad = liveCtx(plain, {
        spec: withSmtp(loadSpec("forum"), { host: "smtp.example.test", port: 587, secure: false }),
      });
      await expect(
        invokeAction(emailConnector, "sendTemplate", bad, {
          userId: "u1",
          template: "speaker_approved",
          params: {},
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(plain.mails).toHaveLength(0);
    } finally {
      await plain.stop();
    }
  });

  test("535 → AUTH_FAILED; 550 → RECIPIENT_UNAVAILABLE; 451, 451, 250 → delivered after 3 attempts", async () => {
    const wrong = liveCtx(implicit, { secrets: { smtp_password: "wrong" } });
    await expect(
      invokeAction(emailConnector, "sendTemplate", wrong, {
        userId: "u1",
        template: "speaker_approved",
        params: {},
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED", providerStatus: 535 });
    const auth = { user: "forum@north-retail.example", pass: PASSWORD };
    const rcpt = await new SmtpMock({
      tls: "implicit",
      auth,
      cert: cert ?? undefined,
      rcptCode: 550,
    }).start();
    const flaky = await new SmtpMock({
      tls: "implicit",
      auth,
      cert: cert ?? undefined,
      dataFailures: { code: 451, times: 2 },
    }).start();
    try {
      await expect(
        invokeAction(emailConnector, "sendTemplate", liveCtx(rcpt), {
          userId: "u1",
          template: "speaker_approved",
          params: {},
        }),
      ).rejects.toMatchObject({ code: "RECIPIENT_UNAVAILABLE" });
      const ctx = liveCtx(flaky);
      await invokeAction(
        emailConnector,
        "sendTemplate",
        ctx,
        { userId: "u1", template: "speaker_approved", params: {} },
        { sleep: noSleep },
      );
      expect(flaky.connections).toBe(3);
      expect(flaky.mails).toHaveLength(1);
    } finally {
      await rcpt.stop();
      await flaky.stop();
    }
  });

  test("≤ 100 an hour on Free, 300 on paid → RATE_LIMITED", async () => {
    const now = new Date("2026-10-01T10:00:00Z");
    const store = new MemoryStore(() => now);
    const hour = Math.floor(now.getTime() / 3_600_000);
    await store.set(`quota:email_hour:${hour}`, 100);
    const free = liveCtx(implicit, { store, now: () => now });
    await expect(
      invokeAction(emailConnector, "sendTemplate", free, {
        userId: "u1",
        template: "speaker_approved",
        params: {},
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const paid = liveCtx(implicit, { store, now: () => now, plan: "paid" });
    await invokeAction(emailConnector, "sendTemplate", paid, {
      userId: "u1",
      template: "speaker_approved",
      params: {},
    });
  });
});

describe("platform provider and dev receiver", () => {
  test("platform account: noreply@<mailDomain>, password from platform secrets; not configured → SECRET_MISSING", async () => {
    const receiver = await new SmtpMock({ tls: "none" }).start();
    try {
      const spec = forumWith((s) => {
        emailIntegration(s).config = {
          provider: "platform",
          templates: { t: { subject: "Тема", body: "Текст" } },
        };
        emailIntegration(s).secretRefs = [];
      });
      const base = { spec, integration: "email", env: "prod" as const, contacts: { u1: { email: EMAIL } } };
      const missing = createTestCtx(base);
      await expect(
        invokeAction(emailConnector, "sendTemplate", missing, { userId: "u1", template: "t", params: {} }),
      ).rejects.toMatchObject({ code: "SECRET_MISSING" });
      const ctx = createTestCtx({
        ...base,
        platform: testPlatform({
          smtp: { host: "127.0.0.1", port: receiver.port, tls: "none" },
          secrets: staticSecretReader({}),
          dial: tcpDialer,
        }),
      });
      await invokeAction(emailConnector, "sendTemplate", ctx, { userId: "u1", template: "t", params: {} });
      expect(receiver.mails[0]).toMatchObject({ from: "noreply@systems.test", to: [EMAIL] });
      await sendPlatformEmail(
        { ...ctx, idempotencyKey: "inv" },
        {
          to: "guest@example.ru",
          subject: "Приглашение",
          text: "Вас пригласили",
          action: "invite",
        },
      );
      expect(receiver.mails[1]?.to).toEqual(["guest@example.ru"]);
    } finally {
      await receiver.stop();
    }
  });

  test("draft with WIZARD_DEV_SMTP: mail goes to the dev receiver instead of the outbox", async () => {
    const receiver = await new SmtpMock({ tls: "none" }).start();
    try {
      const ctx = createTestCtx({
        spec: loadSpec("forum"),
        integration: "email",
        contacts: { u1: { email: EMAIL } },
        platform: testPlatform({
          devSmtp: { host: "127.0.0.1", port: receiver.port, tls: "none" },
          dial: tcpDialer,
        }),
      });
      await invokeAction(emailConnector, "sendTemplate", ctx, {
        userId: "u1",
        template: "speaker_approved",
        params: {},
      });
      expect(receiver.mails).toHaveLength(1);
      expect(ctx.outbox.messages).toHaveLength(0);
    } finally {
      await receiver.stop();
    }
  });
});

describe("forum ticket in draft", () => {
  test("notify step → .data/outbox with the QR PNG; a repeated step sends nothing; logs without the address", async () => {
    const root = await mkdtemp(join(tmpdir(), "wz-mail-outbox-"));
    try {
      const spec = loadSpec("forum");
      const db = new MemorySystemDb(spec);
      const ticket = await db.insert("ticket", {
        holder_user: "u1",
        status: "paid",
        qr_token: "WZ1.1.QRQRQRQR.sig",
      });
      const ctx = createTestCtx({
        spec,
        integration: "email",
        db,
        contacts: { u1: { email: EMAIL } },
        systemId: "forumsys",
      });
      const outbox = new JsonlOutbox(root);
      const writing = {
        ...ctx,
        outbox: {
          write: async (m: Json) => {
            await outbox.write(m);
            await ctx.outbox.write(m);
          },
        },
      };
      const wf = (spec.workflows ?? []).find((w) => w.name === "ticket_paid_email") as Json;
      const step = {
        params: { ...wf.steps[0].params, link: "/ticket/$record.id" },
        entity: "ticket",
        record: (await db.get("ticket", ticket)) as Json,
        jobId: "job-7",
        stepIndex: 0,
      };
      await runNotifyStep(writing as never, step);
      await runNotifyStep(writing as never, step);
      expect(ctx.outbox.messages).toHaveLength(1);
      const files = await readdir(join(root, "forumsys", "email"));
      expect(files).toHaveLength(1);
      const eml = await readFile(join(root, "forumsys", "email", files[0] as string), "utf8");
      expect(eml).toContain("Content-Type: image/png");
      const png =
        /Content-Disposition: inline; filename="qr.png"\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(eml)?.[1] ?? "";
      expect(Buffer.from(png.replace(/\r\n/g, ""), "base64").subarray(1, 4).toString()).toBe("PNG");
      const text = (ctx.outbox.messages[0] as Json).payload.text as string;
      expect(text).toContain(`https://forumsys--draft.localhost:4100/ticket/${ticket}`);
      const logs = JSON.stringify(ctx.logs);
      expect(logs).not.toContain(EMAIL);
      expect(logs).toContain('"status":"replayed"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
