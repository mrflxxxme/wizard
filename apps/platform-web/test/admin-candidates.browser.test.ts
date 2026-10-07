// B2-26 acceptance in chromium: /admin «Кандидаты в модули» on the design system v2 at 390 and 1280 px (light and
// dark) — the v2 root, no horizontal page scroll (the rating table scrolls inside its frame), screenshots in
// test/artifacts/platform-admin-candidates-*.png; the founder opens a candidate, approves it, picks the catalog module
// and confirms «Модуль готов» (the API stub records the decisions). Data comes from page.route stubs; no model is
// called.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadFeed } from "./mock/server.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
const AT = "2026-10-12T06:17:00.000Z";
const LATER = "2026-10-12T22:00:00.000Z";
const SYS = "33333333-3333-4333-8333-333333333333";
const C1 = "44444444-4444-4444-8444-444444444444";
const BG = { light: "rgb(248, 247, 244)", dark: "rgb(27, 26, 24)" } as const;
const SIZES = [
  { width: 1280, height: 860 },
  { width: 390, height: 844 },
] as const;

const base = {
  key: "subscriptions:абоне занят",
  category: "subscriptions",
  moduleId: null,
  moduleName: null,
  weekCustom: 0,
  totalCustom: 0,
  lastSeenAt: AT,
  computedAt: AT,
  note: null,
  decidedAt: null,
  readyAt: null,
  suggested: null,
};
const ITEMS = [
  {
    ...base,
    id: C1,
    title: "Абонементы на занятия с переносом и заморозкой по болезни",
    status: "new",
    rank: 1,
    weekRequests: 3,
    totalRequests: 4,
    systems: 4,
    clients: 3,
    examples: [
      {
        quote: "Хочу продавать абонементы на занятия и замораживать их, если клиент заболел",
        source: "request",
      },
      { quote: "Абонементы на занятия", source: "request" },
    ],
    suggested: { id: "packages", name: "Абонементы и пакеты", status: "ready" },
  },
  {
    ...base,
    id: "55555555-5555-4555-8555-555555555555",
    key: "other:кальк стоим",
    category: "other",
    title: "Калькулятор стоимости ремонта по площади",
    status: "approved",
    rank: 2,
    weekRequests: 1,
    weekCustom: 2,
    totalRequests: 1,
    totalCustom: 2,
    systems: 3,
    clients: 3,
    examples: [{ quote: "Калькулятор стоимости: считает цену ремонта по площади", source: "custom" }],
  },
  {
    ...base,
    id: "66666666-6666-4666-8666-666666666666",
    key: "messaging:sms",
    category: "messaging",
    title: "SMS-напоминания",
    status: "new",
    rank: 3,
    weekRequests: 1,
    totalRequests: 7,
    systems: 6,
    clients: 5,
    examples: [{ quote: "SMS-напоминания", source: "request" }],
  },
];
const MODULES = [
  {
    id: "packages",
    name: "Абонементы и пакеты",
    summary: "Продажа пакетов визитов",
    status: "ready",
    available: true,
  },
  { id: "online_pay", name: "Онлайн-оплата", summary: "Оплата картой", status: "draft", available: false },
];

/** Stubs of the staff console with a stateful candidate (decisions change it). */
async function stubAdmin(page: Page, decisions: unknown[]): Promise<void> {
  let current: Record<string, unknown> = { ...ITEMS[0] };
  const card = () => ({
    candidate: current,
    notified: current.status === "ready" ? 2 : 0,
    requests: [
      {
        id: "r1",
        quote: "Хочу продавать абонементы на занятия и замораживать их, если клиент заболел",
        status: current.status === "ready" ? "done" : "open",
        createdAt: AT,
        doneAt: current.status === "ready" ? AT : null,
        systemId: SYS,
        systemName: "Студия йоги «Прана»",
      },
    ],
  });
  await page.route("**/api/v1/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = route.request().method();
    const reply = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(body),
      });
    if (method === "GET" && path === "/admin/session")
      return reply({ isStaff: true, mfaEnrolled: true, mfaVerifiedUntil: LATER });
    if (method === "GET" && path === "/admin/abuse-reports") return reply({ items: [] });
    if (method === "GET" && path === "/admin/module-candidates")
      return reply({ computedAt: AT, items: [current, ...ITEMS.slice(1)], modules: MODULES });
    if (method === "GET" && path === `/admin/module-candidates/${C1}`) return reply(card());
    if (method === "POST" && path === `/admin/module-candidates/${C1}/decision`) {
      const body = route.request().postDataJSON() as { action: string; moduleId?: string };
      decisions.push(body);
      const status =
        body.action === "approve" ? "approved" : body.action === "disable" ? "disabled" : "ready";
      current = {
        ...current,
        status,
        moduleId: body.moduleId ?? null,
        moduleName: body.moduleId === "packages" ? "Абонементы и пакеты" : null,
      };
      return reply({
        candidate: current,
        announced: status === "ready" ? { done: 4, sent: 2, noConsent: 1, failed: 0 } : null,
      });
    }
    return route.fallback();
  });
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(ARTIFACTS, `platform-${name}.png`), fullPage: true });
}

