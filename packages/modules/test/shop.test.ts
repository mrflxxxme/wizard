// V3-23 «Интернет-магазин»: the compiled spec by parameters (goods, orders with the buyer's personal data marked and
// kept three years, the payment journal, the stock journal, СДЭК quotes, the ЮKassa integration with the 54-FZ receipt by
// the order's lines and the buyer's secret, the СДЭК client of the passport), the ЮKassa flow against the local API
// stub (the receipt object of the payment, the notification decided only by the re-read payment) and the runtime: an
// order by the public function with the server's prices, no oversell under parallel orders of the last pieces, the
// payment of a visitor's order by his secret only, the unpaid order cancelled by time with its stock back. The browser
// run of the goal scenarios GS-shop-* is goals.browser.test.ts (v2) and apps/platform-api v3-goals (v3).
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropSystemRoleDDL, quoteIdent } from "@wizard/appspec";
import { buildSystem, writeArtifact } from "@wizard/build";
import {
  handleYookassaNotification,
  RECEIPT_DELIVERY_ITEM,
  startPayment,
  YOOKASSA_IP_ALLOWLIST,
} from "@wizard/connectors";
import { YookassaMock } from "@wizard/connectors/mocks";
import { createTestCtx, MemoryStore, MemorySystemDb, testPlatform } from "@wizard/connectors/testing";
import { runGates } from "@wizard/gates";
import {
  closeExecutors,
  complianceInfo,
  createRuntimeApp,
  MemoryRegistry,
  migrateSystem,
  type RuntimeApp,
  schemaName,
} from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CDEK_CLIENT_FILES,
  type CompileSuccess,
  compilePlan,
  matrixPlan,
  SHOP_FUNCTIONS,
  SHOP_PAYMENT,
  shopManifest,
} from "../src/index.js";
import { testRegistry } from "./fixtures.js";

const registry = testRegistry();
const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";

