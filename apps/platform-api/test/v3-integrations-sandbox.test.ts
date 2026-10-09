// V3-22 acceptance 2 without the network: the sandbox check of the API passports (src/integrations-v3/sandbox.ts)
// against local TLS «test contours» that answer by the passports' own mocks — the platform's key-check path (egress
// client, secret://name, the СДЭК oauth2cc token exchanged at call time), safe operations validated against the
// passport, precise mismatch reports, ЮKassa skipped without keys and refused with a live key, secrets masked in every
// line, unreachable hosts named per host in Russian, resets retried, the HTTPS_PROXY tunnel. Keys are random per run.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import {
  type AddressInfo,
  createServer as createNetServer,
  connect as netConnect,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { cdek, mockTransport, passportContract, yookassa } from "@wizard/agents/integrations";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  CDEK_PUBLIC_TEST_ACCOUNT,
  kassaCredentials,
  maskText,
  parsePassports,
  runSandboxCheck,
  type SandboxNet,
  type SandboxReport,
  type SandboxStep,
  sandboxAnnotations,
  sandboxSummary,
} from "../src/integrations-v3/sandbox.js";

const CDEK_HOST = "api.edu.cdek.ru";
const KASSA_HOST = "api.yookassa.ru";
const b64 = (n: number) => randomBytes(n).toString("base64url").replace(/[-_]/g, "x");

