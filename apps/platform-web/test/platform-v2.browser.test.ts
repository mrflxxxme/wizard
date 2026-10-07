// B2-33 acceptance in chromium: every platform screen except the canvas (B2-25, its own suite) and the legacy workspace
// is on the design system v2 — <html> is the v2 root (warm paper background, Inter), 390 and 1280 px × light and dark
// without horizontal scroll, a screenshot of each screen in test/artifacts/platform-*.png (CI artifact). The start
// screen follows prototype E: the first phrase creates the system and opens the canvas. Screens whose data the mock
// platform does not serve (settings, billing, /admin) get it from page.route stubs; nothing calls a model.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadCanvasFeed, loadFeed } from "./mock/server.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
// The organization of the mock platform (its /me makes the local user the owner).
const ORG = "00000000-0000-0000-0000-000000000001";
const SYS = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-10-07T09:00:00.000Z";
const LATER = "2026-10-08T09:00:00.000Z";
const BG = { light: "rgb(248, 247, 244)", dark: "rgb(27, 26, 24)" } as const;

type Json = unknown;
type Stub = [method: string, path: RegExp, body: Json | ((url: URL) => Json), status?: number];

const SYSTEM_VIEW = {
  system: {
    id: SYS,
    orgId: ORG,
    name: "Клиника «Светлая»",
    slug: "svetlaya",
    stage: "ready",
    draftRevision: 5,
    prodRevision: 5,
    prodUrl: "https://svetlaya.example",
  },
  messages: [],
};
const SPEC = {
  version: 5,
  spec: {
    roles: [
      { name: "patient", label: "Пациент", loginMethods: ["email_otp", "phone_otp"] },
      { name: "visitor", label: "Посетитель", access: "public" },
    ],
    entities: [{ name: "visit", label: "Визит", retention: { deleteAfterDays: 1825, mode: "delete" } }],
    compliance: { operator: { name: "ООО «Светлая»", contact: "privacy@svetlaya.example" } },
  },
  files: [],
  ops: [],
};

/** Data of the cabinet screens the mock platform does not serve. */
const CABINET: Stub[] = [
  ["GET", /^\/systems\/[^/]+$/, SYSTEM_VIEW],
  ["GET", /^\/systems\/[^/]+\/lock$/, { held: false }],
  ["GET", /^\/systems\/[^/]+\/revisions\/\d+$/, SPEC],
  [
    "GET",
    /^\/systems\/[^/]+\/revisions$/,
    {
      items: [
        { version: 5, summary_ru: "Напоминания за сутки и за 2 часа" },
        { version: 3, summary_ru: "Первая публикация" },
      ],
    },
  ],
  [
    "GET",
    /^\/systems\/[^/]+\/publications$/,
    {
      items: [
        { id: "p2", env: "prod", revision: 5, status: "live", createdAt: NOW },
        { id: "p1", env: "prod", revision: 3, status: "superseded", createdAt: NOW },
      ],
    },
  ],
  ["GET", /^\/systems\/[^/]+\/exports$/, { items: [] }],
  ["GET", /^\/systems\/[^/]+\/deletion-log$/, { items: [], nextCursor: null }],
  [
    "GET",
    /^\/orgs\/[^/]+\/members$/,
    {
      items: [
        { userId: "00000000-0000-4000-8000-00000000d001", email: "dev@wizard.local", role: "owner" },
        { userId: "u2", email: "anna@svetlaya.example", role: "editor" },
      ],
    },
  ],
  [
    "GET",
    /^\/orgs\/[^/]+\/invites$/,
    { items: [{ id: "i1", email: "doctor@svetlaya.example", role: "viewer", expiresAt: LATER }] },
  ],
  [
    "GET",
    /^\/orgs\/[^/]+\/settings$/,
    { ruOnly: false, t1Restricted: false, buildModelLabel: "модели в РФ" },
  ],
];

