// Read-only preflight of the pilot (`pilot.mjs check`, tools/deploy/preflight.mjs): each probe against a fake fetch
// or a local SMTP receiver (self-signed certificate generated per run), and the whole command — nothing is created,
// no value of a secret reaches a log line or the step summary. No network.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mailTransportOf, unisenderApiBase } from "../../../packages/connectors/src/mail-api.ts";
import { PROVIDERS } from "../../../packages/llm/src/index.ts";
import { main } from "../pilot.mjs";
import { encryptBundle, ensureBundle, STOCK_KEY_ENV } from "../pilot-secrets.mjs";
import {
  ALERT_TEXT,
  checkSpf,
  DEFAULT_BASE,
  mailApiBase,
  mailTransport,
  parseFrom,
  probeCloudru,
  probeDomain,
  probeFrom,
  probeMail,
  probeMailApi,
  probeSmtp,
  probeSpf,
  probeStock,
  probeTelegram,
  probeTimeweb,
  probeZai,
  runPreflight,
  SECRET_NAMES,
  STOCK_KEY_INPUTS,
  smtpEndpoint,
  stockKeyVerdict,
  stockVerdictLine,
  summaryTable,
  tcpConnect,
} from "../preflight.mjs";

const FAST = { name: "scrypt", N: 1024, r: 8, p: 1 };
const PASS = "correct horse battery staple 42";
const tmp = mkdtempSync(join(tmpdir(), "wizard-preflight-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const TG = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc";
const BASE = {
  TWC_TOKEN: "twc-very-secret-token",
  WIZARD_STATE_PASSPHRASE: PASS,
  CLOUDRU_API_KEY: "cloudru-secret-key",
  ZAI_API_KEY: "zai-secret-key-123",
  WIZARD_SMTP_HOST: "localhost",
  WIZARD_SMTP_USER: "smtp-user-4242",
  WIZARD_SMTP_PASSWORD: "smtp-secret-password",
  WIZARD_SMTP_FROM: "Wizard <noreply@codename.ru>",
  WIZARD_OPS_ALERT_TELEGRAM_TOKEN: TG,
  WIZARD_OPS_ALERT_CHAT_ID: "-1001234567",
  WIZARD_PLATFORM_DOMAIN: "codename.ru",
  WIZARD_SYSTEMS_DOMAIN: "neutral.ru",
  WIZARD_FOUNDER_EMAIL: "founder@example.ru",
  WIZARD_PLATFORM_MAIL_SPF: "include:_spf.unisender.ru",
  WIZARD_GHCR_TOKEN: "ghs_job_token_value",
  GITHUB_REPOSITORY_OWNER: "Owner",
};

/** Fake fetch: [regexp, (url, init) => {status, body}] routes; records every call. Unrouted — 404. */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, headers: init.headers ?? {}, body: init.body });
    for (const [re, h] of routes) {
      if (re.test(url) && (!h.method || h.method === method)) {
        const r = await (h.fn ?? h)(url, init);
        if (r instanceof Error) throw r;
        const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
        return new Response(body, { status: r.status ?? 200 });
      }
    }
    return new Response("{}", { status: 404 });
  };
  f.calls = calls;
  return f;
}

const netError = (code) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

const okRoutes = (over = {}) => [
  [
    /\/api\/v1\/account\/finances$/,
    () => ({ body: { finances: { balance: 3500.5, currency: "RUB", hours_left: 900 } } }),
  ],
  [/\/api\/v1\/account\/status$/, () => ({ body: { status: { is_blocked: false } } })],
  [
    /\/api\/v1\/domains\/(codename|neutral|stg-codename|stg-neutral)\.ru$/,
    () => ({ body: { domain: { domain_status: "paid" } } }),
  ],
  [/\/api\/v1\/storages\/buckets$/, () => ({ body: { buckets: over.buckets ?? [] } })],
  [/\/api\/v1\/storages\/users$/, () => ({ body: { users: [] } })],
  [
    /s3\.twcstorage\.ru\/$/,
    () => ({
      body: `<ListAllMyBucketsResult><Buckets>${(over.buckets ?? []).map((b) => `<Bucket><Name>${b.name}</Name></Bucket>`).join("")}</Buckets></ListAllMyBucketsResult>`,
    }),
  ],
  [/s3\.twcstorage\.ru/, () => (over.bundle ? { body: over.bundle } : { status: 404, body: "" })],
  [
    /foundation-models\.api\.cloud\.ru\/v1\/models$/,
    () => over.cloudru ?? { body: { data: [{ id: "a" }, { id: "b" }] } },
  ],
  [
    /api\.z\.ai\/api\/paas\/v4\/async-result\//,
    () => over.zai ?? { status: 404, body: { error: { code: "1214", message: "not found" } } },
  ],
  [/\/getMe$/, () => ({ body: { ok: true, result: { username: "wizard_alerts_bot" } } })],
  [/\/sendMessage$/, () => over.send ?? { body: { ok: true } }],
  [
    /unisender\.ru\/ru\/transactional\/api\/v1\/system\/ping\.json$/,
    () => over.mailApi ?? { body: { status: "success", user_id: 11344 } },
  ],
];

