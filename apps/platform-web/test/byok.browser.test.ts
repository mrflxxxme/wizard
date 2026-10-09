// V3-33 «Свои ключи моделей» in chromium at 390 and 1280 px: the S10 block appears only when the API says the feature
// is available, the terms modal fits the screen and traps the first focus, the key goes once in the POST body from a
// masked field and is not left in the page, no horizontal scroll; screenshots in test/artifacts/platform-byok-*.png.
// Data of S10 and /orgs/:id/byok come from page.route stubs; nothing calls a model.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadFeed } from "./mock/server.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
const ORG = "00000000-0000-0000-0000-000000000001";
const SYS = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-10-09T09:00:00.000Z";
const KEY = "sk-browser-canary-0123456789abcdef-QWER";

const CABINET: [string, RegExp, unknown][] = [
  [
    "GET",
    /^\/systems\/[^/]+$/,
    {
      system: {
        id: SYS,
        orgId: ORG,
        name: "Студия «Север»",
        slug: "sever",
        stage: "ready",
        draftRevision: 2,
        prodRevision: null,
      },
      messages: [],
    },
  ],
  ["GET", /^\/systems\/[^/]+\/lock$/, { held: false }],
  [
    "GET",
    /^\/systems\/[^/]+\/revisions\/\d+$/,
    { version: 2, spec: { roles: [], entities: [] }, files: [], ops: [] },
  ],
  ["GET", /^\/systems\/[^/]+\/revisions$/, { items: [{ version: 2, summary_ru: "Первая версия" }] }],
  ["GET", /^\/systems\/[^/]+\/publications$/, { items: [] }],
  ["GET", /^\/systems\/[^/]+\/exports$/, { items: [] }],
  ["GET", /^\/systems\/[^/]+\/deletion-log$/, { items: [], nextCursor: null }],
  [
    "GET",
    /^\/orgs\/[^/]+\/members$/,
    { items: [{ userId: "u1", email: "dev@wizard.local", role: "owner" }] },
  ],
  ["GET", /^\/orgs\/[^/]+\/invites$/, { items: [] }],
  [
    "GET",
    /^\/orgs\/[^/]+\/settings$/,
    { ruOnly: false, t1Restricted: false, buildModelLabel: "модели в РФ" },
  ],
];

/** A stateful /orgs/:id/byok of one org; `posted` keeps the bodies the page sent. */
function byokApi(available: boolean) {
  const posted: { path: string; body: string }[] = [];
  let accepted: string | null = null;
  const keys: unknown[] = [];
  const state = () =>
    available
      ? {
          available: true,
          consent: {
            version: "2026-10-09.1",
            title: "Условия подключения своих ключей моделей",
            paragraphs: [
              "Вы подключаете ключ своей учётной записи у провайдера моделей. Договор с провайдером, его условия, счета, лимиты и блокировки учётной записи — на вашей стороне.",
              "Перед отправкой по вашему ключу Wizard заменяет персональные данные заглушками.",
              "Вызовы моделей по вашему ключу не списывают кредиты.",
            ],
            acceptedAt: accepted,
          },
          providers: [
            {
              id: "zai",
              name: "Z.ai (GLM)",
              direct: true,
              location: "foreign",
              verifiedModels: ["glm-5.3"],
              suggestedModels: ["glm-5.3"],
            },
            {
              id: "openai",
              name: "OpenAI",
              direct: false,
              location: "foreign",
              verifiedModels: [],
              suggestedModels: [],
            },
          ],
          keys,
          callTypes: ["page_compose"],
        }
      : { available: false };
  return {
    posted,
    async handle(route: Route, path: string): Promise<boolean> {
      const req = route.request();
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
      if (!/^\/orgs\/[^/]+\/byok/.test(path)) return false;
      if (req.method() !== "GET") posted.push({ path, body: req.postData() ?? "" });
      if (req.method() === "GET") await json(state());
      else if (path.endsWith("/consent")) {
        accepted = NOW;
        await json(state());
      } else if (path.endsWith("/keys")) {
        const b = JSON.parse(req.postData() ?? "{}") as { provider: string; model: string; key: string };
        const key = {
          id: "11111111-1111-4111-8111-111111111111",
          provider: b.provider,
          providerName: b.provider === "zai" ? "Z.ai (GLM)" : "OpenAI",
          model: b.model,
          verified: false,
          direct: b.provider === "zai",
          gatewayHost: b.provider === "zai" ? null : "llm.my-company.example",
          last4: b.key.slice(-4),
          status: "active",
          check: { status: "ok", code: null, message_ru: null, checkedAt: NOW },
          lastUsedAt: null,
          lastErrorCode: null,
          createdAt: NOW,
        };
        keys.unshift(key);
        await json({ key }, 201);
      } else await json({ code: "NOT_FOUND", message_ru: "Не найдено" }, 404);
      return true;
    },
  };
}