/** S-billing on a paid plan (payments on): plan, card, balance, ledger. */
const BILLING: Stub[] = [
  [
    "GET",
    /^\/orgs\/[^/]+\/usage$/,
    {
      pilot: false,
      free: false,
      builds: { limit: null, used: 0, left: null, nextAt: null },
      edits: { limit: null, used: 0, left: null, nextAt: null },
    },
  ],
  [
    "GET",
    /^\/orgs\/[^/]+$/,
    { id: ORG, name: "Клиника «Светлая»", plan: "start", cardBound: true, paymentsEnabled: true },
  ],
  [
    "GET",
    /^\/orgs\/[^/]+\/billing$/,
    {
      plan: "start",
      status: "active",
      periodEnd: "2026-11-01T00:00:00Z",
      cancelAtPeriodEnd: false,
      nextPlan: null,
      card: { last4: "4444", issuerCountry: "RU", boundAt: NOW, cardType: "MasterCard" },
      cardBinding: { status: "bound", code: null, message_ru: null },
      limits: { prodSystems: 2, members: 10, monthlyCredits: 50 },
    },
  ],
  [
    "GET",
    /^\/orgs\/[^/]+\/credits$/,
    {
      balance: 112.4,
      held: 0,
      available: 112.4,
      buckets: [
        { source: "plan_monthly", remaining: 52.4, expiresAt: "2026-11-01T00:00:00Z" },
        { source: "topup", remaining: 60, expiresAt: "2027-10-01T00:00:00Z" },
      ],
    },
  ],
  [
    "GET",
    /^\/orgs\/[^/]+\/credits\/ledger$/,
    {
      items: [
        { id: "2", kind: "grant", amount: 60, source: "topup", note_ru: "Докупка", createdAt: NOW },
        { id: "1", kind: "charge", amount: -7.6, runId: "r1", note_ru: "Сборка системы", createdAt: NOW },
      ],
      nextCursor: null,
    },
  ],
];

/** Staff console with step-up done: queue, reviews, pilot, support requests, «Запросы на развитие». */
const ADMIN: Stub[] = [
  ["GET", /^\/admin\/session$/, { isStaff: true, mfaEnrolled: true, mfaVerifiedUntil: LATER }],
  [
    "GET",
    /^\/admin\/abuse-reports$/,
    {
      items: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          systemId: SYS,
          systemName: "Клиника «Светлая»",
          category: "fraud",
          status: "new",
          slaDeadline: LATER,
          createdAt: NOW,
          url: "https://svetlaya.example/booking",
          resolvedAt: null,
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          systemId: null,
          category: "spam",
          status: "triaged",
          slaDeadline: LATER,
          createdAt: NOW,
          url: "https://shop.example/",
          resolvedAt: null,
        },
      ],
    },
  ],
  [
    "GET",
    /^\/admin\/founder-reviews$/,
    { items: [{ systemId: SYS, systemName: "Клиника «Светлая»", orgId: ORG, revision: 5, createdAt: NOW }] },
  ],
  [
    "GET",
    /^\/admin\/pilot\/readiness$/,
    {
      on: true,
      by: "founder@wizard.example",
      at: NOW,
      note: "Документы согласованы",
      checklist: [
        { id: "rkn", text: "Подано уведомление в Роскомнадзор" },
        { id: "lawyer", text: "Юрист согласовал документы" },
      ],
    },
  ],
  [
    "GET",
    /^\/admin\/pilot\/invites$/,
    {
      items: [
        {
          id: "pi1",
          email: "owner@svetlaya.example",
          orgName: "Клиника «Светлая»",
          credits: 300,
          requireFounderReview: true,
          status: "accepted",
          createdAt: NOW,
          expiresAt: LATER,
          acceptedAt: NOW,
          orgId: ORG,
        },
      ],
    },
  ],
  [
    "GET",
    /^\/admin\/pilot\/orgs$/,
    {
      month: "2026-10",
      capRub: 4000,
      items: [
        {
          id: ORG,
          name: "Клиника «Светлая»",
          plan: "pilot",
          members: 2,
          requireFounderReview: true,
          creditsAvailable: 240,
          creditsSpentMonth: 60,
          modelSpendRub: 312,
          usage: {
            pilot: true,
            free: true,
            builds: { limit: 5, used: 3, left: 2, nextAt: null },
            edits: { limit: 20, used: 5, left: 15, nextAt: null },
          },
        },
      ],
    },
  ],
  [
    "GET",
    /^\/admin\/pilot\/spend$/,
    { month: "2026-10", spentRub: 312, capRub: 4000, sharePercent: 8, warn: false, reached: false },
  ],
  [
    "GET",
    /^\/admin\/support\/requests$/,
    {
      items: [
        {
          id: "sr1",
          orgId: ORG,
          orgName: "Клиника «Светлая»",
          email: "owner@svetlaya.example",
          systemId: SYS,
          systemName: "Клиника «Светлая»",
          screen: "settings",
          text: "Хочу, чтобы напоминания приходили и в Telegram.",
          wantsTeam: true,
          createdAt: NOW,
          replyBy: LATER,
          answeredAt: null,
        },
      ],
    },
  ],
  [
    "GET",
    /^\/admin\/development-requests$/,
    {
      categories: [
        { category: "payments", last7: 3, last30: 9, total: 14, systems: 6, lastAt: NOW },
        { category: "messaging", last7: 1, last30: 4, total: 5, systems: 3, lastAt: NOW },
      ],
      items: [
        {
          id: "d1",
          category: "payments",
          quote: "Нужна оплата лечения на сайте",
          offered: "Счёт по ссылке",
          createdAt: NOW,
          orgId: ORG,
          orgName: "Клиника «Светлая»",
          systemId: SYS,
          systemName: "Клиника «Светлая»",
          email: null,
        },
      ],
    },
  ],
];