describe("preflight: Timeweb Cloud", () => {
  it("token and balance: one authenticated GET each, balance reported, never the token", async () => {
    const f = fakeFetch(okRoutes());
    const r = await probeTimeweb(BASE, { fetch: f });
    expect(r).toMatchObject({ status: "ok", required: true });
    expect(r.detail).toContain("баланс 3500.5 RUB");
    expect(r.detail).toContain("900 ч");
    expect(f.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /api/v1/account/finances",
      "GET /api/v1/account/status",
    ]);
    expect(f.calls[0].headers.authorization).toBe(`Bearer ${BASE.TWC_TOKEN}`);
    expect(JSON.stringify(r)).not.toContain(BASE.TWC_TOKEN);
  });

  it("rejected token, blocked account, no answer, empty balance", async () => {
    const rej = await probeTimeweb(BASE, {
      fetch: fakeFetch([[/finances/, () => ({ status: 401, body: { error_code: "unauthorized" } })]]),
    });
    expect(rej.status).toBe("fail");
    expect(rej.detail).toMatch(/TWC_TOKEN отклонён \(HTTP 401\)/);
    const blocked = await probeTimeweb(BASE, {
      fetch: fakeFetch([
        [/finances/, () => ({ body: { finances: { balance: 1 } } })],
        [/status/, () => ({ body: { status: { is_blocked: true } } })],
      ]),
    });
    expect(blocked).toMatchObject({ status: "fail", detail: "аккаунт Timeweb Cloud заблокирован" });
    const down = await probeTimeweb(BASE, { fetch: fakeFetch([[/./, () => netError("ENOTFOUND")]]) });
    expect(down).toMatchObject({ status: "fail", detail: "нет ответа (ENOTFOUND)" });
    const empty = await probeTimeweb(BASE, {
      fetch: fakeFetch([[/finances/, () => ({ body: { finances: { balance: -10, currency: "RUB" } } })]]),
    });
    expect(empty.status).toBe("ok");
    expect(empty.warnings[0]).toMatch(/баланс/);
    expect((await probeTimeweb({})).status).toBe("skipped");
  });

  it("domains: the DNS zone of the account by name (twc_dns_zone), a listed subdomain, expired, missing", async () => {
    const f = fakeFetch([
      [
        /\/domains\/codename\.ru$/,
        () => ({ body: { domain: { fqdn: "codename.ru", domain_status: "paid" } } }),
      ],
      [/\/domains\/old\.ru$/, () => ({ body: { domain: { domain_status: "expired" } } })],
      [/\/domains\/stg\.codename\.ru$/, () => ({ status: 404, body: { error_code: "not_found" } })],
      [/\/domains\/codename\.ru$/, () => ({})],
    ]);
    const ok = await probeDomain(BASE, "WIZARD_PLATFORM_DOMAIN", "домен платформы", { fetch: f });
    expect(ok).toMatchObject({ status: "ok", warnings: [] });
    expect(f.calls[0]).toMatchObject({
      method: "GET",
      url: "https://api.timeweb.cloud/api/v1/domains/codename.ru",
    });
    const missing = await probeDomain(BASE, "WIZARD_SYSTEMS_DOMAIN", "домен систем", { fetch: f });
    expect(missing.status).toBe("fail");
    expect(missing.detail).toMatch(/neutral\.ru нет в «Доменах»/);
    const old = await probeDomain({ ...BASE, X: "old.ru" }, "X", "x", { fetch: f });
    expect(old.status).toBe("ok");
    expect(old.warnings[0]).toMatch(/истёк/);
    const sub = fakeFetch([
      [/\/domains\/stg\.codename\.ru$/, () => ({ status: 404, body: {} })],
      [
        /\/domains\/codename\.ru$/,
        () => ({ body: { domain: { subdomains: [{ fqdn: "stg.codename.ru" }] } } }),
      ],
    ]);
    const s = await probeDomain({ ...BASE, X: "stg.codename.ru" }, "X", "x", { fetch: sub });
    expect(s).toMatchObject({ status: "ok", detail: "stg.codename.ru: поддомен codename.ru в аккаунте" });
  });
});

describe("preflight: models", () => {
  it("Cloud.ru: GET /models with the key (default base = packages/llm registry); 401/403 fail", async () => {
    expect(DEFAULT_BASE.cloudru).toBe(PROVIDERS.cloudru.defaultBaseUrl);
    expect(DEFAULT_BASE.zai).toBe(PROVIDERS.zai.defaultBaseUrl);
    const f = fakeFetch(okRoutes());
    const ok = await probeCloudru(BASE, { fetch: f });
    expect(ok).toMatchObject({ status: "ok", detail: "ключ принят, моделей доступно: 2" });
    expect(f.calls[0]).toMatchObject({ method: "GET", url: `${PROVIDERS.cloudru.defaultBaseUrl}/models` });
    expect(f.calls[0].headers.authorization).toBe(`Bearer ${BASE.CLOUDRU_API_KEY}`);
    for (const status of [401, 403]) {
      const r = await probeCloudru(BASE, { fetch: fakeFetch(okRoutes({ cloudru: { status } })) });
      expect(r.status).toBe("fail");
      expect(r.detail).toContain("CLOUDRU_API_KEY отклонён");
    }
    const custom = fakeFetch([[/^https:\/\/fm\.example\/v1\/models$/, () => ({ body: { data: [] } })]]);
    expect(
      (await probeCloudru({ ...BASE, CLOUDRU_BASE_URL: "https://fm.example/v1/" }, { fetch: custom })).status,
    ).toBe("ok");
    expect((await probeCloudru({})).status).toBe("skipped");
  });

  it("Z.ai: optional; a GET that spends no tokens; bad key and empty balance fail, unknown answers «не проверено»", async () => {
    const f = fakeFetch(okRoutes());
    const ok = await probeZai(BASE, { fetch: f });
    expect(ok).toMatchObject({ status: "ok", required: false });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].method).toBe("GET");
    expect(f.calls[0].url).not.toMatch(/completions|tokenizer/);
    const bad = await probeZai(BASE, {
      fetch: fakeFetch(okRoutes({ zai: { status: 401, body: { error: { code: "1000", message: "x" } } } })),
    });
    expect(bad).toMatchObject({ status: "fail", required: false });
    const broke = await probeZai(BASE, {
      fetch: fakeFetch(okRoutes({ zai: { status: 429, body: { error: { code: "1113" } } } })),
    });
    expect(broke.detail).toMatch(/баланс Z\.ai исчерпан/);
    for (const zai of [
      { status: 500, body: "" },
      { status: 404, body: "<html>" },
    ]) {
      const r = await probeZai(BASE, { fetch: fakeFetch(okRoutes({ zai })) });
      expect(r.status).toBe("skipped");
      expect(r.detail).toMatch(/^не проверено/);
    }
    expect(await probeZai({})).toMatchObject({ status: "skipped", required: false });
  });
});

