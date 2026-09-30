// M0-22 smoke: bakery.json + specs/runtime/examples/bakery built by @wizard/build, migrated and served by the runtime
// (WIZARD_UNSAFE_LOCAL_EXEC=1): price → order → prepayment on the draft mock page → status board → final payment.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSpec, quoteIdent } from "@wizard/appspec";
import { buildSystem, writeArtifact } from "@wizard/build";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeExecutors } from "../src/exec/host.js";
import {
  complianceInfo,
  createRuntimeApp,
  MemoryRegistry,
  migrateSystem,
  type RuntimeApp,
  schemaName,
} from "../src/index.js";
import { DB_URL, devEnv, login, newKey, repoRoot, request } from "./helpers.js";

const BAKERY = join(repoRoot, "specs/runtime/examples/bakery");
const spec = JSON.parse(
  readFileSync(join(repoRoot, "specs/appspec/examples/bakery.json"), "utf8"),
) as AppSpec;
const HOST = "sahar--draft.localhost:4100";
const info = complianceInfo(spec);
const consent = { policyVersion: info.policyVersion, textHash: info.consentTextHash };

function bakeryFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const top of ["ui", "functions"]) {
    for (const f of readdirSync(join(BAKERY, top), { recursive: true, encoding: "utf8" }).sort()) {
      if (/\.tsx?$/.test(f))
        files.set(`${top}/${f.split("\\").join("/")}`, readFileSync(join(BAKERY, top, f), "utf8"));
    }
  }
  return files;
}

function uiKitStub(files: Map<string, string>): string {
  const names = new Set<string>();
  for (const src of files.values()) {
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@wizard\/ui-kit"/g)) {
      for (const n of (m[1] ?? "").split(",")) names.add(n.replace(/^\s*type\s+/, "").trim());
    }
  }
  names.delete("");
  names.add("WzProvider"); // mounted by the client entry template
  const dir = join(import.meta.dirname, "..", ".generated", "ui-kit-stub-bakery");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.ts");
  writeFileSync(file, [...names].map((n) => `export const ${n} = (_p: unknown) => null;`).join("\n"));
  return file;
}