function compiled(plan: unknown): CompileSuccess {
  const r = compilePlan(plan, registry, { appName: "Лавка" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}

const row = (name: string) => {
  const r = shopManifest.tests?.matrix.find((x) => x.name === name);
  if (!r) throw new Error(`no matrix row ${name}`);
  return r;
};
const DEFAULT = "по умолчанию: самовывоз и СДЭК, оплата ЮKassa, склад";
const OFFLINE = "без онлайн-оплаты и склада: самовывоз и курьер";
const CDEK_ONLY = "только СДЭК, без разделов и фото, НДС 22%";
const plan = (name: string) => matrixPlan(registry, "shop", row(name));
const entity = (r: CompileSuccess, name: string) => r.spec.entities.find((e) => e.name === name);
const field = (r: CompileSuccess, e: string, f: string) => entity(r, e)?.fields.find((x) => x.name === f);
const perm = (r: CompileSuccess, role: string, e: string) =>
  r.spec.permissions.find((p) => p.role === role && p.entity === e);

describe("compiled spec by parameters", () => {
  test("by default: goods with stock, orders with personal data kept three years, payments, СДЭК quotes", () => {
    const r = compiled(plan(DEFAULT));
    expect(r.spec.entities.map((e) => e.name)).toEqual(
      expect.arrayContaining([
        "product_category",
        "product",
        "pickup_point",
        "shop_order",
        "shop_order_line",
        "shop_payment",
        "stock_move",
        "delivery_quote",
      ]),
    );
    // Personal data of the buyer: marked, kept three years after the order, then cleared (the order stays).
    for (const f of ["name", "phone", "email", "comment", "note"])
      expect(field(r, "shop_order", f)?.pii, f).toBe("basic");
    expect(field(r, "shop_order", "total")?.pii).toBeUndefined();
    expect(entity(r, "shop_order")?.retention).toEqual({
      deleteAfterDays: 1095,
      anchorField: "created_at",
      mode: "anonymize",
    });
    expect(entity(r, "delivery_quote")?.retention).toEqual({ deleteAfterDays: 1 });
    expect(field(r, "product", "stock")).toMatchObject({ type: "int", min: 0, required: true });
    // The visitor reads goods on sale only; orders only through the functions; the buyer's secret is nobody's.
    expect(perm(r, "guest", "product")).toMatchObject({ ops: ["read"], rowFilter: { active: true } });
    expect(perm(r, "guest", "shop_order")).toBeUndefined();
    expect(perm(r, "guest", "shop_payment")).toBeUndefined();
    expect(perm(r, "owner", "shop_order")).toMatchObject({
      ops: ["read", "update", "delete"],
      hiddenFields: ["token"],
    });
    expect(perm(r, "owner", "shop_order")?.readonlyFields).toEqual(
      expect.arrayContaining([
        "number",
        "total",
        "items_total",
        "delivery_price",
        "pay_until",
        "stock_returned",
      ]),
    );
    expect(perm(r, "owner", "shop_payment")?.ops).toEqual(["read"]);
    expect(perm(r, "owner", "stock_move")?.ops).toEqual(["read"]);
    // ЮKassa: the built-in connector, keys only as secret://, the 54-FZ receipt by the lines and the delivery.
    const pay = r.spec.integrations?.find((i) => i.name === SHOP_PAYMENT.integration);
    expect(pay?.connector).toBe("yookassa");
    expect(pay?.secretRefs).toEqual(["secret://yookassa_shop_id", "secret://yookassa_secret_key"]);
    expect(pay?.config).toMatchObject({
      bindings: [
        {
          id: "order",
          entity: "shop_order",
          amountField: "total",
          payableStatus: "awaiting_payment",
          paidStatus: "paid",
          accessField: "token",
          returnRoute: "/order/:id",
          receipt: {
            customerEmailField: "email",
            customerPhoneField: "phone",
            paymentMode: "full_payment",
            paymentSubject: "commodity",
            vatCode: 1,
            lines: {
              entity: "shop_order_line",
              refField: "shop_order",
              quantityField: "qty",
              amountField: "sum",
            },
            deliveryField: "delivery_price",
          },
        },
      ],
    });
    expect(JSON.stringify(r.spec)).not.toMatch(/(test|live)_[A-Za-z0-9]{8,}/);
    const fns = new Map((r.spec.functions ?? []).map((f) => [f.name, f]));
    expect(fns.get(SHOP_FUNCTIONS.place)).toMatchObject({
      public: true,
      collectsPii: true,
      kind: "mutation",
    });
    expect(fns.get(SHOP_FUNCTIONS.place)?.roles).toContain("guest");
    expect(fns.get(SHOP_FUNCTIONS.order)?.systemDbReason).toMatch(/без контактов/);
    expect(fns.get(SHOP_FUNCTIONS.cdek)).toMatchObject({ kind: "action", public: true });
    expect(fns.get(SHOP_FUNCTIONS.cdek)?.egress).toBeUndefined();
    for (const [path, src] of Object.entries(CDEK_CLIENT_FILES)) expect(r.files[path]).toBe(src);
    expect(r.files["functions/shop/cdekOptions.ts"]).toContain('from "../integrations/cdek/client"');
    expect(r.spec.workflows?.map((w) => w.name)).toEqual(
      expect.arrayContaining(["shop_order_expire", "shop_stock_return", "shop_stock_paid"]),
    );
    expect(r.scenarios.filter((s) => s.module === "shop").map((s) => s.id)).toEqual([
      "GS-shop-1",
      "GS-shop-2",
      "GS-shop-3",
      "GS-shop-4",
      "GS-shop-5",
    ]);
    expect(r.metrics.filter((m) => m.module === "shop").map((m) => m.id)).toEqual([
      "orders_sold",
      "revenue",
      "average_order",
    ]);
    // The owner's cabinet: orders first, then payments and goods with their stock.
    const cabinet = r.files["ui/pages/Cabinet.tsx"] ?? "";
    expect(cabinet.indexOf('label: "Заказ"')).toBeGreaterThan(-1);
    expect(cabinet.indexOf('label: "Заказ"')).toBeLessThan(cabinet.indexOf('label: "Оплата"'));
    expect(cabinet).toContain('label: "Товар"');
  });

  test("without the online payment and the stock: no payments, no stock, the courier's address is personal data", () => {
    const r = compiled(plan(OFFLINE));
    expect(entity(r, "shop_payment")).toBeUndefined();
    expect(entity(r, "stock_move")).toBeUndefined();
    expect(entity(r, "delivery_quote")).toBeUndefined();
    expect(field(r, "product", "stock")).toBeUndefined();
    expect(r.spec.integrations?.some((i) => i.connector === "yookassa") ?? false).toBe(false);
    expect(field(r, "shop_order", "status")?.default).toBe("new");
    expect(field(r, "shop_order", "status")?.enum?.map((o) => o.value)).not.toContain("awaiting_payment");
    expect(field(r, "shop_order", "address")).toMatchObject({ pii: "basic", piiKind: "address" });
    expect(Object.keys(r.files).some((p) => p.startsWith("functions/integrations/"))).toBe(false);
    expect(r.scenarios.filter((s) => s.module === "shop").map((s) => s.id)).toEqual([
      "GS-shop-4",
      "GS-shop-6",
    ]);
  });

  test("only СДЭК with VAT 22%: the receipt's vat_code 11, no pickup points", () => {
    const r = compiled(plan(CDEK_ONLY));
    const cfg = r.spec.integrations?.find((i) => i.connector === "yookassa")?.config as {
      bindings: { receipt: { vatCode: number } }[];
    };
    expect(cfg.bindings[0]?.receipt.vatCode).toBe(11);
    expect(entity(r, "pickup_point")).toBeUndefined();
    expect(field(r, "shop_order", "delivery")?.enum?.map((o) => o.value)).toEqual(["cdek"]);
  });

  test("G2 without a runtime: personal data, the public role, keys only as secret:// (default row)", async () => {
    const r = compiled(plan(DEFAULT));
    // The owner filled the operator of personal data (G2-PII-06 asks it of every system with ПДн).
    const spec = {
      ...r.spec,
      compliance: { operatorName: "ООО «Лавка»", operatorContact: "privacy@lavka.example" },
    };
    const g2 = await runGates("G2", {
      spec,
      prevSpec: null,
      specVersion: 1,
      files: new Map(Object.entries(r.files)),
      env: "draft",
      systemKey: "shop_g2",
      milestone: "M1",
      // G2 reads no database.
      db: undefined as unknown as postgres.Sql,
    });
    const blockers = g2.checks.filter((c) => c.severity === "blocker" && c.status === "fail");
    expect(blockers.map((c) => `${c.id}: ${c.message_ru} ${c.evidence ?? ""}`)).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------- ЮKassa against the local API stub

describe("ЮKassa: the receipt of the order and the notification decided by the re-read payment", () => {
  let mock: YookassaMock;
  beforeAll(async () => {
    mock = await new YookassaMock().start();
  });
  afterAll(() => mock.stop());

  function setup() {
    const spec = compiled(plan(DEFAULT)).spec;
    const db = new MemorySystemDb(spec);
    const ctx = createTestCtx({
      spec,
      integration: SHOP_PAYMENT.integration,
      db,
      env: "draft",
      host: "http://lavka--draft.localhost:4100",
      store: new MemoryStore(() => new Date()),
      secrets: { yookassa_shop_id: mock.shopId, yookassa_secret_key: mock.secretKey },
      fetch: (input, init) => fetch(input, init),
      platform: testPlatform({
        yookassa: { live: true, apiBase: mock.apiBase, ipAllowlist: YOOKASSA_IP_ALLOWLIST },
      }),
    });
    return { ctx, db };
  }

  /** An order as shopPlaceOrder writes it: two lines and СДЭК delivery. */
  async function order(db: MemorySystemDb) {
    const id = await db.insert("shop_order", {
      number: 1001,
      status: "awaiting_payment",
      total: 3890,
      items_total: 3500,
      delivery_price: 390,
      delivery: "cdek",
      name: "Покупатель Тестовый",
      phone: "+79001234567",
      email: "buyer@example.ru",
      items_summary: "Свеча × 2; Мыло × 1",
      token: "a".repeat(48),
    });
    await db.insert("shop_order_line", { shop_order: id, name: "Свеча", qty: 2, price: 1200, sum: 2400 });
    await db.insert("shop_order_line", { shop_order: id, name: "Мыло", qty: 1, price: 1100, sum: 1100 });
    return id;
  }

  test("the payment carries the 54-FZ receipt: one item per line (unit price × quantity) and the delivery as a service", async () => {
    const { ctx, db } = setup();
    const id = await order(db);
    const res = await startPayment(
      ctx,
      { binding: SHOP_PAYMENT.binding, id },
      await db.get("shop_order", id),
    );
    expect(res.ok).toBe(true);
    const body = mock.callsTo("POST", "/v3/payments").at(-1)?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      amount: { value: "3890.00", currency: "RUB" },
      capture: true,
      description: "Заказ №1001",
      metadata: { binding: "order", recordId: id },
      confirmation: { type: "redirect", return_url: `http://lavka--draft.localhost:4100/order/${id}` },
    });
    expect(body.receipt).toEqual({
      customer: { email: "buyer@example.ru", phone: "79001234567" },
      items: [
        {
          description: "Свеча",
          quantity: 2,
          amount: { value: "1200.00", currency: "RUB" },
          vat_code: 1,
          payment_mode: "full_payment",
          payment_subject: "commodity",
        },
        {
          description: "Мыло",
          quantity: 1,
          amount: { value: "1100.00", currency: "RUB" },
          vat_code: 1,
          payment_mode: "full_payment",
          payment_subject: "commodity",
        },
        {
          description: RECEIPT_DELIVERY_ITEM,
          quantity: 1,
          amount: { value: "390.00", currency: "RUB" },
          vat_code: 1,
          payment_mode: "full_payment",
          payment_subject: "service",
        },
      ],
    });
  });

  test("a notification is decided by GET /payments/{id}: «succeeded» in the body of a pending payment changes nothing", async () => {
    const { ctx, db } = setup();
    const id = await order(db);
    await startPayment(ctx, { binding: SHOP_PAYMENT.binding, id }, await db.get("shop_order", id));
    const pid = [...mock.payments.values()].filter((p) => p.metadata.recordId === id).at(-1)?.id as string;
    // A forged body: the object says succeeded, the API says pending.
    const forged = await handleYookassaNotification(
      ctx,
      mock.notification("payment.succeeded", pid, { status: "succeeded", paid: true }),
    );
    expect(forged.result).toBe("pending");
    expect((await db.get("shop_order", id))?.status).toBe("awaiting_payment");
    mock.succeed(pid);
    const real = await handleYookassaNotification(ctx, mock.notification("payment.succeeded", pid));
    expect(real.result).toBe("applied");
    expect((await db.get("shop_order", id))?.status).toBe("paid");
    expect(await db.list("shop_payment")).toMatchObject([
      { shop_order: id, provider_payment_id: pid, kind: "payment", status: "succeeded", amount: 3890 },
    ]);
    expect(mock.callsTo("GET", `/v3/payments/${pid}`).length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------- the runtime

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
const systems = new MemoryRegistry();
const schemas: string[] = [];

beforeAll(async () => {
  db = postgres(DATABASE_URL, { max: 8, onnotice: () => {} });
  role = `wz_shop_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${quoteIdent(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-shop-rt-"));
  rt = createRuntimeApp({
    db,
    registry: systems,
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "outbox",
    env: {
      authModeDev: true,
      devLogin: true,
      unsafeLocalExec: true,
      publicScheme: "http",
      platformOrigin: "http://localhost:5173",
      systemsDomain: "localhost",
      nodeEnv: "test",
      kubernetes: false,
    },
  });
}, 60_000);

afterAll(async () => {
  await closeExecutors();
  for (const schema of schemas) {
    await db.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    for (const st of dropSystemRoleDDL(schema)) await db.unsafe(st);
  }
  await db?.unsafe(`DROP OWNED BY ${quoteIdent(role)}`).catch(() => {});
  await db?.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
  await db?.end();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** ui-kit stand-ins for the bundle (the functions are what this test calls). */
function uiKitStub(files: Record<string, string>): string {
  const names = new Set<string>(["WzProvider", "AppShell", "sdkDataSource"]);
  for (const src of Object.values(files))
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@wizard\/ui-kit"/g))
      for (const n of (m[1] ?? "").split(",")) names.add(n.replace(/^\s*type\s+/, "").trim());
  names.delete("");
  const dir = join(root, `ui-kit-stub-${randomBytes(3).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.ts");
  writeFileSync(file, [...names].map((n) => `export const ${n} = (_p: unknown) => null;`).join("\n"));
  return file;
}

interface Shop {
  slug: string;
  schema: string;
  send(method: string, path: string, body?: unknown, cookie?: string): Promise<Response>;
  /** Cookie of the owner (dev login). */
  owner: string;
  consent: { policyVersion: string; textHash: string };
}

/** Builds, migrates and serves a compiled shop on the runtime (draft). */
async function deploy(r: CompileSuccess): Promise<Shop> {
  const key = randomBytes(6).toString("hex");
  const slug = `shop${key.slice(0, 6)}`;
  const built = await buildSystem({
    spec: r.spec,
    files: new Map(Object.entries(r.files)),
    env: "draft",
    hostModules: { uiKit: uiKitStub(r.files) },
  });
  if (!built.ok) throw new Error(JSON.stringify(built.errors).slice(0, 2000));
  const written = writeArtifact(join(root, "artifacts"), key, 1, built);
  await migrateSystem(db, { systemId: key, env: "draft", spec: r.spec, runtimeRole: role });
  const schema = schemaName(key, "draft");
  schemas.push(schema);
  systems.list.push({
    systemId: key,
    slug,
    env: "draft",
    revision: 1,
    specHash: written.manifest.specHash,
    bundleKey: written.bundleKey,
    publishedAt: new Date().toISOString(),
    suspended: false,
    features: { phoneOtp: false },
  });
  const host = `${slug}--draft.localhost:4100`;
  const send = (method: string, path: string, body?: unknown, cookie?: string) => {
    const headers: Record<string, string> = { host };
    if (cookie) headers.cookie = cookie;
    if (method !== "GET") {
      headers.origin = `http://${host}`;
      headers["x-wizard-request"] = "1";
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    return rt.fetch(
      new Request(`http://127.0.0.1:4100${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  };
  const login = await send("GET", "/_wizard/dev-login?role=owner");
  if (login.status !== 302) throw new Error(`dev-login: ${login.status}`);
  const owner = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
  const info = complianceInfo(r.spec);
  return {
    slug,
    schema,
    send,
    owner,
    consent: { policyVersion: info.policyVersion, textHash: info.consentTextHash },
  };
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

async function created(s: Shop, entity: string, data: Record<string, unknown>): Promise<string> {
  const res = await s.send("POST", `/api/data/${entity}`, data, s.owner);
  const body = await json(res);
  if (res.status !== 201) throw new Error(`${entity}: ${res.status} ${JSON.stringify(body)}`);
  return (body.item as { id: string }).id;
}

const secret = () => randomBytes(24).toString("hex");

/** shopPlaceOrder as a visitor without login (with the consent to the personal data processing). */
async function order(
  s: Shop,
  args: Record<string, unknown>,
): Promise<{
  status: number;
  result?: { id: string; number: number; token: string; total: number; pay: boolean };
  code?: string;
}> {
  const res = await s.send("POST", `/api/fn/${SHOP_FUNCTIONS.place}`, { args, _consent: s.consent });
  const body = await json(res);
  if (res.status === 200) return { status: 200, result: body.result as never };
  return { status: res.status, code: (body.error as { code?: string } | undefined)?.code ?? "" };
}

const rows = async (s: Shop, entity: string) =>
  (await db.unsafe(`select * from ${quoteIdent(s.schema)}.${quoteIdent(entity)}`)) as unknown as Record<
    string,
    unknown
  >[];

describe("runtime: orders, the stock, the payment by the buyer's secret", () => {
  let shop: Shop;
  let point: string;
  beforeAll(async () => {
    shop = await deploy(compiled(plan(DEFAULT)));
    point = await created(shop, "pickup_point", { name: "Склад", address: "ул. Складская, 1", active: true });
  }, 240_000);

  test("an order takes the server's prices and writes the stock off; the visitor cannot read orders", async () => {
    const product = await created(shop, "product", { name: "Свеча", price: 1200, stock: 5, active: true });
    const token = secret();
    const r = await order(shop, {
      lines: [{ product, qty: 2 }],
      delivery: "pickup",
      pickupPoint: point,
      name: "Покупатель",
      phone: "8 (900) 123-45-67",
      email: "buyer@example.ru",
      token,
      // A price from the page is not an argument of the function: the server's price stands.
      price: 1,
    } as Record<string, unknown>);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    const ok = await order(shop, {
      lines: [{ product, qty: 2 }],
      delivery: "pickup",
      pickupPoint: point,
      name: "Покупатель",
      phone: "8 (900) 123-45-67",
      email: "buyer@example.ru",
      token,
    });
    expect(ok.status).toBe(200);
    expect(ok.result).toMatchObject({ total: 2400, pay: true, token });
    const o = (await rows(shop, "shop_order")).find((x) => x.id === ok.result?.id);
    expect(o).toMatchObject({ status: "awaiting_payment", phone: "+79001234567", delivery: "pickup" });
    expect(Number(o?.total)).toBe(2400);
    const p = (await rows(shop, "product")).find((x) => x.id === product);
    expect(Number(p?.stock)).toBe(3);
    expect((await rows(shop, "stock_move")).filter((m) => m.product === product)).toMatchObject([
      { qty: "-2", kind: "sale", shop_order: ok.result?.id },
    ]);
    // The visitor reads neither orders nor their payments; his order's page is the function by its secret.
    expect((await shop.send("GET", "/api/data/shop_order")).status).toBeGreaterThanOrEqual(400);
    const page = await shop.send("POST", `/api/fn/${SHOP_FUNCTIONS.order}`, {
      args: { id: ok.result?.id, token },
    });
    const view = (await json(page)).result as Record<string, unknown>;
    expect(view).toMatchObject({
      status: "awaiting_payment",
      statusLabel: "Ждёт оплаты",
      payable: true,
      total: 2400,
    });
    expect(JSON.stringify(view)).not.toMatch(/Покупатель|79001234567|buyer@/);
    const wrong = await shop.send("POST", `/api/fn/${SHOP_FUNCTIONS.order}`, {
      args: { id: ok.result?.id, token: secret() },
    });
    expect((await json(wrong)).result).toBeNull();
  }, 60_000);

  test("parallel orders of the last 3 pieces: exactly 3 pass, the others are refused, the stock never goes below 0", async () => {
    const product = await created(shop, "product", { name: "Последние", price: 500, stock: 3, active: true });
    const attempt = async (i: number) => {
      // Like the checkout page: a conflict of concurrent orders is tried again.
      for (let k = 0; k < 8; k++) {
        const r = await order(shop, {
          lines: [{ product, qty: 1 }],
          delivery: "pickup",
          pickupPoint: point,
          name: `Покупатель ${i}`,
          phone: `+7900000${String(1000 + i)}`,
          token: secret(),
        });
        if (r.status === 200 || r.code !== "CONFLICT") return r;
        await new Promise((res) => setTimeout(res, 20 + Math.floor(Math.random() * 80)));
      }
      return { status: 409, code: "CONFLICT" };
    };
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => attempt(i)));
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(3);
    expect(results.filter((r) => r.status !== 200).every((r) => r.code === "OUT_OF_STOCK")).toBe(true);
    expect(Number((await rows(shop, "product")).find((x) => x.id === product)?.stock)).toBe(0);
    const moves = (await rows(shop, "stock_move")).filter((m) => m.product === product);
    expect(moves.reduce((s, m) => s + Number(m.qty), 0)).toBe(-3);
    const numbers = (await rows(shop, "shop_order")).map((o) => Number(o.number));
    expect(new Set(numbers).size).toBe(numbers.length);
  }, 120_000);

  test("the payment of a visitor's order needs his secret; the draft's mock confirms it, the journal has it", async () => {
    const product = await created(shop, "product", { name: "Мыло", price: 700, stock: 2, active: true });
    const token = secret();
    const r = await order(shop, {
      lines: [{ product, qty: 1 }],
      delivery: "pickup",
      pickupPoint: point,
      name: "Покупатель",
      phone: "+79005554433",
      token,
    });
    const id = r.result?.id as string;
    const pay = (body: Record<string, unknown>) =>
      shop.send("POST", `/api/pay/${SHOP_PAYMENT.integration}`, {
        binding: SHOP_PAYMENT.binding,
        id,
        ...body,
      });
    expect((await pay({})).status).toBe(404);
    expect((await pay({ token: secret() })).status).toBe(404);
    const started = await pay({ token });
    expect(started.status).toBe(200);
    const url = String((await json(started)).confirmationUrl);
    expect(url).toBe(`/_wizard/pay-mock?binding=order&id=${encodeURIComponent(id)}&t=${token}`);
    expect((await shop.send("GET", url)).status).toBe(200);
    expect((await shop.send("GET", url.replace(token, secret()))).status).toBe(404);
    const confirm = await shop.send("POST", "/_wizard/pay-mock", { binding: "order", id, token });
    expect(confirm.status).toBe(200);
    expect((await json(confirm)).returnUrl).toBe(`/order/${id}`);
    expect((await rows(shop, "shop_order")).find((x) => x.id === id)?.status).toBe("paid");
    expect((await rows(shop, "shop_payment")).filter((p) => p.shop_order === id)).toMatchObject([
      { kind: "payment", status: "succeeded" },
    ]);
  }, 60_000);

  test("an unpaid order is cancelled when its time to pay is over; its goods are back in stock once", async () => {
    const product = await created(shop, "product", { name: "Ваза", price: 900, stock: 4, active: true });
    const r = await order(shop, {
      lines: [{ product, qty: 3 }],
      delivery: "pickup",
      pickupPoint: point,
      name: "Покупатель",
      phone: "+79006667788",
      token: secret(),
    });
    const id = r.result?.id as string;
    expect(Number((await rows(shop, "product")).find((x) => x.id === product)?.stock)).toBe(1);
    const until = Date.parse(String((await rows(shop, "shop_order")).find((x) => x.id === id)?.pay_until));
    const run = (at: number) => rt.runJobs({ slug: shop.slug, env: "draft", now: new Date(at) });
    await run(until + 60_000);
    await run(until + 120_000);
    await run(until + 180_000);
    expect((await rows(shop, "shop_order")).find((x) => x.id === id)).toMatchObject({
      status: "canceled",
      stock_returned: true,
    });
    expect(Number((await rows(shop, "product")).find((x) => x.id === product)?.stock)).toBe(4);
    const moves = (await rows(shop, "stock_move")).filter((m) => m.shop_order === id);
    expect(moves.map((m) => [m.kind, Number(m.qty)]).sort()).toEqual([
      ["return", 3],
      ["sale", -3],
    ]);
  }, 60_000);
});