describe("preflight: alerts, sender, SPF", () => {
  it("Telegram: getMe, then the test message to the chat; the bot is named, the token never", async () => {
    const f = fakeFetch(okRoutes());
    const r = await probeTelegram(BASE, { fetch: f });
    expect(r).toMatchObject({
      status: "ok",
      detail: "бот @wizard_alerts_bot, тестовое сообщение отправлено",
    });
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(JSON.parse(f.calls[1].body)).toEqual({ chat_id: BASE.WIZARD_OPS_ALERT_CHAT_ID, text: ALERT_TEXT });
    expect(ALERT_TEXT).toBe("Wizard: проверка настроек пилота — алерты доходят");
    expect(JSON.stringify(r)).not.toContain(TG);
  });

  it("Telegram: rejected token, unknown chat, malformed token (no request), not configured", async () => {
    const rej = await probeTelegram(BASE, {
      fetch: fakeFetch([[/getMe/, () => ({ status: 401, body: { ok: false } })]]),
    });
    expect(rej.status).toBe("fail");
    const chat = await probeTelegram(BASE, {
      fetch: fakeFetch(
        okRoutes({ send: { status: 400, body: { ok: false, description: "Bad Request: chat not found" } } }),
      ),
    });
    expect(chat.status).toBe("fail");
    expect(chat.detail).toMatch(/chat not found.*напишите боту/);
    const f = fakeFetch(okRoutes());
    const bad = await probeTelegram({ ...BASE, WIZARD_OPS_ALERT_TELEGRAM_TOKEN: "nope" }, { fetch: f });
    expect(bad.status).toBe("fail");
    expect(f.calls).toHaveLength(0);
    expect(await probeTelegram({})).toMatchObject({ status: "skipped", required: false });
    expect((await probeTelegram({ WIZARD_OPS_ALERT_URL: "https://hook.example/x" })).detail).toMatch(
      /не проверяется/,
    );
  });

  it("sender: address format; another domain than the platform's is only a warning", () => {
    expect(parseFrom("Wizard <noreply@codename.ru>")).toEqual({
      address: "noreply@codename.ru",
      domain: "codename.ru",
    });
    expect(parseFrom("noreply@codename.ru")?.domain).toBe("codename.ru");
    expect(parseFrom("Wizard noreply")).toBeNull();
    expect(probeFrom(BASE)).toMatchObject({ status: "ok", warnings: [] });
    const other = probeFrom({ ...BASE, WIZARD_SMTP_FROM: "Wizard <noreply@mail.other.ru>" });
    expect(other.status).toBe("ok");
    expect(other.warnings[0]).toMatch(/не совпадает с WIZARD_PLATFORM_DOMAIN/);
    expect(probeFrom({ ...BASE, WIZARD_SMTP_FROM: "Wizard" }).status).toBe("fail");
  });

  it("SPF: mechanisms only, no v=spf1, no all", () => {
    expect(checkSpf("include:_spf.unisender.ru")).toBeNull();
    expect(checkSpf("include:a.ru include:b.ru ip4:1.2.3.0/24 mx")).toBeNull();
    expect(checkSpf("v=spf1 include:a.ru")).toMatch(/v=spf1/);
    expect(checkSpf("include:a.ru -all")).toMatch(/all/);
    expect(checkSpf("include:a.ru ~all")).toMatch(/all/);
    expect(checkSpf("hello world")).toMatch(/механизмы/);
    expect(probeSpf(BASE).status).toBe("ok");
    expect(probeSpf({}).status).toBe("skipped");
    expect(probeSpf({ WIZARD_PLATFORM_MAIL_SPF: "v=spf1 -all" }).status).toBe("fail");
  });
});

// ---- SMTP against a local receiver ----

function makeCert() {
  const dir = mkdtempSync(join(tmp, "cert-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } catch {
    return null;
  }
}
const CERT = makeCert();

/** Minimal SMTP receiver: implicit TLS or STARTTLS, AUTH PLAIN/LOGIN; records every command. */
function smtpServer({ tls, user, pass, mechs = "PLAIN LOGIN", advertiseStarttls = tls === "starttls" }) {
  const seen = [];
  const server = createServer((raw) => {
    let sock = tls === "implicit" ? new TLSSocket(raw, { isServer: true, ...CERT }) : raw;
    let secure = tls === "implicit";
    let buf = "";
    let login = null;
    const send = (l) => sock.write(`${l}\r\n`);
    const auth = (u, p) => send(u === user && p === pass ? "235 2.7.0 ok" : "535 5.7.8 invalid");
    const onLine = (line) => {
      seen.push({ line, secure });
      if (login?.step === "user") {
        login = { step: "pass", user: Buffer.from(line, "base64").toString() };
        return send("334 UGFzc3dvcmQ6");
      }
      if (login?.step === "pass") {
        const u = login.user;
        login = null;
        return auth(u, Buffer.from(line, "base64").toString());
      }
      const verb = line.split(" ")[0].toUpperCase();
      if (verb === "EHLO") {
        const caps = ["250-fake.local", `250-AUTH ${mechs}`];
        if (advertiseStarttls && !secure) caps.push("250-STARTTLS");
        caps.push("250 8BITMIME");
        return sock.write(`${caps.join("\r\n")}\r\n`);
      }
      if (verb === "STARTTLS") {
        send("220 2.0.0 go");
        sock.removeAllListeners("data");
        sock = new TLSSocket(raw, { isServer: true, ...CERT });
        secure = true;
        buf = "";
        sock.on("data", onData);
        sock.on("error", () => {});
        return;
      }
      if (verb === "AUTH") {
        const [, mech, token] = line.split(" ");
        if (mech === "PLAIN") {
          const [, u, p] = Buffer.from(token, "base64").toString().split("\0");
          return auth(u, p);
        }
        login = { step: "user" };
        return send("334 VXNlcm5hbWU6");
      }
      if (verb === "QUIT") {
        send("221 bye");
        return sock.end();
      }
      send("502 5.5.2 not here");
    };
    const onData = (c) => {
      buf += c.toString();
      for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(l);
      }
    };
    sock.on("data", onData);
    sock.on("error", () => {});
    raw.on("error", () => {});
    if (tls === "implicit") sock.once("secure", () => send("220 fake ESMTP"));
    else send("220 fake ESMTP");
  });
  return {
    seen,
    start: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    stop: () => new Promise((r) => server.close(() => r())),
  };
}

