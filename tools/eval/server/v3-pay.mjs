// V3-23 on the pilot: the shop's payment through the founder's ЮKassa test shop, end to end. The owner enters the
// shop's keys through the platform's key window (secret://yookassa_shop_id, secret://yookassa_secret_key — the window's
// only recipient is api.yookassa.ru; the value is encrypted here as the page does it: seal() mirrors
// apps/platform-web/src/screens/v3/keys/seal.ts), then a visitor buys on the draft's preview: the shop → «В корзину» →
// the cart's checkout (self-pickup, else the courier) → the ЮKassa payment page (a test card of the ЮKassa docs) → back
// to the order's page, which asks the runtime to re-read the payment (connectors/yookassa.yaml#return_check) until the
// order is paid. A draft with test_ keys pays through the real API (the mock stays only without keys). Keys come from
// the env of the eval step (secrets YOUKASSA_TEST_API_KEY + YOUKASSA_TEST_SHOP_ID, or the pair YOOKASSA_TEST_*), never
// reach a line of the report, and a live key is refused before anything is sent.

import { join } from "node:path";

const WINDOW_VERSION = "wz-key-window/v1";
const WINDOW_ALG = "ECDH-ES+HKDF-SHA256+A256GCM";
/**
 * The ЮKassa docs' test card that pays without 3-D Secure (Mastercard …4444; …4477 asks for a 3-D Secure code — the
 * table «Проверка успешных сценариев» of yookassa.ru/developers/payment-acceptance/testing-and-going-live/testing).
 */
export const TEST_CARD = { number: "5555555555554444", exp: "1230", cvc: "123" };
/** Any digits pass the test shop's 3-D Secure page (the same docs), if the card asks for it after all. */
const TEST_3DS_CODE = "123";

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

