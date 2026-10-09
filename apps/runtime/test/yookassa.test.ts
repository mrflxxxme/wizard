// M2-02: /api/pay with connectors: 'live' against the YooKassa stub, /_wizard/hooks/yookassa (IP allowlist through a
// trusted ingress only, re-read from the API, idempotency, needs_review) and refunds through the connector host.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropSystemRoleDDL, quoteIdent } from "@wizard/appspec";
import {
  type ConnectorCtx,
  checkPaymentOnReturn,
  derivedToken,
  invokeAction,
  newQrKeyring,
  serializeQrKeyring,
  staticSecretReader,
  YOOKASSA_IP_ALLOWLIST,
  yookassaConnector,
} from "@wizard/connectors";
import { YookassaMock } from "@wizard/connectors/mocks";
import { testPlatform } from "@wizard/connectors/testing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { rememberClientIp } from "../src/auth/client-ip.js";
import {
  createRuntimeApp,
  type LoadedSystem,
  MemoryRegistry,
  migrateSystem,
  type RuntimeApp,
  type RuntimeEnv,
  SYSTEM_SUBJECT,
  schemaName,
  startRuntime,
} from "../src/index.js";
import { createConnectorHost } from "../src/preview/connectors.js";
import { DB_URL, devEnv, forumSpec, login, newKey, request, seedRow, userIdOf } from "./helpers.js";

const SLUG = "ykpay";
const HOST = `${SLUG}--draft.localhost:4100`;
const YK_IP = "185.71.76.10";

let sql: postgres.Sql;
let role: string;
let mock: YookassaMock;
let rt: RuntimeApp;
let key: string;
let schema: string;
let cookie: string;
let platform: ReturnType<typeof testPlatform>;
const spec = forumSpec();
const outboxDir = mkdtempSync(join(tmpdir(), "wz-rt-yk-"));
const closers: (() => Promise<void>)[] = [];

const secrets = () =>
  staticSecretReader({
    yookassa_shop_id: mock.shopId,
    yookassa_secret_key: mock.secretKey,
    qr_signing_key: serializeQrKeyring(newQrKeyring()),
  });

const hookPath = (token = derivedToken(mock.secretKey, "yookassa-hook:yookassa")) =>
  `/_wizard/hooks/yookassa/yookassa/${token}`;

function runtime(o: { env?: Partial<RuntimeEnv>; connectors?: "live" | "outbox" } = {}) {
  return createRuntimeApp({
    db: sql,
    registry: new MemoryRegistry(),
    dbRole: role,
    env: { ...devEnv, ...o.env },
    connectors: o.connectors ?? "live",
    platform,
    outboxDir,
    secrets,
  });
}

