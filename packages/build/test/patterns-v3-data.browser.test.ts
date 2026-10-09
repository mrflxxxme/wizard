// V3-08 (browser): the module-bound patterns of the library (form, catalog, blog — needs lead, booking, catalog,
// content) on a real preview system: built by buildSystem, mounted by the system template (SdkProvider + WzProvider with
// the SDK DataSource) and served with a stand-in of the runtime data API (patterns-v3-data.ts). The interactions the
// module logic gives through the headless hooks: a lead form with consent and «sent» (by mouse and by keyboard only),
// field errors of the client and of the server, a booking of a free time, «Показать ещё» of the catalog and the blog;
// the empty, error and loading states of every data-bound pattern under the checks of the matrix (contrast, names,
// overflow, headings, touch targets). The matrix of every pattern × 4 design systems — patterns-v3.browser.test.ts.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildSystem } from "../src/index.js";
import { REAL_DESIGNS } from "./fixtures-v3.js";
import { PKG_ROOT } from "./helpers.js";
import { PREVIEW_ROWS, PREVIEW_TAKEN_PHONE, type PreviewMode } from "./patterns-v3-data.js";
import { V3_CHECKS_SCRIPT, type V3CheckResult } from "./v3-checks.js";
import { type PreviewServer, previewItems, previewSystem, servePreview } from "./v3-harness.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const DATA = PATTERNS.filter((p) => p.needs !== null);
/**
 * The client cabinet (account-*, V3-18) shows the visitor's own records only after his sign-in: the guest of the
 * preview gets the sign-in by a code (checked below); its data states — ui-kit v3-account.dom.test.ts and the goal
 * scenarios GS-visitor_cabinet-* (apps/platform-api v3-goals.browser.test.ts).
 */
const ACCOUNT = DATA.filter((p) => p.sectionType === "account");
const LISTS = DATA.filter(
  (p) =>
    (p.needs === "catalog" || p.needs === "content" || p.needs === "booking") && p.sectionType !== "account",
);
const SHOTS = join(PKG_ROOT, "test/artifacts/patterns-v3");
const MAIN = "calm_medical";
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

let browser: Browser;
const servers = new Map<string, PreviewServer>();

beforeAll(async () => {
  if (!hasChromium) return;
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch();
  await Promise.all(
    REAL_DESIGNS.map(async (f) => {
      const { spec, files } = previewSystem(f, previewItems(DATA));
      const built = await buildSystem({ spec, files, env: "prod" });
      if (!built.ok) throw new Error(`${f.id}: ${JSON.stringify(built.errors, null, 1)}`);
      servers.set(f.id, await servePreview(spec, built));
    }),
  );
}, 180_000);

afterAll(async () => {
  await browser?.close();
  for (const s of servers.values()) await s.close();
});

function server(id = MAIN): PreviewServer {
  const s = servers.get(id);
  if (!s) throw new Error(`no preview server ${id}`);
  return s;
}

/** Opens the preview; waits until every section is ready (its data loaded) unless `wait` is false. */
async function open(o: {
  design?: string;
  vp?: { width: number; height: number };
  mode?: "light" | "dark";
  api?: PreviewMode;
  wait?: boolean;
}) {
  const s = server(o.design);
  s.setMode(o.api ?? "ok");
  const ctx = await browser.newContext({
    viewport: o.vp ?? DESKTOP,
    colorScheme: o.mode ?? "light",
    reducedMotion: "reduce",
    locale: "ru-RU",
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  // Not waiting means not waiting for «load» either: the browser holds images behind the slow data requests (six
  // connections per host, one of them the SSE stream).
  if (o.wait === false) {
    await page.goto(s.url, { waitUntil: "commit" });
    return { page, errors };
  }
  await page.goto(s.url);
  await page.waitForFunction((n) => document.querySelectorAll("[data-preview]").length === n, DATA.length);
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}

async function checks(page: Page, touch: boolean): Promise<V3CheckResult> {
  await page.addScriptTag({ content: V3_CHECKS_SCRIPT });
  return page.evaluate(
    (t) =>
      (window as unknown as { __v3: { run(o: { touch: boolean }): V3CheckResult } }).__v3.run({ touch: t }),
    touch,
  );
}

const section = (page: Page, id: string): Locator => page.locator(`[data-preview="${id}"]`);
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el
      ? `${el.tagName.toLowerCase()}#${el.getAttribute("name") ?? el.textContent?.trim().slice(0, 40)}`
      : "";
  });