let sql: postgres.Sql;
let rt: RuntimeApp;
let root: string;
let role: string;
let schema: string;
const cookie: Record<string, string> = {};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "wz-rt-bakery-"));
  sql = postgres(DB_URL, { max: 6, onnotice: () => {} });
  role = `wz_rt_bakery_${newKey()}`;
  await sql.unsafe(`CREATE ROLE ${quoteIdent(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  const registry = new MemoryRegistry();
  rt = createRuntimeApp({
    db: sql,
    registry,
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    env: { ...devEnv, unsafeLocalExec: true },
  });
  const files = bakeryFiles();
  const built = await buildSystem({ spec, files, env: "draft", hostModules: { uiKit: uiKitStub(files) } });
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  const key = newKey();
  const written = writeArtifact(join(root, "artifacts"), key, 1, built);
  await migrateSystem(sql, { systemId: key, env: "draft", spec, runtimeRole: role });
  schema = schemaName(key, "draft");
  registry.list.push({
    systemId: key,
    slug: "sahar",
    env: "draft",
    revision: 1,
    specHash: written.manifest.specHash,
    bundleKey: written.bundleKey,
    publishedAt: new Date().toISOString(),
    suspended: false,
    features: { phoneOtp: false },
  });
  for (const r of ["owner", "staff", "customer"]) cookie[r] = await login(rt, HOST, r);
}, 60_000);

afterAll(async () => {
  closeExecutors();
  if (schema) await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  await sql.unsafe(`DROP OWNED BY ${quoteIdent(role)}`).catch(() => {});
  await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
  await sql.end();
  rmSync(root, { recursive: true, force: true });
});

const send = (method: string, path: string, who: string, body?: unknown) =>
  rt.fetch(request(method, HOST, path, { cookie: cookie[who], body }));

async function create(entity: string, data: Record<string, unknown>): Promise<string> {
  const res = await send("POST", `/api/data/${entity}`, "owner", data);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function fn<T>(name: string, who: string, args: unknown, withConsent = false): Promise<T> {
  const res = await send("POST", `/api/fn/${name}`, who, {
    args,
    ...(withConsent ? { _consent: consent } : {}),
  });
  const body = (await res.json()) as { result?: T; error?: { code: string } };
  if (res.status !== 200)
    throw Object.assign(new Error(body.error?.code ?? String(res.status)), { status: res.status });
  return body.result as T;
}

const statusOf = async (id: string) =>
  String(
    (await sql.unsafe(`select status from ${quoteIdent(schema)}."cake_order" where id = $1`, [id]))[0]
      ?.status,
  );

describe("bakery on the runtime", () => {
  test("order with 50% prepayment via the mock payment page, status board, final payment", async () => {
    const cake = await create("product", { name: "Торт" });
    const opt = (option_group: string, title: string, price: number, weight_kg?: number) =>
      create("product_option", {
        product: cake,
        option_group,
        title,
        price,
        ...(weight_kg ? { weight_kg } : {}),
      });
    const optionIds = [
      await opt("weight", "2,5 кг", 5150, 2.5),
      await opt("filling", "Вишня–шоколад", 0),
      await opt("decor", "Ягоды", 600),
      await opt("decor", "Надпись", 300),
    ];
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const slot = await create("production_slot", { slot_date: tomorrow, capacity: 1 });

    // AC1 through /api/fn: the price is computed by the server.
    expect(await fn("calcPrice", "customer", { productId: cake, optionIds })).toMatchObject({
      total: 6050,
      prepay: 3025,
      missing: [],
    });

    const args = {
      productId: cake,
      optionIds,
      slotId: slot,
      fulfillment: "pickup",
      customerName: "Ирина",
      customerPhone: "+79990000000",
      inscription: "С днём рождения",
    };
    await expect(fn("placeOrder", "customer", args)).rejects.toMatchObject({ status: 422 }); // CONSENT_REQUIRED
    const order = await fn<{ orderId: string; number: number }>("placeOrder", "customer", args, true);
    expect(order.number).toBe(1);
    expect(await statusOf(order.orderId)).toBe("pending_payment");
    await expect(fn("placeOrder", "customer", args, true)).rejects.toThrow("SLOT_FULL");

    // Prepayment: /api/pay → draft mock page → confirm → prepaid, payment of 3 025 ₽ succeeded.
    const pay = await send("POST", "/api/pay/yookassa", "customer", { binding: "prepay", id: order.orderId });
    expect(pay.status).toBe(200);
    const { confirmationUrl } = (await pay.json()) as { confirmationUrl: string };
    const page = await send("GET", confirmationUrl, "customer");
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/3\s025,00\s₽/);
    const ok = await send("POST", "/_wizard/pay-mock", "customer", { binding: "prepay", id: order.orderId });
    expect(await ok.json()).toEqual({ result: "applied", returnUrl: "/orders" });
    expect(await statusOf(order.orderId)).toBe("prepaid");

    // Status board as staff: the column query, then moving the card; sums are readonly, email hidden.
    const column = await send("GET", "/api/data/cake_order?filter[status]=prepaid", "staff");
    const items = ((await column.json()) as { items: Record<string, unknown>[] }).items;
    expect(items.map((o) => o.id)).toEqual([order.orderId]);
    expect(items[0]).not.toHaveProperty("customer_email");
    expect(
      (await send("PATCH", `/api/data/cake_order/${order.orderId}`, "staff", { total: 100 })).status,
    ).toBe(422);
    // runtime.yaml requires _consent for any update of a pii row by a non-admin role, even status-only
    // (ui-kit StatusBoard does not send it yet — see docs/reviews/impl-notes/M0-22.md).
    for (const status of ["in_production", "ready"]) {
      const moved = await send("PATCH", `/api/data/cake_order/${order.orderId}`, "staff", {
        status,
        _consent: consent,
      });
      expect(moved.status, JSON.stringify(await moved.clone().json())).toBe(200);
    }
    const load = await fn<{ id: string; taken: number; free: number }[]>("freeSlots", "staff", { days: 3 });
    expect(load.find((s) => s.id === slot)).toMatchObject({ taken: 1, free: 0 });

    // Final payment of the remaining 3 025 ₽ → completed; both payments recorded.
    expect(
      (await send("POST", "/api/pay/yookassa", "customer", { binding: "final", id: order.orderId })).status,
    ).toBe(200);
    const done = await send("POST", "/_wizard/pay-mock", "customer", { binding: "final", id: order.orderId });
    expect(await done.json()).toEqual({ result: "applied", returnUrl: "/orders" });
    expect(await statusOf(order.orderId)).toBe("completed");
    const payments = await sql.unsafe(
      `select amount::float8 as amount, status from ${quoteIdent(schema)}."payment" where cake_order = $1 order by created_at`,
      [order.orderId],
    );
    expect(payments).toEqual([
      { amount: 3025, status: "succeeded" },
      { amount: 3025, status: "succeeded" },
    ]);
  }, 60_000);
});
