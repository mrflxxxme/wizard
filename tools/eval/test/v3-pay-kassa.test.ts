// V3-40/V3-23: the measurement's ЮKassa automation (payOnKassa) in a real Chromium against a double of the test page
// built from what the real page showed (final measurement 10–11.10.2026: shots and diagnostics of yoomoney.ru/checkout/
// payments/v2/contract/bankcard): the note «Можно заплатить тестовой картой…» above the methods, «Новая карта» as a
// plain clickable row, the card fields card-number / expiry-month / expiry-year / security-code (password) that take
// keyboard typing only (a programmatic fill is reverted, as the real year field dropped it), the CVC shown as «•••»,
// «Заплатить N ₽» always active with «Проверьте срок действия» on a wrong date, an optional 3-D Secure page, the return
// to the shop's /order/… with «Оплачен». The double is strict on purpose (a bare fill does not stick); on it the
// split date of the real page showed the bug the real run had: the «MM/YY» selector took the month field.
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { payOnKassa } from "../server/v3-pay.mjs";

const require = createRequire(new URL("../../../packages/e2e/package.json", import.meta.url));
// biome-ignore lint/suspicious/noExplicitAny: Playwright is loaded from the e2e package at run time.
const { chromium } = require("@playwright/test") as { chromium: any };
const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

/** A field that takes keyboard typing only: keydown adds the digit, any other change of its value is reverted. */
const KEYS_ONLY = `
function keysOnly(el, max, show) {
  el.dataset.v = "";
  const render = () => { el.value = show ? show(el.dataset.v) : el.dataset.v; };
  el.addEventListener("keydown", (e) => {
    if (/^[0-9]$/.test(e.key) && el.dataset.v.length < max) { el.dataset.v += e.key; e.preventDefault(); render(); el.dispatchEvent(new Event("typed")); }
    else if (e.key === "Backspace") { el.dataset.v = el.dataset.v.slice(0, -1); e.preventDefault(); render(); }
    else if (e.key.length === 1) e.preventDefault();
  });
  el.addEventListener("input", render);
  el.addEventListener("blur", render);
}`;

const KASSA = (threeDs: boolean, brokenYear: boolean, success = false) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>ЮKassa</title></head>
<body>
<h1>Test</h1><p>3 000 ₽</p><button type="button">Детали платежа</button>
<div><b>Это тестовый платёж</b><p>Можно заплатить тестовой картой или кошельком — ваши деньги при этом не спишутся. Оплата придёт в ваш тестовый магазин.</p></div>
<div id="methods">
  <div class="m" data-m="wallet"><span>ЮMoney</span></div>
  <div class="m" data-m="purse"><span>Кошелёк</span></div>
  <div class="m" data-m="card"><span>Новая карта</span></div>
</div>
<form id="card" hidden>
  <h2>Банковская карта</h2>
  <label>Номер карты <input type="text" name="card-number" autocomplete="cc-number"></label>
  <label>Срок действия
    <input type="text" name="expiry-month" autocomplete="cc-exp-month" placeholder="ММ">
    <input type="text" name="expiry-year" autocomplete="cc-exp-year" placeholder="ГГ"></label>
  <label>Код <input type="password" name="security-code" autocomplete="cc-csc" placeholder="CVC"></label>
  <label><input type="checkbox" name="recurring"> Разрешаю автосписания</label>
  <p id="err" role="alert" hidden>Проверьте срок действия</p>
  <button type="submit">Заплатить 3 000 ₽</button>
</form>
<script>${KEYS_ONLY}
const f = document.getElementById("card");
const q = (n) => f.querySelector('[name="' + n + '"]');
document.querySelector('[data-m="card"]').addEventListener("click", () => { document.getElementById("methods").hidden = true; f.hidden = false; });
keysOnly(q("card-number"), 16, (v) => v.replace(/(\\d{4})(?=\\d)/g, "$1 "));
keysOnly(q("expiry-month"), 2);
keysOnly(q("expiry-year"), ${brokenYear ? 0 : 2});
keysOnly(q("security-code"), 3, (v) => "•".repeat(v.length));
q("expiry-month").addEventListener("typed", () => { if (q("expiry-month").dataset.v.length === 2) q("expiry-year").focus(); });
f.addEventListener("submit", (e) => {
  e.preventDefault();
  const ok = q("card-number").dataset.v === "5555555555554444" && /^(0[1-9]|1[0-2])$/.test(q("expiry-month").dataset.v)
    && /^[0-9]{2}$/.test(q("expiry-year").dataset.v) && Number(q("expiry-year").dataset.v) >= 27 && q("security-code").dataset.v.length === 3;
  const err = document.getElementById("err");
  if (!ok) { err.hidden = false; q("expiry-year").setAttribute("aria-invalid", "true"); return; }
  location.href = ${threeDs ? '"/3ds"' : success ? '"/success"' : '"/order/1"'};
});
</script></body></html>`;

const THREE_DS = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>3-D Secure</title></head><body>
<h1>Подтверждение платежа</h1><p>Введите код из СМС (тест: любой)</p>
<form id="f"><input type="text" name="code" inputmode="numeric"><button type="submit">Подтвердить</button></form>
<script>document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault();
  if (document.querySelector('[name="code"]').value.length >= 3) location.href = "/order/1"; });</script></body></html>`;

