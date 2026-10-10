// V3-23 on the pilot: the shop's payment through the founder's ЮKassa test shop, end to end. The owner enters the
// shop's keys through the platform's key window (secret://yookassa_shop_id, secret://yookassa_secret_key — the window's
// only recipient is api.yookassa.ru; the value is encrypted here as the page does it: seal() mirrors
// apps/platform-web/src/screens/v3/keys/seal.ts), then a visitor buys on the draft's preview: the shop → «В корзину» →
// the cart's checkout (self-pickup, else the courier) → the ЮKassa payment page (a test card of the ЮKassa docs) → back
// to the order's page, which asks the runtime to re-read the payment (connectors/yookassa.yaml#return_check) until the
// order is paid. A draft with test_ keys pays through the real API (the mock stays only without keys). Keys come from
// the env of the eval step (secrets YOUKASSA_TEST_API_KEY + YOUKASSA_TEST_SHOP_ID, or the pair YOOKASSA_TEST_*), never
// reach a line of the report, and a live key is refused before anything is sent.

const WINDOW_VERSION = "wz-key-window/v1";
const WINDOW_ALG = "ECDH-ES+HKDF-SHA256+A256GCM";
/** The ЮKassa docs' test card that pays without 3-D Secure. */
export const TEST_CARD = { number: "5555555555554477", exp: "1230", cvc: "123" };

/**
 * The test shop's pair from the env: YOOKASSA_TEST_SHOP_ID / YOUKASSA_TEST_SHOP_ID and YOOKASSA_TEST_SECRET_KEY, or the
 * single YOUKASSA_TEST_API_KEY («<shopId>:<key>» or the key alone). → {shop, secret} | {refused} | null (no shop).
 */
export function kassaFromEnv(env = process.env) {
  const get = (n) => String(env[n] ?? "").trim();
  let shop = get("YOOKASSA_TEST_SHOP_ID") || get("YOUKASSA_TEST_SHOP_ID");
  let secret = get("YOOKASSA_TEST_SECRET_KEY");
  const one = get("YOUKASSA_TEST_API_KEY");
  if (one && (!shop || !secret)) {
    const m = /^(\d{3,12})\s*[:;\s]\s*(\S+)$/.exec(one);
    if (m) {
      shop ||= m[1];
      secret ||= m[2];
    } else if (!/\s/.test(one)) secret ||= one;
  }
  if (!shop && !secret) return null;
  if (!shop || !secret) return { refused: "нет пары shopId и секретного ключа тестового магазина ЮKassa" };
  if (!/^\d{3,12}$/.test(shop)) return { refused: "shopId тестового магазина ЮKassa — не число" };
  if (!secret.startsWith("test_"))
    return { refused: "ключ ЮKassa не тестовый (должен начинаться с test_) — с боевым ключом проверка не запускается" };
  return { shop, secret };
}

const utf8 = (s) => new TextEncoder().encode(s);
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

/** The ciphertext of `value` for a key window ({id, publicKey, context}) — the body of POST …/submit. */
export async function seal(w, value) {
  const subtle = globalThis.crypto.subtle;
  const curve = { name: "ECDH", namedCurve: "P-256" };
  const eph = await subtle.generateKey(curve, true, ["deriveBits"]);
  const pub = await subtle.importKey("jwk", { ...w.publicKey, ext: true }, curve, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: pub }, eph.privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8(w.id), info: utf8(`${WINDOW_VERSION}|${w.context}`) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(w.context) }, key, utf8(value));
  const epk = await subtle.exportKey("jwk", eph.publicKey);
  return {
    v: 1,
    alg: WINDOW_ALG,
    epk: { kty: "EC", crv: "P-256", x: epk.x, y: epk.y },
    iv: b64url(iv),
    ct: b64url(new Uint8Array(ct)),
  };
}

/**
 * The owner enters the shop's ЮKassa keys through the key windows of the needed connector keys. → {status, keys, message}
 * where status is «filled» | «no_payment» (the system takes no online payment) | «failed». Never throws.
 */
