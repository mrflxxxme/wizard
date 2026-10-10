// V3-23: the pilot's payment check — the test shop's keys from the env (a live key refused), the key window's
// encryption the platform opens, the owner's keys through the windows of the needed connector keys.
import { describe, expect, test } from "vitest";
import { newWindowKeyPair, openSealedSecret } from "../../../apps/platform-api/src/secrets-v3/crypto.js";
import {
  CARD_FIELDS,
  CARD_METHOD_RE,
  findButton,
  findCardField,
  fillShopKeys,
  kassaDiagnostics,
  kassaFromEnv,
  payShopOrder,
  seal,
  shopPayment,
  THREE_DS_CODE,
  typeCardField,
} from "../server/v3-pay.mjs";

describe("kassaFromEnv", () => {
  test("the founder's two secrets, the single «shopId:key», the separate pair; a live key or half a pair refused", () => {
    expect(kassaFromEnv({ YOUKASSA_TEST_API_KEY: "test_abc", YOUKASSA_TEST_SHOP_ID: " 506751 " })).toEqual({
      shop: "506751",
      secret: "test_abc",
    });
    expect(kassaFromEnv({ YOUKASSA_TEST_API_KEY: "506751:test_abc" })).toEqual({ shop: "506751", secret: "test_abc" });
    expect(kassaFromEnv({ YOOKASSA_TEST_SHOP_ID: "1234", YOOKASSA_TEST_SECRET_KEY: "test_x" })).toEqual({
      shop: "1234",
      secret: "test_x",
    });
    expect(kassaFromEnv({})).toBeNull();
    expect(kassaFromEnv({ YOUKASSA_TEST_API_KEY: "live_abc", YOUKASSA_TEST_SHOP_ID: "506751" })).toMatchObject({
      refused: expect.stringContaining("не тестовый"),
    });
    expect(kassaFromEnv({ YOUKASSA_TEST_API_KEY: "test_abc" })).toMatchObject({ refused: expect.any(String) });
  });
});

describe("seal", () => {
  test("the platform opens what the eval sealed for a window", async () => {
    const pair = await newWindowKeyPair();
    const w = { id: "0b8f7c2e-1111-4222-8333-944445555666", publicKey: pair.publicKey, context: "ctx|draft|key" };
    const sealed = await seal(w, "test_secret_value");
    expect(JSON.stringify(sealed).includes("test_secret_value")).toBe(false);
    expect(await openSealedSecret(pair.privatePkcs8, sealed, w.id, w.context)).toBe("test_secret_value");
  });
});

/** A fake platform client: the needed connector keys, windows and submits it was given. */
function fakeClient(needed: { name: string; present: boolean; connector?: { id: string } }[]) {
  const submits: { name: string; body: unknown }[] = [];
  const windows = new Map<string, string>();
  const client = {
    async get(path: string) {
      if (path.endsWith("/secrets")) return { status: 200, body: { needed } };
      const id = path.split("/").at(-1) as string;
      const pair = await newWindowKeyPair();
      return { status: 200, body: { window: { id, publicKey: pair.publicKey, context: `c|${windows.get(id)}` } } };
    },
    async post(path: string, body: Record<string, unknown>) {
      if (path.endsWith("/secret-windows")) {
        const id = `w-${body.name}`;
        windows.set(id, String(body.name));
        return { status: 201, body: { window: { id } } };
      }
      const id = path.split("/").at(-2) as string;
      submits.push({ name: windows.get(id) as string, body });
      return { status: 200, body: { saved: true } };
    },
  };
  return { client, submits };
}

describe("fillShopKeys and shopPayment", () => {
  test("both ЮKassa keys go through their windows sealed; present keys are not asked again", async () => {
    const { client, submits } = fakeClient([
      { name: "yookassa_shop_id", present: false, connector: { id: "yookassa" } },
      { name: "yookassa_secret_key", present: true, connector: { id: "yookassa" } },
      { name: "crm_key", present: false },
    ]);
    const r = await fillShopKeys(client, "sys", { shop: "506751", secret: "test_abc" });
    expect(r).toEqual({ status: "filled", keys: ["yookassa_shop_id", "yookassa_secret_key"] });
    expect(submits.map((s) => s.name)).toEqual(["yookassa_shop_id"]);
    expect(JSON.stringify(submits).includes("506751")).toBe(false);
  });

  test("no online payment → skipped; no shop in the env → skipped; a live key → refused; no browser → keys only", async () => {
    const none = fakeClient([{ name: "crm_key", present: false }]).client;
    expect(await shopPayment({ kassa: { shop: "1", secret: "test_x" } }, none, "sys")).toMatchObject({
      status: "skipped",
    });
    expect(await shopPayment({ kassa: null }, none, "sys")).toMatchObject({ status: "skipped" });
    expect(await shopPayment({ kassa: { refused: "нет" } }, none, "sys")).toMatchObject({ status: "refused" });
    const shop = fakeClient([{ name: "yookassa_shop_id", present: false, connector: { id: "yookassa" } }]).client;
    expect(await shopPayment({ kassa: { shop: "1234", secret: "test_x" } }, shop, "sys")).toMatchObject({
      status: "keys_only",
    });
  });
});

