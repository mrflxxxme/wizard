// V3-23: the pilot's payment check — the test shop's keys from the env (a live key refused), the key window's
// encryption the platform opens, the owner's keys through the windows of the needed connector keys.
import { describe, expect, test } from "vitest";
import { newWindowKeyPair, openSealedSecret } from "../../../apps/platform-api/src/secrets-v3/crypto.js";
import { fillShopKeys, kassaFromEnv, seal, shopPayment } from "../server/v3-pay.mjs";

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