/** The test shop's success page: the payment went through, back to the shop only by its link (real page, 11.10.2026). */
const SUCCESS = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>ЮKassa</title></head><body>
<h1>Платёж прошёл</h1><button type="button">Детали платежа</button><a href="/order/1">Вернуться на сайт</a></body></html>`;

const ORDER = `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body>
<h1>Заказ № 1</h1><p data-testid="wz-order-status">Оплачен</p></body></html>`;

let server: Server;
let origin = "";
// biome-ignore lint/suspicious/noExplicitAny: a Playwright browser.
let browser: any;

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const html =
      u.pathname === "/kassa"
        ? KASSA(
            u.searchParams.get("3ds") === "1",
            u.searchParams.get("year") === "broken",
            u.searchParams.get("success") === "1",
          )
        : u.pathname === "/3ds"
          ? THREE_DS
          : u.pathname === "/success"
            ? SUCCESS
            : u.pathname.startsWith("/order/")
              ? ORDER
              : "";
    res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const a = server.address();
  origin = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  if (hasChromium) browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((ok) => server.close(() => ok()));
});

async function run(query: string) {
  const page = await browser.newPage({ locale: "ru-RU" });
  const steps: { step: string; ok: boolean; note?: string }[] = [];
  const shotPath = join(mkdtempSync(join(tmpdir(), "wz-kassa-")), "kassa.png");
  try {
    await page.goto(`${origin}/kassa?${query}`);
    const r = await payOnKassa(page, {
      origin,
      step: (step: string, ok: boolean, note = "") => {
        steps.push({ step, ok, ...(note ? { note } : {}) });
        return ok;
      },
      shotPath,
      timeoutMs: 5_000,
    });
    return { r, steps, url: page.url(), shots: shotPath };
  } finally {
    await page.close();
  }
}

describe.skipIf(!hasChromium)("payOnKassa on a double of the ЮKassa test page (real Chromium)", () => {
  test("the double is strict: a programmatic fill of a card field does not stick", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/kassa`);
      await page.getByText("Новая карта", { exact: true }).click();
      await page.locator('[name="expiry-year"]').fill("30");
      await page.locator('[name="card-number"]').click();
      expect(await page.locator('[name="expiry-year"]').inputValue()).toBe("");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("«Новая карта», the card typed like a person, «Заплатить» → the order page; shots of each step", async () => {
    const { r, steps, url, shots } = await run("3ds=0");
    expect(r, JSON.stringify(steps)).toEqual({ ok: true });
    expect(url).toBe(`${origin}/order/1`);
    expect(steps.map((s) => s.step)).toEqual([
      "выбран способ оплаты «Новая карта»",
      "данные тестовой карты введены, нажата «Заплатить»",
    ]);
    for (const suffix of ["-form", "-paid"]) expect(existsSync(shots.replace(/\.png$/, `${suffix}.png`))).toBe(true);
  }, 60_000);

  test("the success page of the test shop stays put: «Вернуться на сайт» takes the visitor to the order", async () => {
    const { r, steps, url } = await run("success=1");
    expect(r, JSON.stringify(steps)).toEqual({ ok: true });
    expect(url).toBe(`${origin}/order/1`);
    expect(steps.map((s) => s.step)).toEqual([
      "выбран способ оплаты «Новая карта»",
      "данные тестовой карты введены, нажата «Заплатить»",
      "ЮKassa приняла оплату, посетитель нажал «Вернуться на сайт»",
    ]);
  }, 90_000);

  test("a 3-D Secure page: the code goes to its own field, never to the CVC, then the order page", async () => {
    const { r, steps, url } = await run("3ds=1");
    expect(r, JSON.stringify(steps)).toEqual({ ok: true });
    expect(url).toBe(`${origin}/order/1`);
    expect(steps.map((s) => s.step)).toContain("подтверждение 3-D Secure тестовым кодом");
  }, 90_000);

  test("a form that refuses the date: the failure names the step and the form's own error, with a shot", async () => {
    const { r, steps, shots } = await run("year=broken");
    expect(r.ok).toBe(false);
    expect(r.step).toBe("оплата тестовой картой и возврат на страницу заказа");
    expect(r.note).toContain("Проверьте срок действия");
    expect(r.note).toContain("поле expiry-year");
    expect(steps.map((s) => s.step)).toContain("не все значения карты видны в полях формы");
    expect(existsSync(shots)).toBe(true);
  }, 90_000);
});