function cert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "wz-sandbox-cert-"));
  try {
    execFileSync(
      "openssl",
      [
        ...[
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-nodes",
          "-days",
          "2",
        ],
        ...["-subj", `/CN=${CDEK_HOST}`, "-addext", `subjectAltName=DNS:${CDEK_HOST},DNS:${KASSA_HOST}`],
        ...["-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")],
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tls = cert();
const CDEK_CONTRACT = passportContract(cdek, { sandbox: true });
const KASSA_CONTRACT = passportContract(yookassa);

interface Hit {
  host: string;
  method: string;
  path: string;
  /** Label of the Authorization header (never its value). */
  auth: string;
  idem?: string;
  /** Form fields of a token request: where they came and whether they matched. */
  token?: { via: "form" | "query"; grant: string | null; matched: boolean };
  body?: unknown;
}

type Answer = { status: number; body: unknown };
/** The «test contours»: the accepted credentials, the token mode and answers that override the mocks. */
const state = {
  cdek: {
    id: "",
    secret: "",
    token: "",
    mode: "form" as "form" | "query",
    tokenError: null as Answer | null,
  },
  kassa: { auth: "", echoAuth: false },
  overrides: new Map<string, Answer>(),
  hits: [] as Hit[],
};

let upstream: Server;
let port = 0;
const net = (): SandboxNet => ({
  resolve: async () => ["127.0.0.1"],
  allowPrivate: true,
  port,
  ca: tls.cert,
  platformDomains: ["sandpile.ru"],
  timeoutMs: 3000,
});
const instant = async () => {};

beforeAll(async () => {
  upstream = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const host = String(req.headers.host ?? "").split(":")[0] ?? "";
      const text = Buffer.concat(chunks).toString("utf8");
      const url = new URL(`https://${host}${req.url ?? "/"}`);
      const method = req.method ?? "GET";
      const send = (a: Answer) =>
        res.writeHead(a.status, { "content-type": "application/json" }).end(JSON.stringify(a.body));
      const auth = req.headers.authorization;
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      if (host === CDEK_HOST && url.pathname === "/v2/oauth/token") {
        const c = state.cdek;
        const form = new URLSearchParams(text);
        const via = form.has("client_id") ? "form" : "query";
        const f = via === "form" ? form : url.searchParams;
        const matched = f.get("client_id") === c.id && f.get("client_secret") === c.secret;
        state.hits.push({
          host,
          method,
          path: url.pathname,
          auth: "none",
          token: { via, grant: f.get("grant_type"), matched },
        });
        if (c.tokenError) return send(c.tokenError);
        if (!matched || via !== c.mode) return send({ status: 401, body: { error: "invalid_client" } });
        return send({
          status: 200,
          body: {
            access_token: c.token,
            token_type: "bearer",
            expires_in: 3599,
            scope: "location:all",
            jti: "j-1",
          },
        });
      }
      const label =
        host === CDEK_HOST
          ? auth === `Bearer ${state.cdek.token}`
            ? "bearer"
            : auth
              ? "other"
              : "none"
          : auth === state.kassa.auth
            ? "basic"
            : auth
              ? "other"
              : "none";
      const idem = req.headers["idempotence-key"];
      state.hits.push({
        host,
        method,
        path: url.pathname,
        auth: label,
        ...(typeof idem === "string" ? { idem } : {}),
        ...(body !== undefined ? { body } : {}),
      });
      if (label !== "bearer" && label !== "basic") {
        // A provider that echoes what it got: the check must never let it into the report.
        const echo = state.kassa.echoAuth ? ` ${String(auth)}` : "";
        return send({
          status: 401,
          body: { type: "error", code: "invalid_credentials", description: `Bad key${echo}` },
        });
      }
      const o = state.overrides.get(`${method} ${url.pathname}`);
      if (o) return send(o);
      const contract = host === CDEK_HOST ? CDEK_CONTRACT : KASSA_CONTRACT;
      const r = await mockTransport(contract)({
        method: method as "GET",
        url: url.toString(),
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
        ...(text ? { body: text } : {}),
      });
      res.writeHead(r.status, { "content-type": "application/json" }).end(r.text);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  port = (upstream.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => upstream?.close(r));
});

/** Fresh credentials of both contours per test (the runtime's token cache is per process, keyed by the secret). */
function fresh() {
  const kassa = { shop: String(100000 + Math.floor(Math.random() * 800000)), key: `test_${b64(24)}` };
  state.cdek = {
    id: b64(16),
    secret: b64(24),
    token: `${b64(20)}.${b64(40)}.${b64(20)}`,
    mode: "form",
    tokenError: null,
  };
  state.kassa = {
    auth: `Basic ${Buffer.from(`${kassa.shop}:${kassa.key}`).toString("base64")}`,
    echoAuth: false,
  };
  state.overrides.clear();
  state.hits = [];
  return {
    kassa,
    env: {
      CDEK_TEST_ACCOUNT: state.cdek.id,
      CDEK_TEST_SECURE: state.cdek.secret,
      YOOKASSA_TEST_SHOP_ID: kassa.shop,
      YOOKASSA_TEST_SECRET_KEY: kassa.key,
    },
  };
}

beforeEach(() => {
  fresh();
});

/** Every text the check prints or writes. */
const output = (r: SandboxReport) =>
  [...sandboxAnnotations(r), sandboxSummary(r), JSON.stringify(r.steps)].join("\n");
const leaks = (r: SandboxReport, secrets: string[]) => secrets.filter((s) => output(r).includes(s));
const stepOf = (r: SandboxReport, passport: string, step: string) =>
  r.steps.find((s) => s.passport === passport && s.step === step) as SandboxStep;
const verdicts = (r: SandboxReport) => r.steps.map((s) => `${s.passport}:${s.step}:${s.verdict}`);

describe("СДЭК: the educational contour", () => {
  test("public test account: host, token, the key check and the safe operations pass; nothing is created", async () => {
    state.cdek.id = CDEK_PUBLIC_TEST_ACCOUNT.account;
    state.cdek.secret = CDEK_PUBLIC_TEST_ACCOUNT.secure;
    // An answer with a field the passport does not know: named, not a mismatch.
    const cities = CDEK_CONTRACT.operations.find((o) => o.id === "listCities")?.response.example as object[];
    state.overrides.set("GET /v2/location/cities", {
      status: 200,
      body: cities.map((c) => ({ ...c, city_uuid: "u-1" })),
    });
    const r = await runSandboxCheck({ passports: ["cdek"], env: {}, net: net(), sleep: instant });
    expect(verdicts(r)).toEqual([
      "cdek:host:ok",
      "cdek:token:ok",
      "cdek:listCities:ok",
      "cdek:calculateTariff:ok",
      "cdek:calculateTariffList:ok",
      "cdek:listDeliveryPoints:ok",
      "cdek:listWebhooks:ok",
    ]);
    expect(r.ok).toBe(true);
    expect(stepOf(r, "cdek", "host").message_ru).toContain(
      "общая тестовая учётная запись из документации СДЭК",
    );
    expect(stepOf(r, "cdek", "token").message_ru).toContain("живёт 3599 с");
    expect(stepOf(r, "cdek", "listCities").message_ru).toContain("поля вне паспорта: city_uuid");
    // The token is requested with the form body (the runtime's way) and every API call carries it.
    const tokens = state.hits.filter((h) => h.token);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    expect(
      tokens.every(
        (h) => h.token?.via === "form" && h.token.grant === "client_credentials" && h.token.matched,
      ),
    ).toBe(true);
    const calls = state.hits.filter((h) => !h.token);
    expect(calls.every((h) => h.host === CDEK_HOST && h.auth === "bearer")).toBe(true);
    expect(calls.map((h) => `${h.method} ${h.path}`)).not.toContain("POST /v2/orders");
    expect(
      leaks(r, [CDEK_PUBLIC_TEST_ACCOUNT.account, CDEK_PUBLIC_TEST_ACCOUNT.secure, state.cdek.token]),
    ).toEqual([]);
    const lines = sandboxAnnotations(r);
    expect(lines).toHaveLength(7);
    expect(lines.every((l) => /^::notice title=СДЭК · [a-zA-Z]+::[^\n]+$/.test(l))).toBe(true);
  });

  test("own account from CDEK_TEST_ACCOUNT / CDEK_TEST_SECURE; one of the two — refused, nothing sent", async () => {
    const { env } = fresh();
    const r = await runSandboxCheck({
      passports: ["cdek"],
      env: { CDEK_TEST_ACCOUNT: env.CDEK_TEST_ACCOUNT, CDEK_TEST_SECURE: env.CDEK_TEST_SECURE },
      net: net(),
      sleep: instant,
    });
    expect(r.ok).toBe(true);
    expect(stepOf(r, "cdek", "host").message_ru).toContain("секреты CDEK_TEST_*");
    expect(leaks(r, [env.CDEK_TEST_ACCOUNT, env.CDEK_TEST_SECURE, state.cdek.token])).toEqual([]);
    state.hits = [];
    const one = await runSandboxCheck({
      passports: ["cdek"],
      env: { CDEK_TEST_ACCOUNT: env.CDEK_TEST_ACCOUNT },
      net: net(),
      sleep: instant,
    });
    expect(verdicts(one)).toEqual(["cdek:keys:refused"]);
    expect(one.ok).toBe(false);
    expect(stepOf(one, "cdek", "keys").message_ru).toContain("нужны оба");
    expect(state.hits).toEqual([]);
    expect(leaks(one, [env.CDEK_TEST_ACCOUNT])).toEqual([]);
  });

  test("schema mismatch: the operation, the JSON pointer, what the passport expects and what came", async () => {
    const { env } = fresh();
    state.overrides.set("GET /v2/location/cities", { status: 200, body: [{ code: "44", city: "Москва" }] });
    state.overrides.set("POST /v2/calculator/tariff", {
      status: 200,
      body: { delivery_sum: "390", period_min: 2, period_max: 3 },
    });
    const r = await runSandboxCheck({ passports: ["cdek"], env, net: net(), sleep: instant });
    expect(r.ok).toBe(false);
    const check = stepOf(r, "cdek", "listCities");
    expect(check).toMatchObject({ verdict: "mismatch", level: "error", status: 200 });
    expect(check.message_ru).toContain("ключ подошёл (200), но ответ не совпал с паспортом");
    expect(check.problems).toEqual(['/0/code: Ожидается целое число, пришло строка; пришло "44"']);
    const tariff = stepOf(r, "cdek", "calculateTariff");
    expect(tariff).toMatchObject({ verdict: "mismatch", level: "error" });
    expect(tariff.problems).toEqual([
      "/total_sum: Нет обязательного поля «total_sum»",
      '/delivery_sum: Ожидается число, пришло строка; пришло "390"',
    ]);
    // The key works, so the run goes on after the check's mismatch.
    expect(stepOf(r, "cdek", "listDeliveryPoints").verdict).toBe("ok");
    const line = sandboxAnnotations(r).find((l) => l.includes("calculateTariff")) as string;
    expect(line).toBe(
      '::error title=СДЭК · calculateTariff::ответ 200 не совпал с паспортом (2) — /total_sum: Нет обязательного поля «total_sum»; /delivery_sum: Ожидается число, пришло строка; пришло "390"',
    );
    const summary = sandboxSummary(r);
    expect(summary).toContain("### Расхождения с паспортом");
    expect(summary).toContain("| СДЭК | calculateTariff | расхождение | 200 |");
  });

  test("oauth2cc: a token endpoint that takes the parameters only in the query string is reported precisely", async () => {
    const { env } = fresh();
    state.cdek.mode = "query";
    const r = await runSandboxCheck({ passports: ["cdek"], env, net: net(), sleep: instant });
    const token = stepOf(r, "cdek", "token");
    expect(token).toMatchObject({ verdict: "mismatch", level: "error", status: 401 });
    expect(token.message_ru).toContain("токен выдан только с параметрами в строке запроса");
    expect(token.message_ru).toContain("Рантайм (egress-fetch, accessToken) шлёт их в теле");
    // The runtime's own exchange (form body) is refused: the key check sees a 401 without reaching the API.
    const check = stepOf(r, "cdek", "listCities");
    expect(check).toMatchObject({ verdict: "failed", status: 401 });
    expect(check.message_ru).toContain("AUTH_FAILED");
    expect(state.hits.filter((h) => !h.token)).toEqual([]);
    expect(r.steps.map((s) => s.step)).toEqual(["host", "token", "listCities"]);
    expect(leaks(r, [env.CDEK_TEST_ACCOUNT, env.CDEK_TEST_SECURE, state.cdek.token])).toEqual([]);
  });

  test("a token endpoint that echoes the credentials in its error never gets them into the report", async () => {
    const { env } = fresh();
    state.cdek.tokenError = {
      status: 401,
      body: {
        error: "invalid_client",
        error_description: `Bad client ${env.CDEK_TEST_SECURE} of ${env.CDEK_TEST_ACCOUNT}`,
      },
    };
    const r = await runSandboxCheck({ passports: ["cdek"], env, net: net(), sleep: instant });
    const token = stepOf(r, "cdek", "token");
    expect(token.verdict).toBe("failed");
    expect(token.message_ru).toContain("error=invalid_client");
    expect(token.message_ru).toContain("error_description=Bad client ••• of •••");
    expect(leaks(r, [env.CDEK_TEST_ACCOUNT, env.CDEK_TEST_SECURE])).toEqual([]);
  });

  test("--cdek-order: склад-дверь from a reception point, read back, found by number, deleted", async () => {
    const { env } = fresh();
    const r = await runSandboxCheck({
      passports: ["cdek"],
      env,
      net: net(),
      sleep: instant,
      cdekOrder: true,
      runId: "42",
    });
    expect(r.ok).toBe(true);
    expect(r.steps.slice(-4).map((s) => `${s.step}:${s.verdict}`)).toEqual([
      "createOrder:ok",
      "getOrder:ok",
      "findOrder:ok",
      "deleteOrder:ok",
    ]);
    const created = state.hits.find((h) => h.method === "POST" && h.path === "/v2/orders");
    expect(created?.body).toMatchObject({
      type: 1,
      number: "wz-sandbox-42",
      tariff_code: 137,
      shipment_point: "MSK123",
      to_location: { code: 137 },
      recipient: { name: "Покупатель Тестовый" },
    });
    const accepted = cdek.operations.find((o) => o.id === "createOrder")?.response.example as {
      entity: { uuid: string };
    };
    expect(state.hits.filter((h) => h.method === "DELETE").map((h) => h.path)).toEqual([
      `/v2/orders/${accepted.entity.uuid}`,
    ]);
    const got = stepOf(r, "cdek", "getOrder").message_ru;
    expect(got).toContain("состояние запроса: SUCCESSFUL");
    expect(got).toContain(
      "cdek_number: строка; statuses как пришли: CREATED 2026-10-09T12:15:01+0300 → ACCEPTED",
    );
  });
});

describe("ЮKassa: the test shop", () => {
  test("no keys: a warning with what to do, nothing sent", async () => {
    const r = await runSandboxCheck({ passports: ["yookassa"], env: {}, net: net(), sleep: instant });
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ step: "keys", level: "warning", verdict: "skipped" });
    expect(r.steps[0]?.message_ru).toContain(
      "нет тестового магазина: создайте его в личном кабинете ЮKassa и положите ключи в секреты YOOKASSA_TEST_SHOP_ID и YOOKASSA_TEST_SECRET_KEY",
    );
    expect(sandboxAnnotations(r)).toEqual([
      expect.stringMatching(/^::warning title=ЮKassa · keys::нет тестового магазина/),
    ]);
    expect(state.hits).toEqual([]);
  });

  test("a live key or one of the two secrets — refused before any request, the key never printed", async () => {
    const live = `live_${b64(24)}`;
    const r = await runSandboxCheck({
      passports: ["yookassa"],
      env: { YOOKASSA_TEST_SHOP_ID: "506751", YOOKASSA_TEST_SECRET_KEY: live },
      net: net(),
      sleep: instant,
    });
    expect(verdicts(r)).toEqual(["yookassa:keys:refused"]);
    expect(r.ok).toBe(false);
    expect(r.steps[0]?.message_ru).toContain("не ключ тестового магазина (должен начинаться с test_)");
    expect(leaks(r, [live])).toEqual([]);
    const one = await runSandboxCheck({
      passports: ["yookassa"],
      env: { YOOKASSA_TEST_SECRET_KEY: `test_${b64(24)}` },
      net: net(),
      sleep: instant,
    });
    expect(verdicts(one)).toEqual(["yookassa:keys:refused"]);
    expect(state.hits).toEqual([]);
  });

  test("one secret YOUKASSA_TEST_API_KEY: «shopId:key», JSON or the key with YOOKASSA_TEST_SHOP_ID", async () => {
    expect(kassaCredentials({ YOUKASSA_TEST_API_KEY: " 506751:test_abc " })).toEqual({
      shop: "506751",
      secret: "test_abc",
    });
    expect(
      kassaCredentials({ YOUKASSA_TEST_API_KEY: '{"shop_id":"506751","secret_key":"test_abc"}' }),
    ).toEqual({
      shop: "506751",
      secret: "test_abc",
    });
    expect(kassaCredentials({ YOUKASSA_TEST_API_KEY: "test_abc", YOOKASSA_TEST_SHOP_ID: "506751" })).toEqual({
      shop: "506751",
      secret: "test_abc",
    });
    // The separate secrets win over the single one.
    expect(
      kassaCredentials({
        YOOKASSA_TEST_SHOP_ID: "1",
        YOOKASSA_TEST_SECRET_KEY: "test_x",
        YOUKASSA_TEST_API_KEY: "2:test_y",
      }),
    ).toEqual({ shop: "1", secret: "test_x" });
    const { kassa } = fresh();
    const single = `${kassa.shop}:${kassa.key}`;
    const r = await runSandboxCheck({
      passports: ["yookassa"],
      env: { YOUKASSA_TEST_API_KEY: single },
      net: net(),
      sleep: instant,
      runId: "8",
    });
    expect(verdicts(r).slice(0, 2)).toEqual(["yookassa:host:ok", "yookassa:getShop:ok"]);
    expect(leaks(r, [single, kassa.key])).toEqual([]);
    // The key alone, without the shop id: refused before any request, names what is missing.
    fresh();
    const noShop = await runSandboxCheck({
      passports: ["yookassa"],
      env: { YOUKASSA_TEST_API_KEY: kassa.key },
      net: net(),
      sleep: instant,
    });
    expect(verdicts(noShop)).toEqual(["yookassa:keys:refused"]);
    expect(noShop.steps[0]?.message_ru).toContain("идентификатора магазина (shopId)");
    expect(state.hits).toEqual([]);
  });

  test("test keys: the key check, a payment with Idempotence-Key and its repeat, read, list; cancel only from waiting_for_capture", async () => {
    const { env, kassa } = fresh();
    const r = await runSandboxCheck({ passports: ["yookassa"], env, net: net(), sleep: instant, runId: "7" });
    expect(verdicts(r)).toEqual([
      "yookassa:host:ok",
      "yookassa:getShop:ok",
      "yookassa:createPayment:ok",
      "yookassa:createPayment (повтор):ok",
      "yookassa:getPayment:ok",
      "yookassa:listPayments:ok",
      "yookassa:cancelPayment:skipped",
    ]);
    expect(r.ok).toBe(true);
    expect(stepOf(r, "yookassa", "createPayment (повтор)").message_ru).toContain(
      "повтор с тем же Idempotence-Key вернул тот же платёж",
    );
    expect(stepOf(r, "yookassa", "cancelPayment")).toMatchObject({ level: "notice" });
    const posts = state.hits.filter((h) => h.method === "POST" && h.path === "/v3/payments");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.idem).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts[1]?.idem).toBe(posts[0]?.idem);
    // 1 ₽, two-stage (nothing is charged), a receipt because the shop has 54-ФЗ receipts on.
    expect(posts[0]?.body).toMatchObject({
      amount: { value: "1.00", currency: "RUB" },
      capture: false,
      metadata: { order_id: "wz-sandbox-7" },
      receipt: { customer: { email: "sandbox@example.com" } },
    });
    expect(state.hits.every((h) => h.host === KASSA_HOST && h.auth === "basic")).toBe(true);
    expect(leaks(r, [kassa.key, state.kassa.auth, state.kassa.auth.slice(6)])).toEqual([]);

    // A payment waiting for capture is cancelled (and the answer validated).
    const waiting = {
      ...(yookassa.operations.find((o) => o.id === "getPayment")?.response.example as object),
    };
    state.overrides.set(`GET /v3/payments/${(waiting as { id: string }).id}`, {
      status: 200,
      body: { ...waiting, status: "waiting_for_capture", paid: true },
    });
    state.hits = [];
    const w = await runSandboxCheck({ passports: ["yookassa"], env, net: net(), sleep: instant });
    expect(stepOf(w, "yookassa", "cancelPayment").verdict).toBe("ok");
    expect(state.hits.filter((h) => h.path.endsWith("/cancel"))).toHaveLength(1);
  });

  test("a shop that is not a test shop by GET /me: no payment is created", async () => {
    const { env } = fresh();
    state.overrides.set("GET /v3/me", { status: 200, body: { account_id: "506751", test: false } });
    const r = await runSandboxCheck({ passports: ["yookassa"], env, net: net(), sleep: instant });
    expect(verdicts(r)).toEqual([
      "yookassa:host:ok",
      "yookassa:getShop:ok",
      "yookassa:createPayment:refused",
    ]);
    expect(stepOf(r, "yookassa", "createPayment").message_ru).toContain("не тестовый (test ≠ true)");
    expect(state.hits.filter((h) => h.method === "POST")).toEqual([]);
  });

  test("a provider that echoes the Authorization value in its error: masked in every line", async () => {
    const { env, kassa } = fresh();
    state.kassa.auth = "Basic something-else";
    state.kassa.echoAuth = true;
    const r = await runSandboxCheck({ passports: ["yookassa"], env, net: net(), sleep: instant });
    const check = stepOf(r, "yookassa", "getShop");
    expect(check).toMatchObject({ verdict: "failed", status: 401 });
    expect(check.message_ru).toContain("AUTH_FAILED");
    expect(check.message_ru).toContain("code=invalid_credentials, description=Bad key •••");
    const basic = `Basic ${Buffer.from(`${kassa.shop}:${kassa.key}`).toString("base64")}`;
    expect(leaks(r, [kassa.key, basic, basic.slice(6)])).toEqual([]);
  });
});