const local = {
  connect: ({ port }) => tcpConnect({ host: "127.0.0.1", port }),
  ca: CERT?.cert,
  timeoutMs: 5000,
};
const mailVars = (port, tls, over = {}) => ({
  ...BASE,
  WIZARD_SMTP_PORT: String(port),
  WIZARD_SMTP_TLS: tls,
  ...over,
});

describe("preflight: SMTP", () => {
  it("TLS mode as the platform: 465 implicit, 587 STARTTLS, WIZARD_SMTP_TLS overrides", () => {
    expect(smtpEndpoint({ WIZARD_SMTP_HOST: "h" })).toEqual({ host: "h", port: 465, tls: "implicit" });
    expect(smtpEndpoint({ WIZARD_SMTP_HOST: "h", WIZARD_SMTP_PORT: "587" }).tls).toBe("starttls");
    expect(smtpEndpoint({ WIZARD_SMTP_PORT: "2525", WIZARD_SMTP_TLS: "implicit" }).tls).toBe("implicit");
  });

  it("no connection, no host", async () => {
    const r = await probeSmtp(BASE, {
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(r).toMatchObject({ status: "fail", detail: "нет соединения с WIZARD_SMTP_HOST:WIZARD_SMTP_PORT" });
    expect((await probeSmtp({})).status).toBe("skipped");
    const plain = await probeSmtp({ ...BASE, WIZARD_SMTP_TLS: "none" });
    expect(plain.status).toBe("fail");
  });

  describe.skipIf(!CERT)("against a local receiver", () => {
    const servers = [];
    const start = async (o) => {
      const s = smtpServer({ user: BASE.WIZARD_SMTP_USER, pass: BASE.WIZARD_SMTP_PASSWORD, ...o });
      servers.push(s);
      return { s, port: await s.start() };
    };
    afterAll(async () => {
      for (const s of servers) await s.stop();
    });

    it("implicit TLS: EHLO, AUTH PLAIN → 235, QUIT; never a letter", async () => {
      const { s, port } = await start({ tls: "implicit" });
      const r = await probeSmtp(mailVars(port, "implicit"), local);
      expect(r).toMatchObject({ status: "ok" });
      expect(r.detail).toMatch(/^TLS, порт \d+: логин и пароль приняты \(235\)$/);
      const verbs = s.seen.map((x) => x.line.split(" ")[0]);
      expect(verbs).toEqual(["EHLO", "AUTH", "QUIT"]);
      expect(s.seen.every((x) => x.secure)).toBe(true);
    });

    it("STARTTLS: AUTH only after the upgrade; AUTH LOGIN when PLAIN is not offered", async () => {
      const { s, port } = await start({ tls: "starttls", mechs: "LOGIN" });
      const r = await probeSmtp(mailVars(port, "starttls"), local);
      expect(r.status).toBe("ok");
      expect(r.detail).toMatch(/^STARTTLS/);
      const verbs = s.seen.map((x) => x.line.split(" ")[0]);
      expect(verbs.slice(0, 4)).toEqual(["EHLO", "STARTTLS", "EHLO", "AUTH"]);
      expect(verbs).not.toContain("MAIL");
      expect(s.seen.filter((x) => x.line.startsWith("AUTH")).every((x) => x.secure)).toBe(true);
    });

    it("wrong password: 535, the names of the settings, not their values", async () => {
      const { port } = await start({ tls: "implicit" });
      const r = await probeSmtp(
        mailVars(port, "implicit", { WIZARD_SMTP_PASSWORD: "wrong-password-1" }),
        local,
      );
      expect(r).toMatchObject({
        status: "fail",
        detail: "WIZARD_SMTP_USER или WIZARD_SMTP_PASSWORD не подошли (535)",
      });
    });

    it("STARTTLS not offered; untrusted certificate; no user — a warning", async () => {
      const { port } = await start({ tls: "starttls", advertiseStarttls: false });
      const r = await probeSmtp(mailVars(port, "starttls"), local);
      expect(r.status).toBe("fail");
      expect(r.detail).toMatch(/не предлагает STARTTLS/);
      const { port: p2 } = await start({ tls: "implicit" });
      const untrusted = await probeSmtp(mailVars(p2, "implicit"), { ...local, ca: undefined });
      expect(untrusted.status).toBe("fail");
      expect(untrusted.detail).toMatch(/^TLS не установлен/);
      const { s, port: p3 } = await start({ tls: "implicit" });
      const anon = await probeSmtp(mailVars(p3, "implicit", { WIZARD_SMTP_USER: "" }), local);
      expect(anon.status).toBe("ok");
      expect(anon.warnings[0]).toMatch(/WIZARD_SMTP_USER не задан/);
      expect(s.seen.map((x) => x.line.split(" ")[0])).toEqual(["EHLO", "QUIT"]);
    });
  });
});

describe("preflight: Unisender Go HTTP API (the server's mail ports are closed)", () => {
  const KEY = "unisender-go-api-key-77aa";
  const UNI = { ...BASE, WIZARD_SMTP_HOST: "smtp.go1.unisender.ru", WIZARD_SMTP_PASSWORD: KEY };

  it("transport and API base equal packages/connectors mail-api.ts", () => {
    const cases = [
      {},
      { WIZARD_SMTP_HOST: "smtp.go1.unisender.ru" },
      { WIZARD_SMTP_HOST: "SMTP.GO2.unisender.ru." },
      { WIZARD_SMTP_HOST: "smtp.unisender.ru" },
      { WIZARD_SMTP_HOST: "smtp.mail.example" },
      { WIZARD_SMTP_HOST: "unisender.ru.evil.example" },
      { WIZARD_SMTP_HOST: "smtp.go1.unisender.ru", WIZARD_MAIL_TRANSPORT: "smtp" },
      { WIZARD_SMTP_HOST: "smtp.mail.example", WIZARD_MAIL_TRANSPORT: "Unisender-API" },
      { WIZARD_MAIL_TRANSPORT: "http" },
      { WIZARD_SMTP_HOST: "smtp.go1.unisender.ru", WIZARD_MAIL_API_BASE: "https://goapi.unisender.ru/" },
    ];
    for (const v of cases) {
      expect(mailTransport(v), JSON.stringify(v)).toBe(mailTransportOf(v));
      expect(mailApiBase(v), JSON.stringify(v)).toBe(
        unisenderApiBase(v.WIZARD_SMTP_HOST, v.WIZARD_MAIL_API_BASE),
      );
    }
  });

  it("system/ping with X-API-KEY: ok without a letter; 401 and no answer fail; no key — fail", async () => {
    const f = fakeFetch(okRoutes());
    const r = await probeMailApi(UNI, { fetch: f });
    expect(r).toMatchObject({ status: "ok", title: "Почта: ключ API Unisender Go" });
    expect(r.detail).toContain("go1.unisender.ru");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({
      url: "https://go1.unisender.ru/ru/transactional/api/v1/system/ping.json",
      method: "POST",
      body: "{}",
    });
    expect(f.calls[0].headers["X-API-KEY"]).toBe(KEY);
    const denied = await probeMailApi(UNI, {
      fetch: fakeFetch(okRoutes({ mailApi: { status: 401, body: { status: "error", code: 102 } } })),
    });
    expect(denied.status).toBe("fail");
    expect(denied.detail).toMatch(/не принял WIZARD_SMTP_PASSWORD как API-ключ \(HTTP 401\)/);
    expect(denied.detail).not.toContain(KEY);
    const down = await probeMailApi(UNI, {
      fetch: fakeFetch(okRoutes({ mailApi: new Error("ECONNRESET") })),
    });
    expect(down).toMatchObject({ status: "fail", detail: "нет ответа от go1.unisender.ru (порт 443)" });
    expect((await probeMailApi({ ...UNI, WIZARD_SMTP_PASSWORD: "" })).status).toBe("fail");
    expect(
      (await probeMailApi({ ...UNI, WIZARD_MAIL_API_BASE: "http://go1.unisender.ru" }, { fetch: f })).detail,
    ).toMatch(/https/);
  });

  it("probeMail: the API for a Unisender host (no SMTP connection), SMTP otherwise, unknown transport fails", async () => {
    const connect = async () => {
      throw new Error("SMTP must not be used");
    };
    const api = await probeMail(UNI, { fetch: fakeFetch(okRoutes()), smtp: { connect } });
    expect(api).toMatchObject({ status: "ok", title: "Почта: ключ API Unisender Go" });
    const smtp = await probeMail({ ...UNI, WIZARD_MAIL_TRANSPORT: "smtp" }, { smtp: { connect } });
    expect(smtp).toMatchObject({ status: "fail", title: "Почта: SMTP-вход" });
    expect((await probeMail({ ...UNI, WIZARD_MAIL_TRANSPORT: "pigeon" })).status).toBe("fail");
  });

  it("runPreflight: the mail row checks the API key; the key never reaches a line or the summary", async () => {
    const lines = [];
    let summary = "";
    await runPreflight({
      env: "prod",
      vars: { ...UNI, WIZARD_MAIL_TRANSPORT: "" },
      fetch: fakeFetch(
        okRoutes({ mailApi: { status: 401, body: { status: "error", message: KEY, code: 102 } } }),
      ),
      smtp: { connect: async () => Promise.reject(new Error("no SMTP")) },
      log: (l) => lines.push(l),
      summary: (t) => {
        summary = t;
      },
    });
    expect(summary).toMatch(/Почта: ключ API Unisender Go \| ошибка/);
    for (const l of [...lines, summary]) expect(l).not.toContain(KEY);
  });
});

// ---- The whole command ----

describe.skipIf(!CERT)("pilot.mjs check", () => {
  let server;
  let port;
  beforeAll(async () => {
    server = smtpServer({ tls: "implicit", user: BASE.WIZARD_SMTP_USER, pass: BASE.WIZARD_SMTP_PASSWORD });
    port = await server.start();
  });
  afterAll(() => server.stop());

  const S3_SECRET = "s3-secret-access-key-of-state";
  const bucket = {
    id: 7,
    name: "a1b2c3-wizard-tfstate",
    status: "created",
    access_key: "S3ACCESSKEYID",
    secret_key: S3_SECRET,
  };
  const run = async (over = {}, routes = {}, env = "prod") => {
    const summaryFile = join(tmp, `summary-${Math.random().toString(36).slice(2)}.md`);
    const vars = {
      ...BASE,
      WIZARD_SMTP_PORT: String(port),
      WIZARD_SMTP_TLS: "implicit",
      GITHUB_ACTIONS: "true",
      GITHUB_STEP_SUMMARY: summaryFile,
      ...over,
    };
    const lines = [];
    const f = fakeFetch(okRoutes(routes));
    const code = await main(["check", "--env", env], vars, {
      fetch: f,
      log: (s) => lines.push(s),
      smtp: { ...local },
    });
    let summary = "";
    try {
      summary = readFileSync(summaryFile, "utf8");
    } catch {}
    return { code, lines, summary, calls: f.calls, vars };
  };
  const secretsOf = (vars) => [
    ...SECRET_NAMES.map((n) => vars[n]).filter((v) => v && v.length >= 6),
    S3_SECRET,
  ];
  const expectNoSecrets = ({ lines, summary, vars }) => {
    for (const s of secretsOf(vars)) {
      for (const l of lines.filter((x) => !x.startsWith("::add-mask::")))
        expect(l, "log line").not.toContain(s);
      expect(summary, "summary").not.toContain(s);
    }
  };

  it("all good: exit 0, a Russian table in the step summary, only reads (one Telegram message), nothing printed", async () => {
    const r = await run({}, { buckets: [bucket] });
    expect(r.code).toBe(0);
    expect(r.summary).toContain("## Пилот prod: проверка настроек");
    expect(r.summary).toContain("| Проверка | Итог | Подробности |");
    for (const title of [
      "Настройки GitHub",
      "Timeweb Cloud: токен и баланс",
      "Timeweb Cloud: домен платформы",
      "Timeweb Cloud: домен систем",
      "Бакет состояния и WIZARD_STATE_PASSPHRASE",
      "Cloud.ru Foundation Models",
      "Z.ai (необязательно)",
      "Почта: SMTP-вход",
      "Почта: отправитель",
      "Почта: SPF домена платформы",
      "Алерты: Telegram",
    ])
      expect(r.summary).toContain(`| ${title}`);
    expect(r.summary).toContain("обязательные проверки пройдены");
    expect(r.summary).toContain("apply и словом PROD");
    expect(r.lines.some((l) => l.startsWith("::error"))).toBe(false);
    // Read-only: every request is a GET except the Telegram test message; no bucket, no object, no rule is created.
    const writes = r.calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => new URL(c.url).pathname.split("/").at(-1))).toEqual(["sendMessage"]);
    // GitHub masks: every secret value is registered before anything else is printed.
    const firstOther = r.lines.findIndex((l) => !l.startsWith("::add-mask::"));
    expect(r.lines.slice(0, firstOther)).toEqual(
      expect.arrayContaining([`::add-mask::${BASE.TWC_TOKEN}`, `::add-mask::${BASE.WIZARD_SMTP_PASSWORD}`]),
    );
    expect(r.lines).toContain(`::add-mask::${S3_SECRET}`);
    expectNoSecrets(r);
  });

  it("the passphrase is checked against the existing keys of the environment", async () => {
    const { bundle } = ensureBundle(null, "prod");
    const enc = encryptBundle(bundle, PASS, { kdf: FAST });
    const good = await run({}, { buckets: [bucket], bundle: enc });
    expect(good.summary).toMatch(
      /Бакет состояния и WIZARD_STATE_PASSPHRASE \| ok \| пароль подходит к ключам prod/,
    );
    const bad = await run(
      { WIZARD_STATE_PASSPHRASE: "another passphrase of 30 chars" },
      { buckets: [bucket], bundle: enc },
    );
    expect(bad.code).toBe(1);
    expect(bad.lines.some((l) => l.startsWith("::error title=pilot check::Бакет состояния"))).toBe(true);
    expectNoSecrets(bad);
    for (const v of Object.values(bundle.secrets)) {
      for (const l of [...good.lines, ...bad.lines].filter((x) => !x.startsWith("::add-mask::")))
        expect(l).not.toContain(v);
    }
  });

  it("failures: exit 1, ::error per required item with names only; optional Z.ai only warns", async () => {
    const r = await run(
      { WIZARD_SMTP_PASSWORD: "wrong-password-9", WIZARD_FOUNDER_EMAIL: "" },
      { cloudru: { status: 401 }, zai: { status: 401, body: { error: { code: "1000" } } } },
    );
    expect(r.code).toBe(1);
    const errors = r.lines.filter((l) => l.startsWith("::error"));
    expect(errors.join("\n")).toContain("Настройки GitHub: WIZARD_FOUNDER_EMAIL — не задан");
    expect(errors.join("\n")).toContain("CLOUDRU_API_KEY отклонён");
    expect(errors.join("\n")).toContain("WIZARD_SMTP_USER или WIZARD_SMTP_PASSWORD не подошли (535)");
    expect(errors.join("\n")).not.toContain("Z.ai");
    expect(r.lines.some((l) => l.startsWith("::warning title=pilot check::Z.ai"))).toBe(true);
    expect(r.summary).toContain("ошибка (необязательно)");
    expect(r.summary).toMatch(/ошибок — 3/);
    expectNoSecrets(r);
  });

  it("a rejected Timeweb token skips the domain and state probes instead of guessing", async () => {
    const f = fakeFetch([[/finances/, () => ({ status: 401, body: {} })], ...okRoutes()]);
    const lines = [];
    const code = await main(
      ["check", "--env", "prod"],
      { ...BASE, WIZARD_SMTP_PORT: String(port), WIZARD_SMTP_TLS: "implicit" },
      {
        fetch: f,
        log: (s) => lines.push(s),
        smtp: local,
      },
    );
    expect(code).toBe(1);
    expect(f.calls.some((c) => c.url.includes("/domains/") || c.url.includes("/storages/"))).toBe(false);
    expect(
      lines.filter((l) => /домен платформы|Бакет состояния/.test(l)).every((l) => l.startsWith("пропущено")),
    ).toBe(true);
  });

  it("staging: the envVars rules apply (own domains, never prod's)", async () => {
    const missing = await run({}, {}, "staging");
    expect(missing.code).toBe(1);
    expect(missing.summary).toMatch(
      /\| Домены staging \| ошибка \| WIZARD_STAGING_PLATFORM_DOMAIN — не задан/,
    );
    // The domain row of «Настройки GitHub» does not repeat what the staging row says.
    expect(missing.summary).not.toMatch(/Настройки GitHub \| ошибка/);
    const ok = await run(
      { WIZARD_STAGING_PLATFORM_DOMAIN: "stg-codename.ru", WIZARD_STAGING_SYSTEMS_DOMAIN: "stg-neutral.ru" },
      {},
      "staging",
    );
    expect(ok.code).toBe(0);
    expect(ok.summary).toContain("| Домены staging | ok |");
    expect(ok.summary).toContain("stg-codename.ru: зона DNS есть в аккаунте");
    expect(ok.summary).toContain("| Timeweb Cloud: домен платформы (WIZARD_STAGING_PLATFORM_DOMAIN) | ok |");
    expect(ok.summary).not.toContain("словом PROD");
  });
});