/** API stubs for one page; everything else goes to the mock platform. */
async function stubApi(page: Page, stubs: Stub[]): Promise<void> {
  await page.route("**/api/v1/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const hit = stubs.find(([m, re]) => m === route.request().method() && re.test(path));
    if (!hit) return route.fallback();
    const [, , body, status = 200] = hit;
    await route.fulfill({
      status,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(typeof body === "function" ? body(url) : body),
    });
  });
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** <html> is the v2 root: data-p-root, the warm paper background of the scheme, Inter. */
async function v2Root(page: Page): Promise<{ root: boolean; bg: string; font: string }> {
  return page.evaluate(() => {
    const html = document.documentElement;
    const cs = getComputedStyle(html);
    return { root: html.hasAttribute("data-p-root"), bg: cs.backgroundColor, font: cs.fontFamily };
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(ARTIFACTS, `platform-${name}.png`), fullPage: true });
}

interface Screen {
  name: string;
  path: string;
  /** Test id that shows the screen has its data. */
  ready: string;
  stubs?: Stub[];
  /** Click before the screenshot (a console tab). */
  click?: string;
}

const TOKEN = "t".repeat(43);
const SCREENS: Screen[] = [
  { name: "start", path: "/", ready: "start-system-card" },
  {
    name: "login",
    path: "/login",
    ready: "auth-email",
    stubs: [["GET", /^\/me$/, { code: "UNAUTHORIZED" }, 401]],
  },
  { name: "invite", path: `/invite/${TOKEN}`, ready: "invite-accept" },
  { name: "legal", path: "/legal/offer", ready: "platform-top" },
  { name: "abuse", path: "/abuse?url=https://svetlaya.example/", ready: "abuse-form" },
  { name: "welcome", path: "/welcome", ready: "welcome-free" },
  { name: "billing", path: "/billing", ready: "billing-ledger-row", stubs: BILLING },
  { name: "settings", path: `/s/${SYS}/settings`, ready: "revision-rollback", stubs: CABINET },
  { name: "admin-reports", path: "/admin", ready: "admin-report-row", stubs: ADMIN },
  {
    name: "admin-reviews",
    path: "/admin",
    ready: "admin-review-row",
    stubs: ADMIN,
    click: "admin-tab-reviews",
  },
  {
    name: "admin-pilot",
    path: "/admin",
    ready: "admin-pilot-org-row",
    stubs: ADMIN,
    click: "admin-tab-pilot",
  },
  {
    name: "admin-support",
    path: "/admin",
    ready: "admin-support-row",
    stubs: ADMIN,
    click: "admin-tab-support",
  },
  { name: "admin-gaps", path: "/admin", ready: "admin-gaps-item", stubs: ADMIN, click: "admin-tab-gaps" },
  { name: "not-found", path: "/no-such-page", ready: "not-found" },
];

const SIZES = [
  { width: 1280, height: 860 },
  { width: 390, height: 844 },
] as const;