/** Writes of the data API since the mark, without the module-internal function calls. */
const writesSince = (mark: number) => server().writes.slice(mark);

describe.skipIf(!hasChromium)("module-bound patterns in chromium", () => {
  test("the library has data-bound form, catalog and blog sections", () => {
    expect(new Set(DATA.map((p) => p.sectionType))).toEqual(
      new Set(["form", "catalog", "blog", "article", "rubric", "account", "shop", "cart", "order"]),
    );
  });

  test("shop (V3-23): «В корзину» → the cart line → СДЭК by the city, a point, contacts, consent → the order by the module's function", async () => {
    const { page, errors } = await open({});
    const grid = section(page, "shop-grid");
    const cart = section(page, "cart-split");
    const mark = server().writes.length;
    // Stock from the data: the sold-out plate cannot be added.
    expect(await grid.getByRole("button", { name: "Тарелка десертная: нет в наличии" }).isDisabled()).toBe(
      true,
    );
    await grid.getByRole("button", { name: "В корзину: Кружка «Лес»" }).click();
    await expect
      .poll(() => grid.getByRole("status").filter({ hasText: "Добавлено в корзину" }).count())
      .toBe(1);
    // Only one piece in stock: the cart does not take a second one.
    expect(await grid.getByRole("button", { name: "В корзину: Кружка «Лес»" }).isDisabled()).toBe(true);
    await grid.getByRole("button", { name: "В корзину: Кружка «Утро»" }).click();
    const lines = cart.locator('[data-testid="wz-cart-line"]');
    await expect.poll(() => lines.count()).toBe(2);
    await cart.getByRole("button", { name: "Больше: Кружка «Утро»" }).click();
    expect(await cart.getByTestId("wz-cart-total").textContent()).toMatch(/5\s500/);
    // СДЭК: a city, the module's quote with its points, one point chosen.
    const checkout = cart.locator('[data-wz-component="ShopCheckout"]');
    await checkout.getByRole("radio", { name: /СДЭК/ }).check();
    await checkout.getByLabel("Город доставки").fill("Москва");
    await checkout.getByRole("button", { name: "Найти пункты СДЭК" }).click();
    await expect.poll(() => checkout.getByTestId("wz-cdek-quote").textContent()).toContain("390");
    await checkout.getByRole("radio", { name: /пр\. Мира/ }).check();
    expect(await checkout.getByTestId("wz-checkout-total").textContent()).toMatch(/5\s890/);
    // Without a name and the consent nothing is sent.
    await checkout.getByRole("button", { name: "Оформить и оплатить" }).click();
    await expect.poll(() => checkout.getByLabel("Имя и фамилия").getAttribute("aria-invalid")).toBe("true");
    expect(writesSince(mark)).toEqual([]);
    await checkout.getByLabel("Имя и фамилия").fill("Анна");
    await checkout.getByLabel("Телефон").fill("8 912 345-67-89");
    await checkout.getByLabel(/Я соглашаюсь на обработку/).check();
    await cart.screenshot({ path: join(SHOTS, "data-cart-split-filled.png") });
    await checkout.getByRole("button", { name: "Оформить и оплатить" }).click();
    await expect.poll(() => writesSince(mark).length).toBe(1);
    const [write] = writesSince(mark);
    expect(write?.path).toBe("/api/fn/shopPlaceOrder");
    expect(write?.body.args).toMatchObject({
      lines: [
        { product: "g02", qty: 1 },
        { product: "g01", qty: 2 },
      ],
      delivery: "cdek",
      name: "Анна",
      phone: "+79123456789",
      quote: "q_preview",
      cdekPoint: "MSK2",
    });
    const args = (write?.body.args ?? {}) as { token?: unknown };
    expect(String(args.token)).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
    expect(errors).toEqual([]);
    await page.context().close();
  }, 60_000);

  // For a design review (about two minutes): WIZARD_PATTERN_SHOTS=1. The matrix already shoots each pattern once.
  test.skipIf(!process.env.WIZARD_PATTERN_SHOTS)(
    "screenshots of every data-bound pattern in the four design systems (phone and desktop)",
    async () => {
      for (const f of REAL_DESIGNS)
        for (const [vp, mode] of [
          [PHONE, "light"],
          [DESKTOP, "dark"],
        ] as const) {
          const { page, errors } = await open({ design: f.id, vp, mode });
          expect(errors, `${f.id} ${vp.width}`).toEqual([]);
          for (const p of DATA)
            await section(page, p.id).screenshot({
              path: join(SHOTS, `data-${p.id}-${f.id}-${vp.width}-${mode}.png`),
            });
          await page.context().close();
        }
    },
    240_000,
  );

  test("lead form: fill, consent, submit → «sent» with focus; the write goes with _consent; again() → an empty form", async () => {
    const { page, errors } = await open({});
    const root = section(page, "form-inline");
    const mark = server().writes.length;
    await root.getByLabel("Имя").fill("Анна");
    await root.getByLabel("Телефон").fill("8 (912) 345-67-89");
    expect(await root.getByLabel("Телефон").inputValue()).toBe("+7 (912) 345-67-89");
    await root.getByRole("button", { name: "Отправить заявку" }).click();
    // No consent: no write, the error is under the checkbox and focus is on it.
    const consent = root.getByLabel(/Я соглашаюсь на обработку/);
    await expect.poll(() => consent.getAttribute("aria-invalid")).toBe("true");
    expect(await root.getByText("Нужно согласие на обработку персональных данных").isVisible()).toBe(true);
    expect(await consent.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(writesSince(mark)).toEqual([]);
    expect(
      await root.getByRole("link", { name: "политикой обработки персональных данных" }).getAttribute("href"),
    ).toBe("/privacy");

    await consent.check();
    await root.getByRole("button", { name: "Отправить заявку" }).click();
    const sent = root.getByRole("heading", { name: "Заявка отправлена" });
    await sent.waitFor();
    expect(await sent.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(writesSince(mark)).toEqual([
      {
        path: "/api/data/lead",
        body: { name: "Анна", phone: "+79123456789", _consent: { policyVersion: "1", textHash: "preview" } },
      },
    ]);

    await root.getByRole("button", { name: "Отправить ещё одну заявку" }).click();
    await expect.poll(() => focused(page)).toBe("input#name");
    expect(await root.getByLabel("Имя").inputValue()).toBe("");
    expect(errors).toEqual([]);
    await page.context().close();
  }, 60_000);

  test("lead form: empty fields → errors under them and focus on the first; a server field error lands on its field", async () => {
    const { page } = await open({ vp: PHONE });
    const root = section(page, "form-inline");
    await root.getByRole("button", { name: "Отправить заявку" }).click();
    await expect.poll(() => focused(page)).toBe("input#name");
    const name = root.getByLabel("Имя");
    expect(await name.getAttribute("aria-invalid")).toBe("true");
    const described = await name.getAttribute("aria-describedby");
    expect(await page.locator(`[id="${described}"]`).textContent()).toBe("Заполните поле");

    await name.fill("Анна");
    await root.getByLabel("Телефон").fill(PREVIEW_TAKEN_PHONE);
    await root.getByLabel(/Я соглашаюсь на обработку/).check();
    await root.getByRole("button", { name: "Отправить заявку" }).click();
    const phone = root.getByLabel("Телефон");
    await expect.poll(() => phone.getAttribute("aria-invalid")).toBe("true");
    const err = await phone.getAttribute("aria-describedby");
    expect(await page.locator(`[id="${err}"]`).textContent()).toBe("Заявка с этим номером уже принята");
    await expect.poll(() => focused(page)).toBe("input#phone");
    expect(await root.getByRole("heading", { name: "Заявка отправлена" }).count()).toBe(0);
    await page.context().close();
  }, 60_000);

  test("lead form by keyboard only: Tab through the fields, Space on the consent, Enter sends, focus follows", async () => {
    const { page } = await open({});
    const root = section(page, "form-inline");
    const mark = server().writes.length;
    // The sequential focus starts at the section heading (a click on text, as a reader would start).
    await root.getByRole("heading", { level: 2 }).click();
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("input#name");
    await page.keyboard.type("Пётр");
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("input#phone");
    await page.keyboard.type("9123456780");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).type)).toBe("checkbox");
    await page.keyboard.press("Space");
    await page.keyboard.press("Tab");
    // The policy link of the consent text, then the action.
    expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("/privacy");
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("button#Отправить заявку");
    await page.keyboard.press("Enter");
    await expect.poll(() => focused(page)).toBe("h3#Заявка отправлена");
    expect(writesSince(mark).map((w) => w.body)).toEqual([
      { name: "Пётр", phone: "+79123456780", _consent: { policyVersion: "1", textHash: "preview" } },
    ]);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => focused(page)).toBe("input#name");
    await page.context().close();
  }, 60_000);

  test("catalog: «Показать ещё» adds the next page; the section filter shows one section", async () => {
    const { page, errors } = await open({});
    const root = section(page, "catalog-grid");
    const cards = root.locator("li");
    expect(await cards.count()).toBe(6);
    await root.getByRole("button", { name: "Показать ещё" }).click();
    await expect.poll(() => cards.count()).toBe(12);
    await root.getByRole("button", { name: "Показать ещё" }).click();
    await expect.poll(() => cards.count()).toBe(PREVIEW_ROWS.service?.length ?? 0);
    expect(await root.getByRole("button", { name: "Показать ещё" }).count()).toBe(0);
    // Prices only from the data, formatted in rubles.
    expect(await root.getByText("2 500 ₽").count()).toBe(1);

    await root.getByRole("button", { name: "Курсы и абонементы" }).click();
    const courses = (PREVIEW_ROWS.service ?? []).filter((s) => s.category === "c_courses").map((s) => s.name);
    await expect.poll(() => root.locator("li h3").allTextContents()).toEqual(courses);
    expect(await root.getByRole("button", { name: "Курсы и абонементы" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(errors).toEqual([]);
    await page.context().close();
  }, 60_000);

  test("blog: newest first, dates in Russian, «Показать ещё» adds the next page", async () => {
    const { page } = await open({});
    const root = section(page, "blog-list");
    const rows = root.locator("li");
    expect(await rows.count()).toBe(4);
    expect(await root.locator("li h3").first().textContent()).toBe("Как подготовиться к первому занятию");
    expect(await root.locator("time").first().textContent()).toBe("30 сентября 2026 г.");
    expect(await root.locator("li a").first().getAttribute("href")).toBe("/blog/zapis-1");
    await root.getByRole("button", { name: "Показать ещё" }).click();
    await expect.poll(() => rows.count()).toBe(8);
    await page.context().close();
  }, 60_000);

  const BOOKING = DATA.filter((p) => p.needs === "booking").map((p) => p.id);
  test.each(BOOKING)(
    "%s: a service, a day, a free time, contacts with consent → «Вы записаны»; the write carries the time and _consent",
    async (id) => {
      const { page, errors } = await open({ vp: id.endsWith("strip") ? PHONE : DESKTOP });
      const root = section(page, id);
      const mark = server().writes.length;
      const steps = id === "form-booking-steps";
      const next = () => root.getByRole("button", { name: "Далее" }).click();
      if (steps) {
        // «Далее» without a choice says what is missing and stays.
        await next();
        expect(await root.getByRole("alert").textContent()).toBe("Выберите услугу");
      }
      // The service: a choice card or a list, whichever the variant has.
      const radio = root.getByRole("radio", { name: /Пробное занятие на круге/ });
      if (await radio.count()) await radio.click();
      else {
        const option = root.getByLabel("Услуга").locator("option", { hasText: "Пробное занятие на круге" });
        await root.getByLabel("Услуга").selectOption((await option.getAttribute("value")) ?? "");
      }
      if (await root.getByLabel("Специалист").count())
        await root.getByLabel("Специалист").selectOption({ index: 1 });
      if (steps) {
        await next();
        await expect.poll(() => focused(page)).toMatch(/^h3#Шаг 2 из 3/);
      }
      // A working day of its own for each variant, so the bookings of the tests never take each other's times.
      const day = BOOKING.indexOf(id) + 1;
      const days = root.locator("fieldset:has(legend:text-is('День')) button");
      if (await days.count()) await days.nth(day).click();
      else await root.getByLabel("День", { exact: true }).selectOption({ index: day });
      const times = root.locator("button[aria-pressed]").filter({ hasText: /^\d{2}:\d{2}$/ });
      await expect.poll(() => times.count()).toBeGreaterThan(0);
      const time = (await times.first().textContent()) ?? "";
      await times.first().click();
      expect(await times.first().getAttribute("aria-pressed")).toBe("true");
      if (steps) await next();
      await root.getByLabel("Имя").fill("Анна");
      await root.getByLabel("Телефон").fill("9123456789");
      await root.getByLabel(/Я соглашаюсь на обработку/).check();
      await root.screenshot({ path: join(SHOTS, `data-${id}-chosen.png`) });
      await root.getByRole("button", { name: "Записаться" }).click();
      const done = root.getByRole("heading", { name: "Вы записаны" });
      await done.waitFor();
      expect(await done.evaluate((el) => el === document.activeElement)).toBe(true);
      expect(await root.getByRole("status").textContent()).toContain(time);
      const [write] = writesSince(mark);
      expect(write?.path).toBe("/api/data/booking");
      expect(write?.body).toMatchObject({
        name: "Анна",
        phone: "+79123456789",
        consent_messages: false,
        _consent: { policyVersion: "1", textHash: "preview" },
      });
      expect(typeof write?.body.service).toBe("string");
      expect(
        Date.parse(String(write?.body.ends_at)) - Date.parse(String(write?.body.starts_at)),
      ).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      await page.context().close();
    },
    60_000,
  );

  test("booking: a time taken meanwhile — a notice, the time leaves the list, nothing is booked twice", async () => {
    const { page, errors } = await open({});
    const root = section(page, "form-booking-grid");
    await root.getByRole("radio", { name: /Разовое занятие/ }).click();
    await root.getByLabel("День", { exact: true }).selectOption({ index: BOOKING.length + 2 });
    const times = root.locator("button[aria-pressed]").filter({ hasText: /^\d{2}:\d{2}$/ });
    await expect.poll(() => times.count()).toBeGreaterThan(0);
    const time = (await times.first().textContent()) ?? "";
    const book = async () => {
      await root.getByRole("button", { name: time, exact: true }).click();
      await root.getByLabel("Имя").fill("Анна");
      await root.getByLabel("Телефон").fill("9123456789");
      await root.getByLabel(/Я соглашаюсь на обработку/).check();
      await root.getByRole("button", { name: "Записаться" }).click();
    };
    await book();
    await root.getByRole("heading", { name: "Вы записаны" }).waitFor();
    // «Записаться ещё раз»: the page still shows the time as free (its list was read before) — the runtime refuses.
    await root.getByRole("button", { name: "Записаться ещё раз" }).click();
    await expect.poll(() => focused(page)).toBe("h3#Выберите время");
    await book();
    await expect
      .poll(() => root.getByRole("alert").first().textContent())
      .toBe("Это время только что заняли — выберите другое");
    await expect.poll(() => root.getByRole("button", { name: time, exact: true }).count()).toBe(0);
    expect(await root.getByRole("heading", { name: "Вы записаны" }).count()).toBe(0);
    expect(errors.filter((e) => !/status of 409/.test(e))).toEqual([]);
    await page.context().close();
  }, 60_000);

  test.each([
    ["empty", PHONE],
    ["empty", DESKTOP],
    ["error", PHONE],
    ["error", DESKTOP],
  ] as const)(
    "%s data at %o: every data-bound pattern says so calmly and passes the checks",
    async (api, vp) => {
      const { page, errors } = await open({ api, vp, mode: vp === PHONE ? "dark" : "light" });
      const r = await checks(page, vp === PHONE);
      expect({ scroll: r.scroll, problems: r.result }).toEqual({ scroll: 0, problems: {} });
      for (const p of LISTS) {
        const root = section(page, p.id);
        if (api === "error") expect(await root.getByRole("alert").count(), p.id).toBeGreaterThan(0);
        else {
          const said = (await root.textContent()) ?? "";
          expect(said, p.id).toMatch(/скоро появятся|пока нет|нет услуг/i);
        }
      }
      for (const p of ACCOUNT) {
        const signIn = section(page, p.id).getByRole("link", { name: "Войти по коду" });
        expect(await signIn.getAttribute("href"), p.id).toMatch(/^\/login\?/);
      }
      // The runtime's 500 answers are logged by the browser; nothing else may be.
      expect(errors.filter((e) => !/status of 500/.test(e))).toEqual([]);
      await page.context().close();
    },
    60_000,
  );

  test("loading: every list-bound pattern shows its loading state (aria-busy, a status text), then its data", async () => {
    const { page } = await open({ api: "slow", wait: false });
    await page.waitForFunction(() => document.querySelectorAll("[data-preview-wait]").length > 0);
    // One look at the whole page while the data is on its way.
    const states = await page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll("[data-preview-wait]")].map((root) => [
          root.getAttribute("data-preview-wait"),
          {
            busy: root.querySelector("[aria-busy=true]") !== null,
            status: root.querySelector("[role=status]")?.textContent ?? "",
          },
        ]),
      ),
    );
    for (const p of LISTS)
      expect(states[p.id], p.id).toEqual({ busy: true, status: expect.stringMatching(/^Загружаем/) });
    await page.waitForFunction((n) => document.querySelectorAll("[data-preview]").length === n, DATA.length);
    server().setMode("ok");
    await page.context().close();
  }, 60_000);
});