describe("network", () => {
  test("unreachable hosts are named per host, in Russian, and nothing else is sent", async () => {
    const { env } = fresh();
    const r = await runSandboxCheck({
      passports: ["cdek", "yookassa"],
      env,
      net: {
        ...net(),
        resolve: async () => {
          throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
        },
      },
      sleep: instant,
    });
    expect(verdicts(r)).toEqual(["cdek:host:unreachable", "yookassa:host:unreachable"]);
    expect(stepOf(r, "cdek", "host").message_ru).toBe(
      "api.edu.cdek.ru недоступен с этого раннера (4 попытки): имя не разрешается в адрес (ENOTFOUND). Операции не выполнялись: проверку нужно запустить из сети, где хост доступен (например, с сервера пилота в РФ).",
    );
    expect(stepOf(r, "yookassa", "host").message_ru).toMatch(/^api\.yookassa\.ru недоступен с этого раннера/);
    expect(sandboxAnnotations(r).map((l) => l.split("::")[1])).toEqual([
      "error title=СДЭК · host",
      "error title=ЮKassa · host",
    ]);
    expect(state.hits).toEqual([]);
  });

  test("a reset during the TLS handshake and a closed port are told apart", async () => {
    const reset = createNetServer((s) => s.destroy());
    await new Promise<void>((r) => reset.listen(0, "127.0.0.1", r));
    const closed = createNetServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    try {
      const { env } = fresh();
      const viaReset = await runSandboxCheck({
        passports: ["cdek"],
        env,
        net: { ...net(), port: (reset.address() as AddressInfo).port },
        sleep: instant,
      });
      expect(stepOf(viaReset, "cdek", "host").message_ru).toContain(
        "соединение сброшено во время TLS-рукопожатия (ECONNRESET) — похоже, хост не принимает соединения из этой сети",
      );
      const viaClosed = await runSandboxCheck({
        passports: ["cdek"],
        env,
        net: { ...net(), port: closedPort },
        sleep: instant,
      });
      expect(stepOf(viaClosed, "cdek", "host").message_ru).toContain(
        "TCP-соединение (IPv4) не установлено — порт 443 закрыт (ECONNREFUSED)",
      );
    } finally {
      await new Promise((r) => reset.close(r));
    }
  });

  test("a network that resets some handshakes: requests are repeated and the report says so", async () => {
    let n = 0;
    const open = new Set<Socket>();
    // Every third connection is reset before TLS; the rest go to the contour.
    const flaky = createNetServer((s) => {
      n += 1;
      if (n % 3 === 2) {
        s.destroy();
        return;
      }
      const u = netConnect({ host: "127.0.0.1", port });
      open.add(s).add(u);
      s.pipe(u).pipe(s);
      u.on("error", () => s.destroy());
      s.on("error", () => u.destroy());
    });
    await new Promise<void>((r) => flaky.listen(0, "127.0.0.1", r));
    try {
      const { env } = fresh();
      const r = await runSandboxCheck({
        passports: ["cdek"],
        env,
        net: { ...net(), port: (flaky.address() as AddressInfo).port },
        sleep: instant,
      });
      expect(r.ok).toBe(true);
      expect(output(r)).toMatch(
        /с 2-й попытки \(до этого: Внешний сервис (недоступен|не выдал токен доступа)/,
      );
    } finally {
      for (const x of open) x.destroy();
      await new Promise((r) => flaky.close(r));
    }
  });

  test("HTTPS_PROXY: the same check through a CONNECT tunnel; a proxy that refuses is named", async () => {
    const connects: string[] = [];
    let refuse = false;
    const open = new Set<Socket | Duplex>();
    const proxy: HttpServer = createHttpServer();
    proxy.on("connect", (req, socket, head) => {
      connects.push(String(req.url));
      open.add(socket);
      if (refuse) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const u = netConnect({ host: "127.0.0.1", port }, () => {
        open.add(u);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) u.write(head);
        u.pipe(socket).pipe(u);
      });
      u.on("error", () => socket.destroy());
      socket.on("error", () => u.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
      const { env } = fresh();
      const r = await runSandboxCheck({
        passports: ["cdek"],
        env,
        net: { proxyUrl, ca: tls.cert, platformDomains: ["sandpile.ru"], timeoutMs: 3000 },
        sleep: instant,
      });
      expect(r.ok).toBe(true);
      expect(stepOf(r, "cdek", "host").message_ru).toContain("через прокси HTTPS_PROXY");
      expect(new Set(connects)).toEqual(new Set([`${CDEK_HOST}:443`]));
      refuse = true;
      const denied = await runSandboxCheck({
        passports: ["cdek"],
        env,
        net: { proxyUrl, ca: tls.cert, timeoutMs: 3000 },
        sleep: instant,
      });
      expect(stepOf(denied, "cdek", "host").message_ru).toContain(
        "api.edu.cdek.ru недоступен через прокси (4 попытки): прокси HTTPS_PROXY не открыл туннель к api.edu.cdek.ru:443 (PROXY_403)",
      );
    } finally {
      for (const x of open) x.destroy();
      proxy.closeAllConnections();
      await new Promise((r) => proxy.close(r));
    }
  });
});

describe("report", () => {
  const step = (i: number, extra: Partial<SandboxStep> = {}): SandboxStep => ({
    passport: "cdek",
    step: `op${i}`,
    level: "notice",
    verdict: "ok",
    status: 200,
    ms: 1,
    message_ru: `шаг ${i}`,
    problems: [],
    ...extra,
  });

  test("one line per step, escaped; above 10 of a level the rest share the 10th line", () => {
    const steps = Array.from({ length: 12 }, (_, i) => step(i));
    steps.push(
      step(99, { level: "error", verdict: "mismatch", step: "a:b,c", message_ru: "строка 1\nстрока 2 100%" }),
    );
    const lines = sandboxAnnotations({ ok: false, steps });
    expect(lines).toHaveLength(11);
    expect(lines.filter((l) => l.startsWith("::notice"))).toHaveLength(10);
    expect(lines[9]).toBe(
      "::notice title=СДЭК · op9 и ещё 2::СДЭК · op9: шаг 9 | СДЭК · op10: шаг 10 | СДЭК · op11: шаг 11",
    );
    expect(lines[10]).toBe("::error title=СДЭК · a%3Ab%2Cc::строка 1 строка 2 100%25");
    expect(lines.every((l) => !l.includes("\n"))).toBe(true);
  });

  test("maskText: every secret and its percent-encoded form; short values are left alone", () => {
    expect(maskText("a=k/ey+1 b=k%2Fey%2B1 c=abc", ["k/ey+1", "abc"])).toBe("a=••• b=••• c=abc");
  });

  test("parsePassports: all, a list, a passport without a test contour, an unknown name", () => {
    expect(parsePassports("all")).toEqual({ ok: true, ids: ["cdek", "yookassa"] });
    expect(parsePassports("")).toEqual({ ok: true, ids: ["cdek", "yookassa"] });
    expect(parsePassports("yookassa, cdek,cdek")).toEqual({ ok: true, ids: ["yookassa", "cdek"] });
    expect(parsePassports("telegram")).toEqual({
      ok: false,
      error_ru: "у паспорта «Telegram Bot API» нет тестового контура: проверяются только СДЭК, ЮKassa",
    });
    expect(parsePassports("bogus")).toMatchObject({
      ok: false,
      error_ru: expect.stringContaining("неизвестный паспорт «bogus»"),
    });
  });
});