describe.skipIf(!hasChromium)("platform screens on the design system v2 (B2-33)", () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    h = await startHarness({ feed: loadFeed("forum"), canvas: loadCanvasFeed(), eventDelayMs: 20 });
    // One system for «Ваши системы» on the start screen.
    await h.api("POST", "/systems", { prompt: "Клиника: онлайн-запись и напоминания пациентам" });
  }, 180_000);
  afterAll(async () => h?.close());

  for (const vp of SIZES)
    for (const scheme of ["light", "dark"] as const)
      test(`${vp.width}px ${scheme}: every screen on v2, no horizontal scroll, screenshots`, async () => {
        const context = await h.browser.newContext({ viewport: vp, colorScheme: scheme, locale: "ru-RU" });
        try {
          for (const sc of SCREENS) {
            const page = await context.newPage();
            if (sc.stubs) await stubApi(page, sc.stubs);
            await page.goto(`${h.origin}${sc.path}`);
            if (sc.click) {
              await page.getByTestId(sc.click).waitFor({ timeout: 10_000 });
              await page.getByTestId(sc.click).click();
            }
            await page.getByTestId(sc.ready).first().waitFor({ timeout: 10_000 });
            const root = await v2Root(page);
            expect(root.root, `${sc.name}: <html> is the v2 root`).toBe(true);
            expect(root.bg, `${sc.name}: paper background`).toBe(BG[scheme]);
            expect(root.font, `${sc.name}: Inter`).toContain("Inter");
            expect(await page.getByTestId("platform-top").isVisible(), `${sc.name}: top bar`).toBe(true);
            expect(await noHorizontalScroll(page), `${sc.name}: no horizontal scroll`).toBe(true);
            await shot(page, `${sc.name}-${vp.width}-${scheme}`);
            await page.close();
          }
        } finally {
          await context.close();
        }
      });

  test("start (prototype E): greeting and one row centred; the first phrase creates the system and opens the canvas", async () => {
    for (const vp of SIZES) {
      const page = await h.page({ viewport: vp, colorScheme: "light" });
      const row = await page.getByTestId("start-prompt").boundingBox();
      expect(row).not.toBeNull();
      if (row) {
        expect(Math.abs(row.x + row.width / 2 - vp.width / 2)).toBeLessThan(40);
        expect(row.y).toBeGreaterThan(vp.height * 0.2);
        expect(row.y).toBeLessThan(vp.height * 0.75);
      }
      expect(await page.getByTestId("start-submit").isDisabled()).toBe(true);
      // An example fills the row; Enter sends the first phrase.
      await page.getByTestId("start-template-event_registration").click();
      expect(await page.getByTestId("start-prompt").inputValue()).toContain("Мероприятие");
      await page.getByTestId("start-prompt").fill("Стоматология: онлайн-запись и напоминания пациентам");
      await page.getByTestId("start-prompt").press("Enter");
      await page.waitForURL(/\/s\/[0-9a-f-]{36}$/);
      await page.getByTestId("canvas").waitFor({ timeout: 15_000 });
      await page.getByTestId("canvas-question").waitFor({ timeout: 15_000 });
      await page.context().close();
    }
  });

  test("theme switch: dark is kept across screens and shared with the canvas; reduced motion stops animations", async () => {
    const page = await h.page({
      viewport: { width: 1280, height: 860 },
      colorScheme: "light",
      path: "/billing",
    });
    await page.getByTestId("theme-toggle").click();
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-p-theme"))).toBe("dark");
    expect(await page.evaluate(() => localStorage.getItem("wz.canvas.theme"))).toBe("dark");
    expect((await v2Root(page)).bg).toBe(BG.dark);
    await page.getByTestId("platform-nav-systems").click();
    await page.getByTestId("start-prompt").waitFor();
    expect((await v2Root(page)).bg).toBe(BG.dark);
    await page.getByTestId("theme-toggle").click();
    expect((await v2Root(page)).bg).toBe(BG.light);
    await page.context().close();

    const still = await h.page({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    await still.getByTestId("start-prompt").waitFor();
    await still.getByTestId("start-prompt").fill("Пекарня: заказы на завтра с доставкой");
    expect(await still.evaluate(() => document.getAnimations().length)).toBe(0);
    await still.context().close();
  });
});