describe("preflight: report", () => {
  it("summary escapes table cells and runPreflight scrubs any secret that slips into a message", async () => {
    expect(
      summaryTable("prod", [{ title: "a|b", status: "ok", detail: "x|y", required: true, warnings: [] }]),
    ).toContain("| a\\|b | ok | x\\|y |");
    const lines = [];
    let summary = "";
    const leaky = { ...BASE, CLOUDRU_BASE_URL: `https://fm.example/${BASE.CLOUDRU_API_KEY}` };
    const f = fakeFetch([[/fm\.example/, () => ({ status: 500 })], ...okRoutes()]);
    await runPreflight({
      env: "prod",
      vars: leaky,
      fetch: f,
      smtp: { connect: async () => Promise.reject(new Error("x")) },
      log: (s) => lines.push(s),
      summary: (t) => {
        summary = t;
      },
      stateProbe: async () => ({ status: "fail", detail: `oops ${BASE.TWC_TOKEN}` }),
    });
    expect(lines.join("\n")).toContain("oops ***");
    for (const s of [BASE.TWC_TOKEN, BASE.CLOUDRU_API_KEY]) {
      expect(lines.join("\n")).not.toContain(s);
      expect(summary).not.toContain(s);
    }
  });
});

describe("preflight: stock photo keys (B2-38)", () => {
  const PEXELS = "pexels-secret-key-001";
  const PIXABAY = "12345-pixabaysecretkey";
  const stock = (pexels, pixabay) =>
    fakeFetch([
      [/^https:\/\/api\.pexels\.com\/v1\/search\?/, pexels],
      [/^https:\/\/pixabay\.com\/api\/\?/, pixabay],
    ]);

  it("the GitHub secrets of the keys are secrets of the preflight and the release reads the same names", () => {
    for (const n of Object.values(STOCK_KEY_INPUTS)) expect(SECRET_NAMES).toContain(n);
    expect(Object.fromEntries(Object.entries(STOCK_KEY_ENV).map(([p, [input]]) => [p, input]))).toEqual(
      STOCK_KEY_INPUTS,
    );
  });

  it("one search each: Pexels with the key in the header, Pixabay with the key in the query; 200 — valid", async () => {
    const f = stock(
      () => ({ body: { photos: [{ id: 1 }] } }),
      () => ({ body: { total: 1, hits: [{ id: 2 }] } }),
    );
    const a = await stockKeyVerdict("pexels", PEXELS, { fetch: f });
    const b = await stockKeyVerdict("pixabay", PIXABAY, { fetch: f });
    expect(a).toEqual({ provider: "pexels", verdict: "valid", http: 200 });
    expect(b).toEqual({ provider: "pixabay", verdict: "valid", http: 200 });
    expect(f.calls).toHaveLength(2);
    const [px, pb] = f.calls;
    expect(px.method).toBe("GET");
    expect(px.headers.authorization).toBe(PEXELS);
    expect(new URL(px.url).searchParams.get("query")).toBe("coffee");
    expect(new URL(px.url).searchParams.get("per_page")).toBe("1");
    expect(px.url).not.toContain(PEXELS);
    expect(new URL(pb.url).searchParams.get("key")).toBe(PIXABAY);
    expect(new URL(pb.url).searchParams.get("q")).toBe("coffee");
    expect(new URL(pb.url).searchParams.get("per_page")).toBe("3");
    // The verdict carries neither the key nor the URL.
    for (const v of [a, b]) expect(JSON.stringify(v)).not.toMatch(/secret|pixabay\.com|pexels\.com/);
    expect(stockVerdictLine(a)).toBe("Pexels: действителен (HTTP 200)");
  });

  it("401/403 (Pixabay also 400) — invalid; 429 — valid; 5xx and no answer — not checked; no key — no request", async () => {
    const cases = [
      ["pexels", 401, "invalid"],
      ["pexels", 403, "invalid"],
      ["pexels", 429, "valid"],
      ["pexels", 502, "unchecked"],
      ["pixabay", 400, "invalid"],
      ["pixabay", 401, "invalid"],
      ["pixabay", 403, "invalid"],
      ["pixabay", 429, "valid"],
    ];
    for (const [provider, status, verdict] of cases) {
      const f = stock(
        () => ({ status, body: "[ERROR] Invalid or missing API key" }),
        () => ({ status, body: "[ERROR 400] Invalid or missing API key" }),
      );
      const key = provider === "pexels" ? PEXELS : PIXABAY;
      expect(await stockKeyVerdict(provider, key, { fetch: f }), `${provider} ${status}`).toEqual({
        provider,
        verdict,
        http: status,
      });
    }
    // A 200 that is not the API's answer (a proxy page) proves nothing.
    const page = stock(
      () => ({ body: "<html>" }),
      () => ({ body: { error: 1 } }),
    );
    expect((await stockKeyVerdict("pexels", PEXELS, { fetch: page })).verdict).toBe("unchecked");
    expect((await stockKeyVerdict("pixabay", PIXABAY, { fetch: page })).verdict).toBe("unchecked");
    const down = stock(
      () => netError("ECONNRESET"),
      () => netError("ENOTFOUND"),
    );
    const d = await stockKeyVerdict("pixabay", PIXABAY, { fetch: down });
    expect(d).toEqual({ provider: "pixabay", verdict: "unchecked", http: 0, error: "ENOTFOUND" });
    expect(stockVerdictLine(d)).toBe("Pixabay: не проверен (нет ответа: ENOTFOUND)");
    const none = stock(
      () => ({ body: {} }),
      () => ({ body: {} }),
    );
    expect(await stockKeyVerdict("pexels", "  ", { fetch: none })).toEqual({
      provider: "pexels",
      verdict: "missing",
      http: 0,
    });
    expect(none.calls).toHaveLength(0);
    expect(stockVerdictLine({ provider: "pexels", verdict: "missing", http: 0 })).toBe("Pexels: нет ключа");
  });

  it("check rows are optional: a refused key is an optional error; a mode without keys is named", async () => {
    const f = stock(
      () => ({ body: { photos: [] } }),
      () => ({ status: 400, body: "[ERROR 400] Invalid or missing API key" }),
    );
    const rows = await probeStock(
      { PEXELS_API_KEY: PEXELS, PIXABAY_API_KEY: PIXABAY, WIZARD_STOCK_MODE: "live" },
      { fetch: f },
    );
    expect(rows.map((r) => [r.title, r.status, r.required])).toEqual([
      ["Фото: ключ Pexels (необязательно)", "ok", false],
      ["Фото: ключ Pixabay (необязательно)", "fail", false],
    ]);
    expect(rows[0].detail).toBe("Pexels: действителен (HTTP 200)");
    expect(rows[1].detail).toBe(
      "Pixabay: недействителен (HTTP 400): замените PIXABAY_API_KEY в секретах GitHub",
    );
    const off = await probeStock({ PEXELS_API_KEY: PEXELS }, { fetch: f });
    expect(off[0].detail).toContain("сейчас stock_mode=off: ключ не используется");
    expect(off[1]).toMatchObject({ status: "skipped" });
    expect(off[1].detail).toContain("PIXABAY_API_KEY не задан");
    expect(JSON.stringify([...rows, ...off])).not.toContain(PEXELS);
    expect(JSON.stringify([...rows, ...off])).not.toContain(PIXABAY);
  });

  it("pilot check: keys masked first, verdicts in the summary, a refused key fails nothing required", async () => {
    const lines = [];
    let summary = "";
    const f = fakeFetch([
      [/api\.pexels\.com/, () => ({ status: 401, body: { error: "bad" } })],
      [/pixabay\.com\/api/, () => ({ body: { hits: [] } })],
      ...okRoutes(),
    ]);
    const vars = { ...BASE, PEXELS_API_KEY: PEXELS, PIXABAY_API_KEY: PIXABAY, GITHUB_ACTIONS: "true" };
    await runPreflight({
      env: "prod",
      vars,
      fetch: f,
      smtp: { connect: async () => Promise.reject(new Error("x")) },
      log: (s) => lines.push(s),
      summary: (t) => {
        summary = t;
      },
    });
    expect(summary).toContain(
      "| Фото: ключ Pexels (необязательно) | ошибка (необязательно) | Pexels: недействителен (HTTP 401)",
    );
    expect(summary).toContain("| Фото: ключ Pixabay (необязательно) | ok | Pixabay: действителен (HTTP 200)");
    expect(lines).toContain(
      "::warning title=pilot check::Фото: ключ Pexels (необязательно): Pexels: недействителен (HTTP 401): замените PEXELS_API_KEY в секретах GitHub; сейчас stock_mode=off: ключ не используется",
    );
    expect(lines.filter((l) => l.startsWith("::error")).some((l) => l.includes("Фото"))).toBe(false);
    for (const k of [PEXELS, PIXABAY]) {
      expect(lines.join("\n")).not.toContain(k);
      expect(summary).not.toContain(k);
    }
    // The whole command masks them before anything else is printed.
    const out = [];
    await main(
      ["check", "--env", "prod"],
      { ...vars, TWC_TOKEN: "" },
      {
        fetch: fakeFetch([]),
        log: (s) => out.push(s),
        smtp: { connect: async () => Promise.reject(new Error("x")) },
      },
    );
    expect(out.slice(0, 2)).toEqual([`::add-mask::${PEXELS}`, `::add-mask::${PIXABAY}`]);
    const shown = out.filter((l) => !l.startsWith("::add-mask::")).join("\n");
    expect(shown).not.toContain(PEXELS);
    expect(shown).not.toContain(PIXABAY);
  });
});