async function open(h: Harness, page: Page, available: boolean) {
  const byok = byokApi(available);
  await page.route("**/api/v1/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (await byok.handle(route, path)) return;
    const hit = CABINET.find(([m, re]) => m === route.request().method() && re.test(path));
    if (!hit) return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(hit[2]),
    });
  });
  await page.goto(`${h.origin}/s/${SYS}/settings`);
  await page.getByTestId("settings-team").waitFor({ timeout: 10_000 });
  return byok;
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

describe.skipIf(!hasChromium)("S10 «Свои ключи моделей» (V3-33) in chromium", () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    h = await startHarness({ feed: loadFeed("forum"), eventDelayMs: 20 });
  }, 180_000);
  afterAll(async () => h?.close());

  test("the feature off for the org: no block", async () => {
    const page = await h.page({ viewport: { width: 1280, height: 860 } });
    await open(h, page, false);
    await page.waitForTimeout(300);
    expect(await page.getByTestId("settings-byok").count()).toBe(0);
    await page.context().close();
  });

  for (const vp of [
    { width: 1280, height: 860 },
    { width: 390, height: 844 },
  ])
    test(`${vp.width}px: terms modal, masked key, the key sent once and not left in the page`, async () => {
      const page = await h.page({ viewport: vp, colorScheme: "light" });
      const byok = await open(h, page, true);
      const block = page.getByTestId("settings-byok");
      await block.waitFor({ timeout: 10_000 });
      expect(await block.getByRole("heading", { name: "Свои ключи моделей" }).isVisible()).toBe(true);
      expect(await noHorizontalScroll(page)).toBe(true);

      await page.getByTestId("byok-consent-open").click();
      const dialog = page.getByRole("dialog", { name: "Условия подключения своих ключей моделей" });
      await dialog.waitFor();
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
      }
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
        "byok-consent-check",
      );
      // After the «rise» entrance of the dialog (0.5 s).
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(ARTIFACTS, `platform-byok-terms-${vp.width}.png`) });
      expect(await page.getByTestId("byok-consent-yes").isDisabled()).toBe(true);
      await page.getByTestId("byok-consent-check").check();
      await page.getByTestId("byok-consent-yes").click();
      await page.getByTestId("byok-consent-accepted").waitFor();

      await page.getByTestId("byok-provider").selectOption("openai");
      await page.getByTestId("byok-gateway").fill("https://llm.my-company.example/v1");
      await page.getByTestId("byok-model").fill("gpt-x-pro");
      expect(await page.getByTestId("byok-key-input").getAttribute("type")).toBe("password");
      await page.getByTestId("byok-key-input").fill(KEY);
      expect(await noHorizontalScroll(page)).toBe(true);
      await page.getByTestId("byok-add-submit").click();
      await page.getByTestId("byok-key").waitFor();
      expect(await page.getByTestId("byok-key-last4").textContent()).toBe("•••• QWER");
      expect(await page.getByTestId("byok-unverified").isVisible()).toBe(true);
      expect(await page.getByTestId("byok-key-input").inputValue()).toBe("");
      // The key went once, in the body of POST …/keys; the page keeps nothing of it.
      const withKey = byok.posted.filter((p) => p.body.includes(KEY));
      expect(withKey.map((p) => p.path)).toEqual([`/orgs/${ORG}/byok/keys`]);
      expect((await page.content()).includes(KEY), "the key in the page").toBe(false);
      expect(await noHorizontalScroll(page)).toBe(true);
      await block.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(ARTIFACTS, `platform-byok-${vp.width}.png`), fullPage: true });

      await page.getByTestId("byok-key-revoke").click();
      await page.getByTestId("byok-revoke").waitFor();
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
        "byok-revoke-no",
      );
      await page.keyboard.press("Escape");
      expect(await page.getByTestId("byok-revoke").count()).toBe(0);
      await page.context().close();
    });
});