/** Card fields of the ЮKassa page by their usual marks (autocomplete, name, placeholder, aria-label), any frame. */
export const CARD_FIELDS = {
  number: [
    'input[autocomplete="cc-number"]',
    'input[name*="number" i]',
    'input[name*="pan" i]',
    'input[placeholder*="номер карты" i]',
    'input[aria-label*="номер карты" i]',
    'input[placeholder*="0000 0000" i]',
  ],
  exp: [
    'input[autocomplete="cc-exp"]',
    'input[name*="expir" i]',
    'input[name*="expdate" i]',
    'input[placeholder*="ММ/ГГ" i]',
    'input[placeholder*="MM/YY" i]',
    'input[placeholder*="ММ / ГГ" i]',
    'input[placeholder*="MM / YY" i]',
    'input[aria-label*="срок" i]',
  ],
  month: ['input[autocomplete="cc-exp-month"]', 'input[name*="month" i]', 'input[placeholder="ММ" i]', 'input[placeholder="MM" i]'],
  year: ['input[autocomplete="cc-exp-year"]', 'input[name*="year" i]', 'input[placeholder="ГГ" i]', 'input[placeholder="YY" i]'],
  cvc: [
    'input[autocomplete="cc-csc"]',
    'input[name*="cvc" i]',
    'input[name*="csc" i]',
    'input[name*="cvv" i]',
    'input[placeholder*="CVC" i]',
    'input[placeholder*="CVV" i]',
    'input[aria-label*="CVC" i]',
    'input[aria-label*="CVV" i]',
  ],
};
/** The user agent of a desktop Chrome of `version` (Playwright's browser.version(), e.g. «141.0.7390.37»). */
export const desktopUserAgent = (version) =>
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${String(version).split(".")[0]}.0.0.0 Safari/537.36`;
/**
 * The bank card among the payment methods (its wording changes between the page versions): the whole label of the
 * method, never a phrase inside a longer text — the test page's note «Можно заплатить тестовой картой…» stands above
 * the methods and took the click instead of «Новая карта» (final measurement 10.10.2026).
 */
export const CARD_METHOD_RE = /^\s*(Новая карта|Банковская карта|Банковской картой|Картой|Bank card|New card)\s*$/i;
export const PAY_BUTTON_RE = /Заплатить|Оплатить|^\s*Pay\b/i;
/**
 * The code field of a test 3-D Secure page in any frame — never a field of the card form (its CVC is a password field:
 * the final measurement of 10.10.2026 typed the code into the CVC and stayed on the form).
 */
export const THREE_DS_CODE = [
  'input[autocomplete="one-time-code"]',
  'input[name*="code" i]:not([name*="cvc" i]):not([name*="card" i])',
  'input[type="password"]:not([autocomplete^="cc-"]):not([name*="cvc" i]):not([name*="cvv" i]):not([name*="csc" i])',
];
const CONFIRM_RE = /Подтвердить|Отправить|Продолжить|Confirm|Submit/i;

/**
 * Types a card value like a person (a masked field may drop a bare fill); → whether it stuck: its digits, or as many
 * mask characters as digits (the page keeps the CVC as «•••» in the field — 11.10.2026).
 */
export async function typeCardField(field, value) {
  const want = String(value).replace(/\D/g, "");
  const stuck = async () => {
    const raw = String(await field.inputValue().catch(() => ""));
    const digits = raw.replace(/\D/g, "");
    return digits === want || (digits === "" && raw.replace(/\s/g, "").length === want.length);
  };
  await field.click().catch(() => {});
  await field.fill("").catch(() => {});
  await field.pressSequentially(String(value), { delay: 40 }).catch(() => {});
  if (await stuck()) return true;
  await field.fill(String(value)).catch(() => {});
  return stuck();
}

/** The first visible and enabled button of `re` in the page or any frame, waiting up to `ms`; null — none. */
export async function findButton(page, re, ms) {
  const until = Date.now() + ms;
  for (;;) {
    for (const frame of page.frames()) {
      const b = frame.getByRole("button", { name: re }).first();
      if ((await b.isVisible().catch(() => false)) && (await b.isEnabled().catch(() => false))) return b;
    }
    if (Date.now() >= until) return null;
    await page.waitForTimeout(500);
  }
}

/** The first visible field of `selectors` in the page or any of its frames, waiting up to `ms`; null — none. */
export async function findCardField(page, selectors, ms) {
  const css = selectors.join(", ");
  const until = Date.now() + ms;
  for (;;) {
    for (const frame of page.frames()) {
      const f = frame.locator(css).first();
      if (await f.isVisible().catch(() => false)) return f;
    }
    if (Date.now() >= until) return null;
    await page.waitForTimeout(500);
  }
}

/** What the ЮKassa page shows when a step fails: frames, inputs (marks only, never values) and buttons. */
export async function kassaDiagnostics(page) {
  const parts = [];
  for (const [i, frame] of page.frames().entries()) {
    let host = "";
    try {
      const u = new URL(frame.url());
      host = `${u.host}${u.pathname}`.slice(0, 80);
    } catch {}
    const marks = await frame
      .evaluate(() => {
        const inputs = [...document.querySelectorAll("input, select, iframe")].slice(0, 12).map((el) => {
          const a = (k) => (el.getAttribute(k) || "").slice(0, 24);
          return `${el.tagName.toLowerCase()}[${[a("type"), a("name"), a("autocomplete"), a("placeholder"), a("aria-label")].filter(Boolean).join("|")}]`;
        });
        const buttons = [...document.querySelectorAll("button, [role=button], label")]
          .map((b) => {
            const t = (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
            const off = b.disabled || b.getAttribute("aria-disabled") === "true";
            return t && off ? `${t} (неактивна)` : t;
          })
          .filter(Boolean)
          .slice(0, 8);
        // What the form says is wrong: alerts, error texts and the fields marked invalid (their names only).
        const errors = [];
        for (const el of document.querySelectorAll('[role="alert"], [class*="error" i], [aria-invalid="true"]')) {
          if (el.getClientRects().length === 0) continue;
          const t =
            el.getAttribute("aria-invalid") === "true"
              ? `поле ${el.getAttribute("name") || el.tagName.toLowerCase()}`
              : (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
          if (t && !errors.includes(t)) errors.push(t);
          if (errors.length >= 4) break;
        }
        return `${inputs.join(" ")}${buttons.length ? ` кнопки: ${buttons.join(" / ")}` : ""}${errors.length ? ` ошибки: ${errors.join(" / ")}` : ""}`;
      })
      .catch(() => "—");
    parts.push(`фрейм ${i} ${host}: ${marks}`);
  }
  return parts.join(" ‖ ").slice(0, 1400);
}

/**
 * A visitor buys on the draft's preview and pays on the ЮKassa test page. → {status: «paid» | «failed», steps:[{step,
 * ok, note}], orderStatus}. `launch` gives a Playwright browser. Never throws.
 */
export async function payShopOrder({
  client,
  systemId,
  launch,
  say = () => {},
  timeoutMs = 90_000,
  shotPath = null,
}) {
  const steps = [];
  const step = (s, ok, note = "") => {
    // The ЮKassa page's diagnostics (frames, field marks, buttons) need more room than a plain reason.
    steps.push({ step: s, ok, ...(note ? { note: String(note).slice(0, 1500) } : {}) });
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
          // Field and delivery problems of the checkout are bold small paragraphs with an icon (cart/split.tsx Problem).
          const sel = '[role="alert"], [id$="-err"], [data-testid$="-error"], form p.font-bold:has(svg)';
          for (const el of document.querySelectorAll(sel)) {
            // A hidden template (the mock page's «Оплата не прошла» waits with `hidden`) is not what the visitor sees.
            if (el.closest("[hidden]") || el.getClientRects().length === 0) continue;
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
    const net = calls.slice(-5).join("; ");
    step(s, false, [note, where, net ? `запросы: ${net}` : ""].filter(Boolean).join(" · "));
    return { status: "failed", steps };
  };
  /** The page's API calls after the checkout (method, path, status, the start of an error answer): what failed. */
  const calls = [];
  const watch = () =>
    page.on("response", async (r) => {
      try {
        const u = new URL(r.url());
        if (!u.pathname.startsWith("/api/") && !u.pathname.startsWith("/_wizard/pay")) return;
        const req = r.request();
        if (req.method() === "GET" && r.status() < 400) return;
        const body = r.status() >= 400 ? (await r.text().catch(() => "")).slice(0, 160) : "";
        calls.push(`${req.method()} ${u.pathname} ${r.status()}${body ? ` ${body}` : ""}`);
      } catch {}
    });
  try {
    const link = (await client.get(`/systems/${systemId}/preview-url`)).body;
    if (!link?.url) return { status: "failed", steps: [step("ссылка на превью", false, "не получена")] };
    // The ЮKassa page renders its form for an ordinary desktop Chrome: no automation flag, no «HeadlessChrome» in the
    // user agent (in the headless defaults the page showed only «Детали платежа», final measurement 10.10.2026). It is
    // our own payment on the founder's test shop — the check of our integration, not of the provider's protection.
    browser = await launch({ args: ["--disable-blink-features=AutomationControlled"] });
    const version = typeof browser.version === "function" ? browser.version() : "";
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "ru-RU",
      ...(version ? { userAgent: desktopUserAgent(version) } : {}),
    });
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
    if ((await delivery.count()) > 0) {
      await delivery.check({ force: true });
      // The pickup points render after the method is chosen and load from the data: wait for them (G1's driver does).
      await pickupRadio.or(pickupSelect).first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
    }
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
    watch();
    await form.click();
    const toKassa = await page
      .waitForURL((u) => /(^|\.)(yoomoney|yookassa)\.ru$/.test(u.hostname), { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    if (!toKassa) {
      // The draft's runtime had no keys of the shop (SECRET_MISSING) and opened its test page instead of ЮKassa.
      const mock = /\/_wizard\/pay-mock$/.test(new URL(page.url()).pathname);
      return await fail(
        "переход на страницу оплаты ЮKassa",
        mock ? "черновик открыл имитацию оплаты: ключи магазина не дошли до runtime" : "",
      );
    }
    step("заказ оформлен, открылась страница оплаты ЮKassa", true);
    // The test page: the bank card (a choice of methods may come first), the card's fields (often in a frame of the
    // card vault), «Заплатить». Any wording of the method and any frame; on failure — what the page had.
    const kassaFail = async (s2) => {
      const diag = await kassaDiagnostics(page);
      if (shotPath) await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
      return await fail(s2, diag);
    };
    const num = await findCardField(page, CARD_FIELDS.number, 15_000);
    if (!num) {
      const method = page.getByText(CARD_METHOD_RE).first();
      if (await method.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)) {
        const label = ((await method.innerText().catch(() => "")) || "").trim();
        await method.click().catch(() => {});
        step(`выбран способ оплаты «${label || "карта"}»`, true);
      }
    }
    const cardNumber = num ?? (await findCardField(page, CARD_FIELDS.number, 30_000));
    if (!cardNumber) return await kassaFail("поле номера карты на странице оплаты");
    // Typed like a person, each value checked: a masked field may drop a bare fill (then «Заплатить» stays off).
    const typed = [await typeCardField(cardNumber, TEST_CARD.number)];
    const exp = await findCardField(page, CARD_FIELDS.exp, 3_000);
    if (exp) typed.push(await typeCardField(exp, `${TEST_CARD.exp.slice(0, 2)}/${TEST_CARD.exp.slice(2)}`));
    else {
      const month = await findCardField(page, CARD_FIELDS.month, 3_000);
      const year = await findCardField(page, CARD_FIELDS.year, 3_000);
      if (!month || !year) return await kassaFail("поле срока действия карты");
      typed.push(await typeCardField(month, TEST_CARD.exp.slice(0, 2)));
      typed.push(await typeCardField(year, TEST_CARD.exp.slice(2)));
    }
    const cvc = await findCardField(page, CARD_FIELDS.cvc, 3_000);
    if (!cvc) return await kassaFail("поле CVC карты");
    typed.push(await typeCardField(cvc, TEST_CARD.cvc));
    // A value the field does not show back is noted, not fatal: the form's own check decides (an inactive
    // «Заплатить» or its error text below).
    if (typed.some((ok) => !ok)) step("не все значения карты видны в полях формы", true, "проверит сама форма");
    // The form as it was before «Заплатить» (next to the failure's shot): what the visitor saw filled.
    if (shotPath)
      await page.screenshot({ path: shotPath.replace(/\.png$/, "-form.png"), fullPage: true }).catch(() => {});
    const pay = await findButton(page, PAY_BUTTON_RE, 10_000);
    if (!pay) return await kassaFail("кнопка «Заплатить» активна на странице оплаты");
    await pay.click();
    step("данные тестовой карты введены, нажата «Заплатить»", true);
    const backTo = (ms) =>
      page
        .waitForURL((u) => u.origin === origin && u.pathname.startsWith("/order/"), { timeout: ms })
        .then(() => true)
        .catch(() => false);
    let back = await backTo(20_000);
    if (!back) {
      // The test 3-D Secure page (a code field and a confirm button, any frame): any digits pass.
      const code = await findCardField(page, THREE_DS_CODE, 10_000);
      if (code) {
        await typeCardField(code, TEST_3DS_CODE);
        const confirm = await findButton(page, CONFIRM_RE, 5_000);
        await confirm?.click().catch(() => {});
        step("подтверждение 3-D Secure тестовым кодом", true);
      }
      back = await backTo(timeoutMs);
    }
    if (!back) return await kassaFail("оплата тестовой картой и возврат на страницу заказа");
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
  const pay = await payShopOrder({
    client,
    systemId,
    launch: ctx.launch,
    say,
    // A failed step on the ЮKassa page leaves its screenshot next to the systems' ones (the run's artifact).
    shotPath: ctx.kassaShots ? join(ctx.kassaShots, `kassa-${systemId}.png`) : null,
  });
  return { ...pay, keys };
}
