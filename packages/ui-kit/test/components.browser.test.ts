// Playwright acceptance of M0 components on the demo («форум»/«кондитерская», createMemoryDataSource), backlog M0-25.
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { forumFixture } from "../demo/fixtures.js";
import { ARTIFACTS, type DemoHarness, hasChromium, startDemo, UI_KIT_ROOT } from "./helpers/demo.js";
import { STORY_NAMES } from "./helpers/stories.js";
import { writeQrY4m } from "./helpers/y4m.js";

type DemoWindow = {
  __wzDemo: Record<
    string,
    {
      calls: { op: string; args: unknown[] }[];
      rows(e: string): Record<string, unknown>[];
      list(e: string, q?: object): { items: Record<string, unknown>[]; total: number };
      failNext(op: string, e: object): void;
    }
  >;
};
const texts = (page: Page, testid: string) => page.getByTestId(testid).allTextContents();

describe.skipIf(!hasChromium)("demo in chromium: components", () => {
  let demo: DemoHarness;
  beforeAll(async () => {
    demo = await startDemo("components");
  }, 120_000);
  afterAll(async () => demo?.close());

  test("Catalog («форум»): 3 ticket types with price and remaining; sold-out type → CTA disabled «Мест нет»", async () => {
    const page = await demo.page({ query: "story=Catalog" });
    const cards = page.getByTestId("wz-itemcard");
    await expect.poll(() => cards.count()).toBe(3);
    const prices = (await texts(page, "wz-itemcard-price")).map((t) => t.replace(/\s/g, " "));
    expect(prices).toEqual(
      ["по промокоду", "9 900 ₽", "24 900 ₽"].sort((a, b) => prices.indexOf(a) - prices.indexOf(b)),
    );
    expect(prices).toContain("9 900 ₽");
    const last = cards.last();
    expect(await last.getByTestId("wz-itemcard-remaining").textContent()).toBe("Мест нет");
    expect(await last.getByTestId("wz-itemcard-cta").isDisabled()).toBe(true);
    expect(await last.getByTestId("wz-itemcard-cta").textContent()).toContain("Мест нет");
    await cards.first().getByTestId("wz-itemcard-cta").click();
    await expect.poll(() => page.getByRole("status").first().textContent()).toContain("Выбран билет");
    await page.context().close();
  });

  test("RecordForm (speaker_application, phone pii=basic): consent unchecked; without it 0 creates; with it consent:true", async () => {
    const page = await demo.page({ query: "story=RecordForm" });
    const consent = page.getByTestId("wz-consent--recordform");
    expect(await consent.isVisible()).toBe(true);
    expect(await consent.locator("input").isChecked()).toBe(false);
    await page.getByTestId("wz-field-full_name").locator("input").fill("Мария Ким");
    await page.getByTestId("wz-field-email").locator("input").fill("maria@demo.example");
    await page.getByTestId("wz-field-phone").locator("input").fill("9005554433");
    await page.getByTestId("wz-field-topic").locator("input").fill("Склад без бумаги");
    await page.getByTestId("wz-field-abstract").locator("textarea").fill("Кейс внедрения");
    await page.getByTestId("wz-recordform-submit").click();
    expect(await consent.textContent()).toContain("Нужно согласие на обработку персональных данных");
    const creates = () =>
      page.evaluate(() =>
        (window as unknown as DemoWindow).__wzDemo.RecordForm?.calls.filter((c) => c.op === "create"),
      );
    expect(await creates()).toHaveLength(0);
    await consent.locator("input").check();
    await page.getByTestId("wz-recordform-submit").click();
    await expect.poll(() => page.getByTestId("demo-saved").isVisible()).toBe(true);
    const c = await creates();
    expect(c).toHaveLength(1);
    expect(c?.[0]?.args[1]).toEqual({ consent: true });
    expect((c?.[0]?.args[0] as Record<string, unknown> | undefined)?.phone).toBe("+79005554433");
    await page.context().close();
  });

  test("RecordForm: server VALIDATION_FAILED details.fields → error under email", async () => {
    const page = await demo.page({ query: "story=RecordForm" });
    await page.evaluate(() =>
      (window as unknown as DemoWindow).__wzDemo.RecordForm?.failNext("create", {
        code: "VALIDATION_FAILED",
        message: "Проверьте заполнение полей",
        status: 422,
        fields: [{ field: "email", code: "TAKEN", message: "Этот email уже подал заявку" }],
      }),
    );
    await page.getByTestId("wz-field-full_name").locator("input").fill("Мария Ким");
    await page.getByTestId("wz-field-email").locator("input").fill("maria@demo.example");
    await page.getByTestId("wz-field-topic").locator("input").fill("Склад");
    await page.getByTestId("wz-field-abstract").locator("textarea").fill("Кейс");
    await page.getByTestId("wz-consent--recordform").locator("input").check();
    await page.getByTestId("wz-recordform-submit").click();
    await expect
      .poll(() => page.getByTestId("wz-field-email").textContent())
      .toContain("Этот email уже подал заявку");
    await page.context().close();
  });

  test("DataTable (60 records): sort by date, enum filter, page 3 of 25 has 10 rows", async () => {
    const page = await demo.page({ query: "story=DataTable" });
    const rows = page.getByTestId("wz-datatable-row");
    await expect.poll(() => rows.count()).toBe(25);
    const dates = () => rows.locator("td:nth-child(6)").allTextContents();
    const before = await dates();
    await page.getByTestId("wz-datatable-sort-created_at").click();
    await expect.poll(dates).not.toEqual(before);
    expect(await page.locator('th[aria-sort="ascending"]').count()).toBe(1);
    await page.getByTestId("wz-datatable-page-next").click();
    await page.getByTestId("wz-datatable-page-next").click();
    await expect.poll(() => rows.count()).toBe(10);
    expect(await page.getByTestId("demo-path").textContent()).toContain("page=3");
    await page.getByTestId("wz-datatable-filter-status").selectOption("approved");
    await expect.poll(() => rows.count()).toBe(20);
    expect(new Set(await rows.locator("td:nth-child(5)").allTextContents())).toEqual(new Set(["Одобрена"]));
    await page.context().close();
  });

  test("DataTable for a role with hiddenFields [phone]: no phone column in DOM, no phone key from useList", async () => {
    const page = await demo.page({ query: "story=DataTable&role=moderator" });
    await expect.poll(() => page.getByTestId("wz-datatable-row").count()).toBe(25);
    const headers = await page.locator('[data-testid="wz-datatable"] th').allTextContents();
    expect(headers.join("|")).not.toContain("Телефон");
    expect(await page.locator('[data-label="Телефон"]').count()).toBe(0);
    const keys = await page.evaluate(() =>
      (window as unknown as DemoWindow).__wzDemo.DataTable?.list("speaker_application", {
        pageSize: 5,
      }).items.map((r) => Object.keys(r)),
    );
    for (const k of keys ?? []) expect(k).not.toContain("phone");
    await page.context().close();
  });

  test("DataTable @390px: cards, no horizontal scroll", async () => {
    const page = await demo.page({ query: "story=DataTable", viewport: { width: 390, height: 844 } });
    await expect.poll(() => page.getByTestId("wz-datatable-row").count()).toBe(25);
    expect(await page.locator('[data-testid="wz-datatable"] thead').isVisible()).toBe(false);
    expect(
      await page
        .getByTestId("wz-datatable-row")
        .first()
        .evaluate((e) => getComputedStyle(e).display),
    ).toBe("flex");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.context().close();
  });

  test("RecordCard: moderator approves → status approved; speaker does not see the action", async () => {
    const page = await demo.page({ query: "story=RecordCard" });
    const approve = page.getByTestId("wz-recordcard-action-approve");
    await expect.poll(() => approve.isVisible()).toBe(true);
    expect(await page.getByTestId("wz-recordcard-field-phone").count()).toBe(0);
    await approve.click();
    await expect
      .poll(() => page.getByTestId("wz-recordcard-field-status").textContent())
      .toContain("Одобрена");
    const status = await page.evaluate(
      () =>
        (window as unknown as DemoWindow).__wzDemo.RecordCard?.rows("speaker_application").find(
          (r) => r.id === "app_003",
        )?.status,
    );
    expect(status).toBe("approved");
    expect(await page.getByRole("status").first().textContent()).toBe("Сохранено");
    await page.context().close();

    const speaker = await demo.page({ query: "story=RecordCard&role=speaker" });
    await expect
      .poll(() => speaker.getByTestId("wz-recordcard-field-status").textContent())
      .toContain("Новая");
    expect(await speaker.getByTestId("wz-recordcard-action-approve").count()).toBe(0);
    expect(await speaker.getByTestId("wz-recordcard-action-reject").count()).toBe(0);
    await speaker.context().close();
  });

  test("StatusBoard («кондитерская»): drag «Предоплачен» → «В работе» updates status", async () => {
    const page = await demo.page({ query: "story=StatusBoard" });
    const from = page.getByTestId("wz-statusboard-column-prepaid");
    const to = page.getByTestId("wz-statusboard-column-in_production");
    await expect.poll(() => from.getByTestId("wz-statusboard-card").count()).toBe(3);
    const card = from.getByTestId("wz-statusboard-card").first();
    const id = await card.getAttribute("data-id");
    const a = await card.boundingBox();
    const b = await to.boundingBox();
    if (!a || !b) throw new Error("no boxes");
    await page.mouse.move(a.x + 20, a.y + 15);
    await page.mouse.down();
    await page.mouse.move(a.x + 60, a.y + 40, { steps: 5 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => to.locator(`[data-id="${id}"]`).count()).toBe(1);
    expect(await from.getByTestId("wz-statusboard-card").count()).toBe(2);
    const updates = await page.evaluate(() =>
      (window as unknown as DemoWindow).__wzDemo.StatusBoard?.calls
        .filter((c) => c.op === "update")
        .map((c) => c.args),
    );
    expect(updates).toEqual([[id, { status: "in_production" }, {}]]);
    await page.context().close();
  });

  test("StatusBoard: role without update — no drag, no «Перенести» menu", async () => {
    const page = await demo.page({ query: "story=StatusBoard&role=customer" });
    const col = page.getByTestId("wz-statusboard-column-prepaid");
    await expect.poll(() => col.getByTestId("wz-statusboard-card").count()).toBe(1);
    expect(await page.getByText("Перенести в…").count()).toBe(0);
    const card = col.getByTestId("wz-statusboard-card").first();
    const a = await card.boundingBox();
    const b = await page.getByTestId("wz-statusboard-column-ready").boundingBox();
    if (!a || !b) throw new Error("no boxes");
    await page.mouse.move(a.x + 20, a.y + 15);
    await page.mouse.down();
    await page.mouse.move(b.x + 40, b.y + 40, { steps: 10 });
    await page.mouse.up();
    expect(await col.getByTestId("wz-statusboard-card").count()).toBe(1);
    const updates = await page.evaluate(() =>
      (window as unknown as DemoWindow).__wzDemo.StatusBoard?.calls.filter((c) => c.op === "update"),
    );
    expect(updates).toHaveLength(0);
    await page.context().close();
  });

  test("StatusBoard: 403 from the DataSource → the card returns to its column, role=alert", async () => {
    const page = await demo.page({ query: "story=StatusBoard" });
    const from = page.getByTestId("wz-statusboard-column-prepaid");
    await expect.poll(() => from.getByTestId("wz-statusboard-card").count()).toBe(3);
    await page.evaluate(() =>
      (window as unknown as DemoWindow).__wzDemo.StatusBoard?.failNext("update", {
        code: "FORBIDDEN",
        message: "Недостаточно прав для этого действия",
        status: 403,
      }),
    );
    const card = from.getByTestId("wz-statusboard-card").first();
    const id = await card.getAttribute("data-id");
    await card.getByText("Перенести в…").click();
    await card.getByTestId("wz-statusboard-move-ready").click();
    await expect.poll(() => page.getByRole("alert").first().textContent()).toContain("Недостаточно прав");
    expect(await from.locator(`[data-id="${id}"]`).count()).toBe(1);
    expect(await page.getByTestId("wz-statusboard-column-ready").locator(`[data-id="${id}"]`).count()).toBe(
      0,
    );
    await page.context().close();
  });

  test("QrTicket: in the dark theme the QR background stays white", async () => {
    const page = await demo.page({ query: "story=QrTicket&mode=dark", colorScheme: "dark" });
    const svg = page.getByTestId("wz-qrticket-code");
    await expect.poll(() => svg.isVisible()).toBe(true);
    expect(await svg.locator("rect").evaluate((e) => getComputedStyle(e).fill)).toBe("rgb(255, 255, 255)");
    expect(await svg.locator("path").evaluate((e) => getComputedStyle(e).fill)).toBe("rgb(0, 0, 0)");
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--w-bg").trim()),
    ).toBe("#0F1115");
    const box = await svg.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(220);
    await page.context().close();
  });

  test("CabinetLayout: participant sees only own ticket; tabs switch by keyboard", async () => {
    const page = await demo.page({ query: "story=CabinetLayout" });
    await expect.poll(() => page.getByTestId("wz-datatable-row--my-tickets").count()).toBe(1);
    const tab = page.getByTestId("wz-cabinet-tab-tickets");
    await tab.focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => page.getByTestId("wz-cabinet-tab-profile").getAttribute("aria-selected"))
      .toBe("true");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      "wz-cabinet-tab-profile",
    );
    expect(await page.getByRole("tabpanel").textContent()).toContain("Имя, почта");
    await page.keyboard.press("Home");
    await expect.poll(() => tab.getAttribute("aria-selected")).toBe("true");
    await page.context().close();
  });

  test.each(STORY_NAMES)(
    "story %s: screenshots 1280/390 light/dark, scrollWidth ≤ innerWidth",
    async (story) => {
      for (const width of [1280, 390])
        for (const scheme of ["light", "dark"] as const) {
          const page = await demo.page({
            query: `story=${story}&mode=auto`,
            viewport: { width, height: width === 390 ? 844 : 800 },
            colorScheme: scheme,
          });
          await page.waitForTimeout(200);
          await page.screenshot({ path: join(ARTIFACTS, `${story}-${width}-${scheme}.png`), fullPage: true });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            `${story} ${width}`,
          ).toBe(true);
          await page.context().close();
        }
    },
  );

  describe("QrScanner with a fake camera", () => {
    const token = String(forumFixture().rows.ticket?.[0]?.qr_token);
    async function scannerPage(browser: Browser) {
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        permissions: ["camera"],
      });
      const page = await ctx.newPage();
      await page.goto(demo.url("story=QrScanner"));
      return page;
    }
    const clip = (name: string, payload: string) => {
      const p = join(UI_KIT_ROOT, "test/.generated", `${name}.y4m`);
      writeQrY4m(p, payload);
      return [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-video-capture=${p}`,
      ];
    };

    test("valid ticket → ok; the same code again → duplicate", async () => {
      const page = await scannerPage(await demo.launch(clip("qr-valid", token)));
      const result = page.getByTestId("wz-qrscanner-result");
      await expect.poll(() => result.getAttribute("data-status"), { timeout: 10_000 }).toBe("ok");
      expect(await result.textContent()).toContain("Проходите");
      expect(await result.getAttribute("role")).toBe("alert");
      await expect.poll(() => result.getAttribute("data-status"), { timeout: 10_000 }).toBe("duplicate");
      expect(await result.textContent()).toContain("Уже прошёл");
      const counters = await page.getByTestId("wz-qrscanner-counters").textContent();
      expect(counters).toMatch(/Прошли1/);
      expect(counters).toMatch(/Повторных[1-9]/);
      await page.context().close();
    }, 30_000);

    test("garbage string → invalid", async () => {
      const page = await scannerPage(await demo.launch(clip("qr-garbage", "это не билет 12345")));
      const result = page.getByTestId("wz-qrscanner-result");
      await expect.poll(() => result.getAttribute("data-status"), { timeout: 10_000 }).toBe("invalid");
      expect(await result.textContent()).toContain("Билет недействителен");
      await page.context().close();
    }, 30_000);

    test("manual entry works when the camera is unavailable", async () => {
      const page = await demo.page({ query: "story=QrScanner" });
      await page.getByTestId("wz-qrscanner-manual").getByLabel("Код билета").fill(token);
      await page.getByTestId("wz-qrscanner-check").click();
      await expect.poll(() => page.getByTestId("wz-qrscanner-result").getAttribute("data-status")).toBe("ok");
      await page.context().close();
    });
  });
});
