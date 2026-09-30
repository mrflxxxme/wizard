// backlog M0-22: specs/runtime/examples/bakery type-checks with tsconfig.system (sdk.md §1.1) against
// generateTypes(bakery.json), and its functions run on createTestHost with the bakery permission matrix.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { beforeAll, describe, expect, test } from "vitest";
import { generateTypes } from "../src/codegen/index.js";
import { WizardError } from "../src/index.js";
import { createTestHost, type LooseTable, type TestHost } from "../src/testing/index.js";
import { REPO_ROOT, SDK_ROOT, type SdkTarget } from "./helpers/app.js";

const BAKERY_DIR = join(REPO_ROOT, "specs/runtime/examples/bakery");
const bakery = JSON.parse(
  readFileSync(join(REPO_ROOT, "specs/appspec/examples/bakery.json"), "utf8"),
) as AppSpec;

/** Same layout as helpers/app.ts materializeApp, for the bakery sources. */
function materializeBakery(target: SdkTarget): string {
  const dir = join(SDK_ROOT, "test/.generated", `bakery-${target}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "_generated"), { recursive: true });
  cpSync(join(BAKERY_DIR, "functions"), join(dir, "functions"), { recursive: true });
  cpSync(join(BAKERY_DIR, "ui"), join(dir, "ui"), { recursive: true });
  writeFileSync(join(dir, "_generated/wizard.d.ts"), generateTypes(bakery));
  const names = new Set<string>();
  for (const f of readdirSync(join(dir, "ui"), { recursive: true, encoding: "utf8" })) {
    const src = /\.tsx?$/.test(f) ? readFileSync(join(dir, "ui", f), "utf8") : "";
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@wizard\/ui-kit"/g)) {
      for (const n of (m[1] ?? "").split(",")) names.add(n.replace(/^\s*type\s+/, "").trim());
    }
  }
  names.delete("");
  writeFileSync(
    join(dir, "ui-kit.d.ts"),
    [
      'import type { ReactNode } from "react";',
      "type Component = (props: { children?: ReactNode; [prop: string]: unknown }) => ReactNode;",
      ...[...names].sort().map((n) => `export declare const ${n}: Component;`),
      "",
    ].join("\n"),
  );
  const sdk = relative(dir, join(SDK_ROOT, target === "impl" ? "src/index.ts" : "src/sdk.d.ts"));
  const tsconfig = {
    compilerOptions: {
      strict: true,
      target: "ES2023",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2023", "DOM", "DOM.Iterable"],
      jsx: "react-jsx",
      jsxImportSource: "@wizard/sdk",
      noEmit: true,
      types: [],
      skipLibCheck: true,
      paths: { "@wizard/sdk": [sdk], "@wizard/ui-kit": ["./ui-kit.d.ts"] },
    },
    include: ["functions", "ui", "_generated"],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  return dir;
}

describe("bakery example typecheck (strict)", () => {
  test.each<SdkTarget>(["system", "impl"])(
    "functions and ui pass tsc against %s types",
    (target) => {
      const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
      const dir = materializeBakery(target);
      let out = "";
      try {
        out = execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json"), "--pretty", "false"], {
          encoding: "utf8",
        });
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string };
        out = `${err.stdout ?? ""}${err.stderr ?? ""}` || "tsc failed";
      }
      expect(out).toBe("");
    },
    60_000,
  );
});

// ---------------------------------------------------------------- functions on the test host
let functions: Record<string, unknown>;
beforeAll(async () => {
  const dir = materializeBakery("impl");
  functions = {};
  for (const f of bakery.functions ?? []) {
    functions[f.name] = ((await import(join(dir, f.file))) as { default: unknown }).default;
  }
});

const NOW = "2026-10-01T09:00:00.000Z"; // 12:00 по Москве

async function setup(capacity = 1) {
  const host = createTestHost(bakery, { functions, now: NOW, validate: false });
  const [cake, hidden] = await host.seed("product", [{ name: "Торт" }, { name: "Снят", active: false }]);
  const [w25, w15, cherry, vanilla, berries, txt, off] = await host.seed("product_option", [
    { product: cake, option_group: "weight", title: "2,5 кг", price: 5150, weight_kg: 2.5, sort_order: 2 },
    { product: cake, option_group: "weight", title: "1,5 кг", price: 3290.5, weight_kg: 1.5, sort_order: 1 },
    { product: cake, option_group: "filling", title: "Вишня–шоколад", price: 0 },
    { product: cake, option_group: "filling", title: "Ваниль", price: 200 },
    { product: cake, option_group: "decor", title: "Ягоды", price: 600 },
    { product: cake, option_group: "decor", title: "Надпись", price: 300 },
    { product: cake, option_group: "decor", title: "Золото", price: 900, active: false },
  ]);
  const [sat, sun, mon, past] = await host.seed("production_slot", [
    { slot_date: "2026-10-11", capacity },
    { slot_date: "2026-10-12", capacity: 3, closed: true },
    { slot_date: "2026-10-01", capacity: 4 },
    { slot_date: "2026-09-30", capacity: 4 },
  ]);
  const ids = { cake, hidden, w25, w15, cherry, vanilla, berries, txt, off, sat, sun, mon, past } as Record<
    string,
    string
  >;
  const acOptions = [ids.w25, ids.cherry, ids.berries, ids.txt];
  return { host, ids, acOptions };
}

type Placed = { orderId: string; number: number; total: number; prepay: number; remaining: number };

function place(host: TestHost, user: Parameters<TestHost["call"]>[2], args: Record<string, unknown>) {
  return host.call(
    "placeOrder",
    {
      fulfillment: "pickup",
      customerName: "Ирина",
      customerPhone: "+79990000000",
      inscription: "С днём рождения",
      ...args,
    },
    user,
    { consent: true },
  ) as Promise<Placed>;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WizardError) return e.code;
    throw e;
  }
  return "OK";
}

describe("calcPrice", () => {
  test("AC1: 2,5 кг + вишня–шоколад + ягоды + надпись = 6 050 ₽, предоплата 3 025 ₽ (visitor)", async () => {
    const { host, ids, acOptions } = await setup();
    const r = await host.call(
      "calcPrice",
      { productId: ids.cake, optionIds: acOptions },
      host.anonymous("visitor"),
    );
    expect(r).toMatchObject({ total: 6050, prepay: 3025, remaining: 3025, missing: [] });
    expect((r as { lines: { title: string }[] }).lines.map((l) => l.title)).toEqual([
      "2,5 кг",
      "Вишня–шоколад",
      "Ягоды",
      "Надпись",
    ]);
  });

  test("incomplete choice lists missing groups; odd kopeck goes to the prepayment", async () => {
    const { host, ids } = await setup();
    const visitor = host.anonymous("visitor");
    expect(await host.call("calcPrice", { productId: ids.cake, optionIds: [] }, visitor)).toMatchObject({
      total: 0,
      missing: ["weight", "filling"],
    });
    const r = await host.call(
      "calcPrice",
      { productId: ids.cake, optionIds: [ids.w15, ids.vanilla] },
      visitor,
    );
    expect(r).toMatchObject({ total: 3490.5, prepay: 1745.25, remaining: 1745.25, missing: [] });
    const odd = await host.call(
      "calcPrice",
      { productId: ids.cake, optionIds: [ids.w15, ids.cherry] },
      visitor,
    );
    expect(odd).toMatchObject({ total: 3290.5, prepay: 1645.25, remaining: 1645.25 });
  });

  test("foreign, inactive, duplicate or second single options are rejected; inactive product is NOT_FOUND", async () => {
    const { host, ids } = await setup();
    const visitor = host.anonymous("visitor");
    const calc = (productId: string | undefined, optionIds: (string | undefined)[]) =>
      codeOf(host.call("calcPrice", { productId, optionIds }, visitor));
    expect(await calc(ids.cake, [ids.w25, ids.off])).toBe("OPTION_INVALID");
    expect(await calc(ids.cake, [ids.w25, ids.w25])).toBe("OPTION_INVALID");
    expect(await calc(ids.cake, [ids.w25, ids.w15, ids.cherry])).toBe("OPTION_INVALID");
    expect(await calc(ids.hidden, [ids.w25])).toBe("NOT_FOUND");
  });
});

describe("placeOrder", () => {
  test("AC3: order is pending_payment with 50% prepayment; customer has no create right on cake_order", async () => {
    const { host, ids, acOptions } = await setup();
    const ira = host.createUser("customer");
    const r = await place(host, ira, { productId: ids.cake, optionIds: acOptions, slotId: ids.sat });
    expect(r).toMatchObject({ number: 1, total: 6050, prepay: 3025, remaining: 3025 });
    const [row] = host.rows("cake_order");
    expect(row).toMatchObject({
      id: r.orderId,
      customer_user: ira.id,
      total: 6050,
      prepay_amount: 3025,
      remaining_amount: 3025,
      status: "pending_payment",
      inscription: "С днём рождения",
      address: null,
    });
    expect((row as { options: { title: string }[] }).options.map((o) => o.title)).toEqual([
      "2,5 кг",
      "Вишня–шоколад",
      "Ягоды",
      "Надпись",
    ]);
    const { id: _i, created_at: _c, updated_at: _u, created_by: _b, ...fields } = row ?? {};
    const direct = host.run(ira, (db) =>
      (db.cake_order as LooseTable).insert({ ...fields, number: 99, total: 1 }),
    );
    expect(await codeOf(direct)).toBe("FORBIDDEN");
  });

  test("AC2: second order on a full day → SLOT_FULL; a stale unpaid order frees the day after 30 min", async () => {
    const { host, ids, acOptions } = await setup(1);
    const args = { productId: ids.cake, optionIds: acOptions, slotId: ids.sat };
    await place(host, host.createUser("customer"), args);
    expect(await codeOf(place(host, host.createUser("customer"), args))).toBe("SLOT_FULL");
    host.advance(31 * 60_000);
    expect((await place(host, host.createUser("customer"), args)).number).toBe(2);
  });

  test("prepaid orders keep the day busy; canceled ones free it", async () => {
    const { host, ids, acOptions } = await setup(1);
    const args = { productId: ids.cake, optionIds: acOptions, slotId: ids.sat };
    const first = await place(host, host.createUser("customer"), args);
    await host.run(host.createUser("owner"), (db) =>
      (db.cake_order as LooseTable).patch(first.orderId, { status: "prepaid" }),
    );
    host.advance(2 * 60 * 60_000);
    expect(await codeOf(place(host, host.createUser("customer"), args))).toBe("SLOT_FULL");
    await host.run(host.createUser("owner"), (db) =>
      (db.cake_order as LooseTable).patch(first.orderId, { status: "canceled" }),
    );
    expect(await codeOf(place(host, host.createUser("customer"), args))).toBe("OK");
  });

  test("10 parallel orders for a day with capacity 3 → exactly 3, numbers 1..3", async () => {
    const { host, ids, acOptions } = await setup(3);
    const codes = await Promise.all(
      Array.from({ length: 10 }, () =>
        codeOf(
          place(host, host.createUser("customer"), {
            productId: ids.cake,
            optionIds: acOptions,
            slotId: ids.sat,
          }),
        ),
      ),
    );
    expect(codes.filter((c) => c === "OK")).toHaveLength(3);
    expect(codes.filter((c) => c === "SLOT_FULL")).toHaveLength(7);
    expect(
      host
        .rows("cake_order")
        .map((o) => o.number)
        .sort(),
    ).toEqual([1, 2, 3]);
  });

  test("validation: closed day, delivery without address, missing filling, roles and consent", async () => {
    const { host, ids, acOptions } = await setup(5);
    const ira = host.createUser("customer");
    const base = { productId: ids.cake, optionIds: acOptions, slotId: ids.sat };
    expect(await codeOf(place(host, ira, { ...base, slotId: ids.sun }))).toBe("SLOT_CLOSED");
    expect(await codeOf(place(host, ira, { ...base, fulfillment: "delivery", address: "  " }))).toBe(
      "ADDRESS_REQUIRED",
    );
    expect(await codeOf(place(host, ira, { ...base, optionIds: [ids.w25] }))).toBe("OPTION_REQUIRED");
    expect(await codeOf(place(host, host.createUser("staff"), base))).toBe("FORBIDDEN");
    expect(await codeOf(place(host, host.anonymous("visitor"), base))).toBe("UNAUTHENTICATED");
    const noConsent = host.call(
      "placeOrder",
      { ...base, fulfillment: "pickup", customerName: "Ирина", customerPhone: "+79990000000" },
      ira,
    );
    expect(await codeOf(noConsent)).toBe("CONSENT_REQUIRED");
    const ok = await place(host, ira, {
      ...base,
      fulfillment: "delivery",
      address: "Казань, ул. Пушкина, 5",
    });
    expect(host.rows("cake_order").find((o) => o.id === ok.orderId)?.address).toBe("Казань, ул. Пушкина, 5");
  });

  test("AC4 + AC6: customer sees only own orders; staff sees the order without email and cannot change the sum", async () => {
    const { host, ids, acOptions } = await setup(5);
    const ira = host.createUser("customer");
    const oleg = host.createUser("customer");
    const st = host.createUser("staff");
    const { orderId } = await place(host, ira, {
      productId: ids.cake,
      optionIds: acOptions,
      slotId: ids.sat,
      customerEmail: "ira@example.test",
    });
    expect(await host.run(oleg, (db) => (db.cake_order as LooseTable).list())).toEqual([]);
    expect(await host.run(ira, (db) => (db.cake_order as LooseTable).list())).toHaveLength(1);
    const seen = await host.run(st, (db) => (db.cake_order as LooseTable).get(orderId));
    expect(seen).not.toHaveProperty("customer_email");
    expect(
      await codeOf(host.run(st, (db) => (db.cake_order as LooseTable).patch(orderId, { total: 100 }))),
    ).toBe("FIELD_READONLY");
  });
});

describe("freeSlots + status board", () => {
  test("days from today (Moscow) with load; staff moves an order across the board and the day stays busy", async () => {
    const { host, ids, acOptions } = await setup(2);
    const { orderId } = await place(host, host.createUser("customer"), {
      productId: ids.cake,
      optionIds: acOptions,
      slotId: ids.sat,
    });
    const st = host.createUser("staff");
    const slots = (await host.call("freeSlots", {}, st)) as {
      id: string;
      date: string;
      free: number;
      taken: number;
      closed: boolean;
    }[];
    expect(slots.map((s) => s.date)).toEqual(["2026-10-01", "2026-10-11", "2026-10-12"]);
    expect(slots.find((s) => s.id === ids.sat)).toMatchObject({ taken: 1, free: 1, closed: false });
    expect(slots.find((s) => s.id === ids.sun)).toMatchObject({ free: 0, closed: true });
    expect(await host.call("freeSlots", { days: 5 }, host.anonymous("visitor"))).toHaveLength(1);

    // Prepayment (the yookassa binding «prepay» sets paidStatus) → board columns prepaid → in_production → ready.
    await host.run(host.createUser("owner"), (db) =>
      (db.cake_order as LooseTable).patch(orderId, { status: "prepaid" }),
    );
    for (const status of ["in_production", "ready"]) {
      await host.run(st, (db) => (db.cake_order as LooseTable).patch(orderId, { status }));
      const board = await host.run(st, (db) =>
        (db.cake_order as LooseTable).list({ where: { slot: ids.sat, status } }),
      );
      expect(board.map((o) => o.id)).toEqual([orderId]);
    }
    host.advance(3 * 60 * 60_000);
    const later = (await host.call("freeSlots", {}, st)) as { id: string; taken: number }[];
    expect(later.find((s) => s.id === ids.sat)?.taken).toBe(1);
  });
});