describe.skipIf(!hasChromium)("/admin «Кандидаты в модули» in the browser (B2-26)", () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    h = await startHarness({ feed: loadFeed("forum"), eventDelayMs: 20 });
  }, 180_000);
  afterAll(async () => h?.close());

  for (const vp of SIZES)
    for (const scheme of ["light", "dark"] as const)
      test(`${vp.width}px ${scheme}: rating and card on v2, no horizontal scroll; approve and «Модуль готов»`, async () => {
        const context = await h.browser.newContext({ viewport: vp, colorScheme: scheme, locale: "ru-RU" });
        try {
          const page = await context.newPage();
          const decisions: unknown[] = [];
          await stubAdmin(page, decisions);
          await page.goto(`${h.origin}/admin?tab=candidates`);
          await page.getByTestId("admin-candidate-row").first().waitFor({ timeout: 10_000 });
          const root = await page.evaluate(() => ({
            root: document.documentElement.hasAttribute("data-p-root"),
            bg: getComputedStyle(document.documentElement).backgroundColor,
            font: getComputedStyle(document.documentElement).fontFamily,
          }));
          expect(root.root).toBe(true);
          expect(root.bg).toBe(BG[scheme]);
          expect(root.font).toContain("Inter");
          expect(await page.getByTestId("admin-tab-candidates").getAttribute("aria-pressed")).toBe("true");
          expect(await page.getByTestId("admin-candidate-row").count()).toBe(3);
          expect(await noHorizontalScroll(page)).toBe(true);
          await shot(page, `admin-candidates-${vp.width}-${scheme}`);

          await page.getByTestId("admin-candidate-open").first().click();
          await page.getByTestId("admin-candidate-card").waitFor();
          expect(await page.getByTestId("admin-candidate-suggested").textContent()).toContain(
            "Абонементы и пакеты",
          );
          expect(await noHorizontalScroll(page)).toBe(true);
          // Buttons fit the screen (no clipped action on a phone).
          for (const id of ["admin-candidate-approve", "admin-candidate-ready", "admin-candidate-disable"]) {
            const box = await page.getByTestId(id).boundingBox();
            expect(box, id).not.toBeNull();
            if (box) expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
          }
          await shot(page, `admin-candidate-card-${vp.width}-${scheme}`);

          await page.getByTestId("admin-candidate-approve").click();
          await page.locator('[data-testid="admin-candidate-card"][data-status="approved"]').waitFor();
          await page.getByTestId("admin-candidate-module").selectOption("packages");
          await page.getByTestId("admin-candidate-ready").click();
          await page.getByTestId("admin-candidate-ready-confirm").waitFor();
          await page.getByTestId("admin-candidate-ready").click();
          await page.locator('[data-testid="admin-candidate-card"][data-status="ready"]').waitFor();
          expect(await page.getByTestId("admin-candidate-notice").textContent()).toContain(
            "Писем отправлено: 2",
          );
          expect(decisions).toEqual([
            { action: "approve", note: "" },
            { action: "ready", moduleId: "packages", note: "" },
          ]);
          expect(await noHorizontalScroll(page)).toBe(true);
          await page.close();
        } finally {
          await context.close();
        }
      });
});
