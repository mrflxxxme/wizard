// M2-03 acceptance in Chromium on the «форум» built with the real ui-kit and served by the runtime over HTTP:
// the scanner page is an installable PWA (manifest + service worker), context.setOffline(true) → 100 scans are
// queued (and survive an offline reload from the worker's shell), setOffline(false) → the queue is synced,
// the server holds 100 offline check-ins without duplicates, a repeat of the same QR is rejected.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { type Browser, chromium, type Page } from "@playwright/test";
import { signQrToken } from "@wizard/connectors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { forumSpec, seedRow, seedUser } from "./helpers.js";
import { type PreviewFixture, previewFixture } from "./preview-helpers.js";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync("/opt/pw-browsers")) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";
}
const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const N = 100;
let fx: PreviewFixture;
let server: ReturnType<typeof serve>;
let browser: Browser;
let origin = "";
let schema = "";
const tickets: { id: string; token: string }[] = [];

describe.skipIf(!hasChromium)("QrScanner offline on the forum (PWA, runtime, Chromium)", () => {
  beforeAll(async () => {
    fx = await previewFixture();
    const entry = await fx.publish({
      slug: "qrpwa",
      env: "draft",
      revision: 1,
      migrate: true,
      realUiKit: true,
    });
    schema = `app_${entry.systemId}_draft`;
    const spec = forumSpec();
    const stream = await seedRow(fx.sql, schema, spec, "stream", { name: "Технологии" });
    const type = await seedRow(fx.sql, schema, spec, "ticket_type", { name: "Стандарт" });
    const holder = await seedUser(fx.sql, schema, "participant");
    const rows = Array.from({ length: N }, (_, i) => ({
      id: randomUUID(),
      ticket_type: type,
      stream,
      holder_user: holder,
      holder_name: "Анна Тестова",
      holder_email: `guest${i}@example.ru`,
      status: "paid",
      amount: 4900,
      event_starts_at: "2026-11-01T09:00:00.000Z",
      qr_token: signQrToken(fx.ring, { systemId: entry.systemId, env: "draft" }),
    }));
    await fx.sql`insert into ${fx.sql(schema)}.${fx.sql("ticket")} ${fx.sql(rows)}`;
    tickets.push(...rows.map((r) => ({ id: r.id, token: r.qr_token })));
    server = serve({ fetch: (req) => fx.rt.fetch(req), port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((r) => server.once("listening", () => r()));
    origin = `http://qrpwa--draft.localhost:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await fx?.close();
  });

  const status = (page: Page) => page.getByTestId("wz-qrscanner-status");
  const attr = (page: Page, testId: string, name: string) =>
    expect.poll(() => page.getByTestId(testId).getAttribute(name), { timeout: 10_000 });
  const text = (page: Page, testId: string) =>
    expect.poll(async () => (await page.getByTestId(testId).textContent()) ?? "", { timeout: 10_000 });
  async function scan(page: Page, code: string) {
    await page.getByTestId("wz-qrscanner-manual").getByLabel("Код билета").fill(code);
    await page.getByTestId("wz-qrscanner-check").click();
  }

  test("installable PWA; offline: 100 scans queued, reload from the shell; online: synced, repeat rejected", async () => {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, locale: "ru-RU" });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/_wizard/dev-login?role=volunteer&next=/scanner`);
    await expect.poll(() => status(page).getAttribute("data-tickets"), { timeout: 20_000 }).toBe(String(N));

    // Service worker active, session data warmed for an offline reload.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await expect
      .poll(() => page.evaluate(async () => (await (await caches.open("wz-data")).keys()).length), {
        timeout: 10_000,
      })
      .toBe(2);
    const cdp = await ctx.newCDPSession(page);
    const manifest = (await cdp.send("Page.getAppManifest")) as { errors: unknown[]; url: string };
    expect(manifest.url).toBe(`${origin}/manifest.webmanifest`);
    expect(manifest.errors).toEqual([]);
    const installability = (await cdp.send("Page.getInstallabilityErrors")) as {
      installabilityErrors: { errorId: string }[];
    };
    // Playwright contexts are incognito-like profiles; everything else must be clean.
    expect(
      installability.installabilityErrors.map((e) => e.errorId).filter((id) => id !== "in-incognito"),
    ).toEqual([]);

    await ctx.setOffline(true);
    await expect.poll(() => status(page).getAttribute("data-online")).toBe("false");
    for (const [i, t] of tickets.entries()) {
      await scan(page, t.token);
      await expect.poll(() => status(page).getAttribute("data-pending")).toBe(String(i + 1));
    }
    await attr(page, "wz-qrscanner-result", "data-status").toBe("queued");
    await text(page, "wz-qrscanner-result").toContain("Принято офлайн");
    await scan(page, tickets[0]?.token ?? "");
    await attr(page, "wz-qrscanner-result", "data-status").toBe("duplicate");
    await text(page, "wz-qrscanner-result").toContain("Повторный вход");
    await text(page, "wz-qrscanner-status").toBe(
      `● Нет сети · ${N} билетов в памяти · ${N} отметок ждут синхронизации`,
    );
    const before = await fx.sql`select count(*)::int as n from ${fx.sql(schema)}.${fx.sql("checkin")}`;
    expect(before[0]?.n).toBe(0);

    // Offline reload: the shell, RoleSpec and the session come from the worker, the queue from IndexedDB.
    await page.reload();
    await expect.poll(() => status(page).getAttribute("data-pending"), { timeout: 15_000 }).toBe(String(N));
    await attr(page, "wz-qrscanner-status", "data-tickets").toBe(String(N));

    await ctx.setOffline(false);
    await expect.poll(() => status(page).getAttribute("data-pending"), { timeout: 20_000 }).toBe("0");
    const rows = await fx.sql`
      select c.ticket, c.offline, c.gate from ${fx.sql(schema)}.${fx.sql("checkin")} as c`;
    expect(rows).toHaveLength(N);
    expect(new Set(rows.map((r) => String(r.ticket))).size).toBe(N);
    expect(rows.every((r) => r.offline === true && r.gate === "Вход А")).toBe(true);

    await scan(page, tickets[5]?.token ?? "");
    await attr(page, "wz-qrscanner-result", "data-status").toBe("duplicate");
    await text(page, "wz-qrscanner-result").toContain("Уже прошёл");
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);
});