export async function fillShopKeys(client, systemId, kassa, say = () => {}) {
  try {
    const list = (await client.get(`/systems/${systemId}/secrets`)).body;
    const need = (list?.needed ?? []).filter((n) => n.connector?.id === "yookassa");
    if (need.length === 0) return { status: "no_payment", keys: [] };
    const keys = [];
    for (const n of need) {
      if (!n.present) {
        const value = /_shop_id$/.test(n.name) ? kassa.shop : kassa.secret;
        const open = (await client.post(`/systems/${systemId}/secret-windows`, { name: n.name })).body;
        const w = (await client.get(`/systems/${systemId}/secret-windows/${open.window.id}`)).body.window;
        const r = (await client.post(`/systems/${systemId}/secret-windows/${w.id}/submit`, await seal(w, value))).body;
        if (!r?.saved) return { status: "failed", keys, message: String(r?.message_ru ?? "ключ не сохранён") };
      }
      keys.push(n.name);
    }
    say(`владелец ввёл ключи тестового магазина ЮKassa через окно ключа: ${keys.join(", ")}`);
    return { status: "filled", keys };
  } catch (e) {
    return { status: "failed", keys: [], message: String(e?.message ?? e).slice(0, 300) };
  }
}

const sel = (id) => `[data-testid="${id}"]`;

/** Types into the field wz-field-<name> of the checkout (input or textarea) when it is there. */
async function setField(page, name, value) {
  const f = page.locator(`${sel(`wz-field-${name}`)} input, ${sel(`wz-field-${name}`)} textarea`).first();
  if ((await f.count()) === 0) return false;
  await f.fill(value);
  return true;
}

/**
 * A visitor buys on the draft's preview and pays on the ЮKassa test page. → {status: «paid» | «failed», steps:[{step,
 * ok, note}], orderStatus}. `launch` gives a Playwright browser. Never throws.
 */