beforeAll(async () => {
  sql = postgres(DB_URL, { max: 8, onnotice: () => {} });
  role = `wz_rt_yk_${randomBytes(4).toString("hex")}`;
  await sql.unsafe(`CREATE ROLE ${quoteIdent(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  mock = await new YookassaMock().start();
  platform = testPlatform({
    yookassa: { live: true, apiBase: mock.apiBase, ipAllowlist: YOOKASSA_IP_ALLOWLIST },
  });
  key = newKey();
  schema = schemaName(key, "draft");
  await migrateSystem(sql, { systemId: key, env: "draft", spec, runtimeRole: role });
  rt = runtime();
  await rt.loadSystem({ systemKey: key, env: "draft", spec, slug: SLUG });
  cookie = await login(rt, HOST, "participant");
}, 60_000);

afterAll(async () => {
  for (const close of closers) await close();
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  for (const st of dropSystemRoleDDL(schema)) await sql.unsafe(st);
  await sql.unsafe(`DROP OWNED BY ${quoteIdent(role)}`).catch(() => {});
  await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
  await sql.end();
  await mock.stop();
  rmSync(outboxDir, { recursive: true, force: true });
});

async function sys(): Promise<LoadedSystem> {
  return (await rt.systems.resolve(SLUG, "draft")) as LoadedSystem;
}

async function ticket(amount = 1500): Promise<string> {
  const s = await sys();
  const holder = await userIdOf(sql, schema, "participant");
  const stream = await seedRow(sql, schema, s.spec, "stream");
  const type = await seedRow(sql, schema, s.spec, "ticket_type");
  return s.data.transaction("default", SYSTEM_SUBJECT, (tx) =>
    tx.system.insert("ticket", {
      ticket_type: type,
      stream,
      holder_user: holder,
      holder_name: "Мария",
      holder_email: `m${randomUUID().slice(0, 8)}@example.ru`,
      status: "pending_payment",
      amount,
      event_starts_at: "2026-11-01T09:00:00.000Z",
    }),
  );
}

const pay = (body: unknown) => rt.fetch(request("POST", HOST, "/api/pay/yookassa", { cookie, body }));

/** Notification as delivered by the in-process server from `ip` (null — no socket address). */
function hook(body: unknown, ip: string | null = YK_IP, path = hookPath(), app = rt) {
  const req = request("POST", HOST, path, { body, csrf: false });
  if (ip) rememberClientIp(req, ip);
  return app.fetch(req);
}

const row = async (id: string) =>
  (await sql.unsafe(`select status, amount from ${quoteIdent(schema)}."ticket" where id = $1`, [id]))[0];
const payments = (id: string) =>
  sql.unsafe(
    `select kind, status, amount, provider_payment_id from ${quoteIdent(schema)}."payment" where ticket = $1 order by created_at`,
    [id],
  );
const paymentFor = (id: string) =>
  [...mock.payments.values()].filter((p) => p.metadata.recordId === id).at(-1)?.id as string;

async function connectorCtx(idempotencyKey: string): Promise<ConnectorCtx> {
  const s = await sys();
  const host = createConnectorHost({
    env: devEnv,
    clock: () => new Date(),
    outbox: [],
    devSecretsDir: outboxDir,
    platform,
    connectors: "live",
    secrets,
  });
  const integ = s.spec.integrations?.find((i) => i.name === "yookassa");
  if (!integ) throw new Error("no yookassa integration");
  return { ...host.ctx(s, integ, `http://${HOST}`), idempotencyKey };
}

describe("draft with a test shop (connectors: 'live')", () => {
  test("V3-18: the notice and the return check together apply the payment once (claim in Postgres)", async () => {
    const id = await ticket();
    expect((await pay({ binding: "ticket", id })).status).toBe(200);
    const pid = paymentFor(id);
    mock.succeed(pid);
    const ctx = await connectorCtx(`race-${id}`);
    // The store's atomic claim: one winner among concurrent callers.
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => ctx.store.setIfAbsent?.(`race-claim:${id}`, { x: 1 }, 60_000)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const [notice, back] = await Promise.all([
      hook(mock.notification("payment.succeeded", pid)),
      checkPaymentOnReturn(ctx, { binding: "ticket", id }),
    ]);
    expect([200, 409]).toContain(notice.status);
    expect(["applied", "busy", "duplicate"]).toContain(back);
    expect((await row(id))?.status).toBe("paid");
    expect(await payments(id)).toMatchObject([{ kind: "payment", status: "succeeded" }]);
    // A notice answered 409 (busy) is delivered again by ЮKassa: then it is a duplicate.
    expect((await hook(mock.notification("payment.succeeded", pid))).status).toBe(200);
  });

  test("V3-18: the owner's page shows the address of the notifications; others are refused", async () => {
    const anon = await rt.fetch(request("GET", HOST, "/_wizard/payments"));
    expect(await anon.text()).toContain("Войдите");
    expect((await rt.fetch(request("GET", HOST, "/_wizard/payments", { cookie }))).status).toBe(403);
    const admin = await login(rt, HOST, "organizer");
    const page = await rt.fetch(request("GET", HOST, "/_wizard/payments", { cookie: admin }));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("/_wizard/hooks/yookassa/yookassa/");
    expect(html).toContain("HTTP-уведомления");
  });

  test("pay → paidStatus → refund → refundedStatus; client amount ignored; redelivery idempotent", async () => {
    const id = await ticket();
    const res = await pay({ binding: "ticket", id, amount: 1 });
    expect(res.status).toBe(200);
    const { confirmationUrl } = (await res.json()) as { confirmationUrl: string };
    const pid = paymentFor(id);
    expect(confirmationUrl).toBe(`${mock.origin}/checkout/payments/${pid}`);
    const created = mock.payments.get(pid);
    expect(created?.amount).toEqual({ value: "1500.00", currency: "RUB" });
    expect(created?.confirmation.return_url).toBe(`http://${HOST}/ticket/${id}`);
    expect(created?.metadata).toEqual({ system: key, env: "draft", binding: "ticket", recordId: id });
    expect(await payments(id)).toMatchObject([
      { kind: "payment", status: "pending", provider_payment_id: pid },
    ]);

    mock.succeed(pid);
    const ok = await hook(mock.notification("payment.succeeded", pid));
    expect(ok.status).toBe(200);
    expect((await row(id))?.status).toBe("paid");
    expect((await hook(mock.notification("payment.succeeded", pid))).status).toBe(200);
    expect(await payments(id)).toMatchObject([{ kind: "payment", status: "succeeded" }]);

    const ctx = await connectorCtx(`refund-${id}`);
    const r = (await invokeAction(yookassaConnector, "refund", ctx, { binding: "ticket", id })) as {
      refundId: string;
      status: string;
    };
    expect(r.status).toBe("succeeded");
    expect((await row(id))?.status).toBe("refunded");
    expect((await hook(mock.notification("refund.succeeded", r.refundId))).status).toBe(200);
    expect((await payments(id)).map((p) => [p.kind, p.status])).toEqual([
      ["payment", "succeeded"],
      ["refund", "succeeded"],
    ]);
  });

  test("forged notifications: foreign IP or no address → 401; bad token → 404; GET pending → no change", async () => {
    const id = await ticket();
    await pay({ binding: "ticket", id });
    const pid = paymentFor(id);
    const forged = mock.notification("payment.succeeded", pid, { status: "succeeded", paid: true });
    expect((await hook(forged, "203.0.113.7")).status).toBe(401);
    expect((await hook(forged, null)).status).toBe(401);
    expect((await hook(forged, YK_IP, hookPath("A".repeat(32)))).status).toBe(404);
    const gets = mock.callsTo("GET", `/v3/payments/${pid}`).length;
    expect((await hook(forged)).status).toBe(200);
    expect(mock.callsTo("GET", `/v3/payments/${pid}`)).toHaveLength(gets + 1);
    expect((await row(id))?.status).toBe("pending_payment");
    expect(await payments(id)).toMatchObject([{ status: "pending" }]);
    // API failure → 500 so that YooKassa redelivers.
    for (let i = 0; i < 3; i++) mock.queue.push({ status: 503 });
    expect((await hook(forged)).status).toBe(500);
  });

  test("record amount changed while pending: new payment; the old one succeeding → needs_review", async () => {
    const id = await ticket(2000);
    await pay({ binding: "ticket", id });
    const oldId = paymentFor(id);
    await sql.unsafe(`update ${quoteIdent(schema)}."ticket" set amount = 2500 where id = $1`, [id]);
    expect((await pay({ binding: "ticket", id })).status).toBe(200);
    const newId = paymentFor(id);
    expect(newId).not.toBe(oldId);
    mock.succeed(oldId);
    expect((await hook(mock.notification("payment.succeeded", oldId))).status).toBe(200);
    expect((await row(id))?.status).toBe("pending_payment");
    expect((await payments(id)).map((p) => p.status)).toEqual(["needs_review", "pending"]);
    expect(rt.outbox().some((m) => m.action === "owner_event")).toBe(true);
  });

  test("outbox mode: the hook does not exist and /api/pay keeps the draft mock page", async () => {
    const off = runtime({ connectors: "outbox" });
    await off.loadSystem({ systemKey: key, env: "draft", spec, slug: SLUG });
    const id = await ticket();
    const offCookie = await login(off, HOST, "participant");
    const res = await off.fetch(
      request("POST", HOST, "/api/pay/yookassa", { cookie: offCookie, body: { binding: "ticket", id } }),
    );
    expect(((await res.json()) as { confirmationUrl: string }).confirmationUrl).toBe(
      `/_wizard/pay-mock?binding=ticket&id=${id}`,
    );
    expect((await hook(mock.notification("payment.succeeded", "x"), YK_IP, hookPath(), off)).status).toBe(
      404,
    );
  });
});

describe("source IP through the node server", () => {
  async function freePort(): Promise<number> {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as { port: number }).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
  }

  async function serve(trustedProxies: string[]): Promise<number> {
    const port = await freePort();
    const { runtime: srv, close } = await startRuntime({
      db: sql,
      registry: new MemoryRegistry(),
      dbRole: role,
      env: { ...devEnv, authModeDev: false, devLogin: false, trustedProxies },
      connectors: "live",
      platform,
      secrets,
      port,
    });
    closers.push(close);
    await srv.loadSystem({ systemKey: key, env: "draft", spec, slug: SLUG });
    return port;
  }

  function post(port: number, body: unknown, xff: string): Promise<number> {
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: hookPath(),
          headers: {
            host: `${SLUG}--draft.localhost`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(data),
            "x-forwarded-for": xff,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  }

  test("spoofed X-Forwarded-For from an untrusted peer → 401; via a trusted ingress → processed", async () => {
    const id = await ticket();
    await pay({ binding: "ticket", id });
    const pid = paymentFor(id);
    mock.succeed(pid);
    const body = mock.notification("payment.succeeded", pid);
    expect(await post(await serve([]), body, YK_IP)).toBe(401);
    expect((await row(id))?.status).toBe("pending_payment");
    const viaIngress = await serve(["127.0.0.0/8", "::1/128"]);
    expect(await post(viaIngress, body, "203.0.113.7")).toBe(401);
    expect(await post(viaIngress, body, `203.0.113.7, ${YK_IP}`)).toBe(200);
    expect((await row(id))?.status).toBe("paid");
  });
});