/** A fake Playwright page: the catalog has no product, an alert explains why. */
function fakeBrowser() {
  let url = "about:blank";
  const loc = (q: string) => {
    const self = {
      first: () => self,
      locator: () => self,
      async waitFor() {
        throw new Error("timeout");
      },
      async count() {
        return 0;
      },
      async innerText() {
        if (q.includes("alert")) return "Товары скоро появятся";
        throw new Error("no element");
      },
    };
    return self;
  };
  const page = {
    async goto(u: string) {
      url = u;
    },
    url: () => url,
    locator: loc,
    async evaluate() {
      return "Товары скоро появятся";
    },
    on() {},
  };
  return {
    async newContext() {
      return { newPage: async () => page };
    },
    async close() {},
  };
}

describe("payShopOrder", () => {
  test("a failed step is recorded with its reason: the page and the visible alert, never a bare false", async () => {
    const client = { get: async () => ({ status: 200, body: { url: "https://shop-x.preview.example/" } }) };
    const r = await payShopOrder({ client, systemId: "sys", launch: async () => fakeBrowser(), timeoutMs: 1000 });
    expect(r.status).toBe("failed");
    expect(r.steps).toEqual([
      {
        step: "товар в каталоге с кнопкой «В корзину»",
        ok: false,
        note: "shop-x.preview.example/shop · «Товары скоро появятся»",
      },
    ]);
  });

  test("the ЮKassa page: card fields in any frame; the method by any wording; diagnostics name frames and marks only", async () => {
    const frame = (url: string, visible: string[], marks: string) => ({
      url: () => url,
      locator: (css: string) => ({
        first: () => ({ isVisible: async () => visible.some((v) => css.includes(v)) }),
      }),
      evaluate: async () => marks,
    });
    const page = {
      frames: () => [
        frame("https://yoomoney.ru/checkout/payments/v2/contract?orderId=1", [], "input[hidden] кнопки: Картой / SberPay"),
        frame("https://yoomoney.ru/checkout/card-frame", ['autocomplete="cc-number"'], "input[tel|cardNumber|cc-number]"),
      ],
      waitForTimeout: async () => {},
    };
    expect(await findCardField(page, CARD_FIELDS.number, 0)).not.toBeNull();
    expect(await findCardField(page, CARD_FIELDS.cvc, 0)).toBeNull();
    expect(CARD_METHOD_RE.test("Банковской картой")).toBe(true);
    expect(CARD_METHOD_RE.test("Картой")).toBe(true);
    expect(CARD_METHOD_RE.test(" Новая карта ")).toBe(true);
    // The test page's note above the methods is not a method (it took the click on 10.10.2026).
    expect(CARD_METHOD_RE.test("Можно заплатить тестовой картой или кошельком — ваши деньги при этом не спишутся.")).toBe(
      false,
    );
    expect(await kassaDiagnostics(page)).toBe(
      "фрейм 0 yoomoney.ru/checkout/payments/v2/contract: input[hidden] кнопки: Картой / SberPay ‖ фрейм 1 yoomoney.ru/checkout/card-frame: input[tel|cardNumber|cc-number]",
    );
  });

  // Final measurement 10.10.2026: the card was in the form, «Заплатить» did not take it and the 3-D Secure step typed
  // the code into the CVC (a password field) — values are typed and checked, the code field is never a card field.
  test("card values typed and checked; the pay button only when enabled; the 3-D Secure code never in the CVC", async () => {
    const masked = (keep: (v: string) => string) => {
      let value = "";
      return {
        click: async () => {},
        fill: async (v: string) => {
          value = keep(v);
        },
        pressSequentially: async (v: string) => {
          value = v.replace(/\D/g, "").replace(/(\d{4})(?=\d)/g, "$1 ");
        },
        inputValue: async () => value,
      };
    };
    // A masked field formats the digits («5555 5555 …»): the digits count, not the spaces.
    expect(await typeCardField(masked(() => ""), "5555555555554444")).toBe(true);
    // A field that keeps nothing typed is reported, not trusted.
    const dead = { ...masked(() => ""), pressSequentially: async () => {} };
    expect(await typeCardField(dead, "123")).toBe(false);
    const button = (visible: boolean, enabled: boolean) => ({
      first: () => ({ isVisible: async () => visible, isEnabled: async () => enabled }),
    });
    const frames = (enabled: boolean) => ({
      frames: () => [{ getByRole: () => button(true, enabled) }],
      waitForTimeout: async () => {},
    });
    expect(await findButton(frames(false), /Заплатить/, 0)).toBeNull();
    expect(await findButton(frames(true), /Заплатить/, 0)).not.toBeNull();
    const code = THREE_DS_CODE.join(", ");
    expect(code).toContain(':not([name*="cvc" i])');
    expect(code).toContain(':not([autocomplete^="cc-"])');
    expect(CARD_FIELDS.cvc.some((c) => code.includes(c))).toBe(false);
  });
});