export async function payShopOrder({ client, systemId, launch, say = () => {}, timeoutMs = 90_000 }) {
  const steps = [];
  const step = (s, ok, note = "") => {
    steps.push({ step: s, ok, ...(note ? { note: String(note).slice(0, 300) } : {}) });
    say(`оплата: ${s}${ok ? "" : ` — не прошло${note ? `: ${String(note).slice(0, 160)}` : ""}`}`);
    return ok;
  };
  let browser;
  let page;
  /** The failed step with where the visitor stood: the page's path and the first visible alert or error text. */
  const fail = async (s, note = "") => {
    let where = "";
    try {
      const u = new URL(page.url());
      // Every visible error text on the page: alerts, field errors (…-err) and the fields marked invalid.
      const alert = await page
        .evaluate(() => {
          const out = [];
          for (const el of document.querySelectorAll('[role="alert"], [id$="-err"], [data-testid$="-error"]')) {
            const t = (el.textContent || "").trim();
            if (t && !out.includes(t)) out.push(t);
          }
          for (const el of document.querySelectorAll('[aria-invalid="true"]'))
            out.push(`поле с ошибкой: ${el.getAttribute("name") || el.id || el.tagName.toLowerCase()}`);
          return out.join(" | ");
        })
        .catch(() => "");
      where = `${u.host}${u.pathname}${alert ? ` · «${alert.trim().slice(0, 300)}»` : ""}`;
    } catch {}
    step(s, false, [note, where].filter(Boolean).join(" · "));
    return { status: "failed", steps };
  };
  try {
    const link = (await client.get(`/systems/${systemId}/preview-url`)).body;
    if (!link?.url) return { status: "failed", steps: [step("ссылка на превью", false, "не получена")] };
    browser = await launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ru-RU" });
    page = await context.newPage();
    await page.goto(link.url, { waitUntil: "load", timeout: 30_000 });
    const origin = new URL(page.url()).origin;
    await page.goto(`${origin}/shop`, { waitUntil: "load", timeout: 30_000 });
    const add = page.locator(`${sel("wz-product")} ${sel("wz-cart-add")}:not([disabled])`).first();
    try {
      await add.waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      return await fail("товар в каталоге с кнопкой «В корзину»");
    }
    await add.click();
    step("посетитель положил товар в корзину", true);
    await page.goto(`${origin}/cart`, { waitUntil: "load", timeout: 30_000 });
    const form = page.locator(`${sel("wz-checkout-submit")}`).first();
    if (!(await form.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false)))
      return await fail("корзина с кнопкой оформления заказа");
    const pickupSelect = page.locator(`${sel("wz-field-pickup_point")} select`).first();
    const pickupRadio = page.locator(`${sel("wz-field-pickup_point")} input[type="radio"]`).first();
    const delivery = page.locator(`${sel("wz-field-delivery")} input[value="pickup"]`).first();
    if ((await delivery.count()) > 0) await delivery.check({ force: true });
    if ((await pickupSelect.count()) > 0) {
      const value = await pickupSelect
        .locator("option")
        .evaluateAll((os) => os.map((o) => o.value).find((v) => v) ?? "");
      if (value) await pickupSelect.selectOption(value);
    } else if ((await pickupRadio.count()) > 0) await pickupRadio.check({ force: true });
    else await setField(page, "address", "г. Казань, ул. Тестовая, д. 1, кв. 2");
    await setField(page, "name", "Тестовый покупатель");
    await setField(page, "phone", "+79001234567");
    await setField(page, "email", "pay-check@example.com");
    const consent = page.locator(`${sel("wz-consent")} input[type="checkbox"]`).first();
    if ((await consent.count()) > 0) await consent.check({ force: true });
    await form.click();
    const toKassa = await page
      .waitForURL((u) => /(^|\.)(yoomoney|yookassa)\.ru$/.test(u.hostname), { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!toKassa) return await fail("переход на страницу оплаты ЮKassa");
    step("заказ оформлен, открылась страница оплаты ЮKassa", true);
    // The test page: the bank card (a choice of methods may come first), the card's fields, «Заплатить».
    const card = page.getByText(/Банковская карта/i).first();
    if ((await card.count()) > 0) await card.click().catch(() => {});
    const num = page.locator('input[autocomplete="cc-number"], input[name*="number" i]').first();
    if (!(await num.waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false)))
      return await fail("поле номера карты на странице оплаты");
    await num.fill(TEST_CARD.number);
    const exp = page.locator('input[autocomplete="cc-exp"], input[name*="expir" i]').first();
    if ((await exp.count()) > 0) await exp.fill(TEST_CARD.exp);
    else {
      await page.locator('input[autocomplete="cc-exp-month"]').first().fill(TEST_CARD.exp.slice(0, 2));
      await page.locator('input[autocomplete="cc-exp-year"]').first().fill(TEST_CARD.exp.slice(2));
    }
    await page.locator('input[autocomplete="cc-csc"], input[name*="cvc" i], input[name*="csc" i]').first().fill(TEST_CARD.cvc);
    await page.getByRole("button", { name: /Заплатить|Оплатить/i }).first().click();
    const back = await page
      .waitForURL((u) => u.origin === origin && u.pathname.startsWith("/order/"), { timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);
    if (!back) return await fail("оплата тестовой картой и возврат на страницу заказа");
    step("оплачено тестовой картой, посетитель вернулся на страницу заказа", true);
    const status = page.locator(sel("wz-order-status")).first();
    let text = "";
    for (let i = 0; i < Math.ceil(timeoutMs / 1000); i++) {
      text = ((await status.innerText().catch(() => "")) || "").trim();
      if (/оплачен/i.test(text) && !/ждёт/i.test(text)) break;
      await page.waitForTimeout(1000);
    }
    const paid = /оплачен/i.test(text) && !/ждёт/i.test(text);
    step(`статус заказа «${text || "—"}»`, paid, paid ? "" : "заказ не стал оплаченным");
    return { status: paid ? "paid" : "failed", steps, orderStatus: text };
  } catch (e) {
    return page ? await fail("сбой проверки", e?.message ?? String(e)) : (step("сбой проверки", false, e?.message ?? e), { status: "failed", steps });
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** The shop's payment for the report: keys, then the purchase. ctx.kassa from kassaFromEnv; ctx.launch — Chromium. */
export async function shopPayment(ctx, client, systemId, say = () => {}) {
  const kassa = ctx.kassa;
  if (!kassa) return { status: "skipped", note: "нет тестового магазина ЮKassa в секретах" };
  if (kassa.refused) return { status: "refused", note: kassa.refused };
  const keys = await fillShopKeys(client, systemId, kassa, say);
  if (keys.status === "no_payment") return { status: "skipped", note: "в системе нет онлайн-оплаты" };
  if (keys.status !== "filled") return { status: "failed", keys, steps: [] };
  if (!ctx.launch) return { status: "keys_only", keys, steps: [] };
  const pay = await payShopOrder({ client, systemId, launch: ctx.launch, say });
  return { ...pay, keys };
}
