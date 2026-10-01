// M2-11 on the M2 stand (stand/m2.ts: WIZARD_MILESTONE=M2 rules, the platform shop on YookassaMock and its test
// checkout page). One owner, one built «форум», in order:
// S6 blockers OPERATOR_NAME_REQUIRED → S10 «Персональные данные» (L4-09) and CARD_BINDING_REQUIRED → S-billing;
// a foreign card → «Нужна карта российского банка»; «Докупить» 990 ₽ on the YooKassa page → +60 credits;
// «Привязать карту РФ» → «✓ Карта РФ привязана» → S6 unblocked → publish runs G1 + G2 (prodG2Required) → the
// G2-AF-09 warning puts the revision on founder review → staff approves → published; a top-up by the bound card (no page);
// plan change and cancel; S10 «Выгрузить данные» → the M2-10 ZIP downloads once (L4-08, L4-10).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createDb, decideFounderReview, SecretStore } from "@wizard/platform-api";
import { M2, M2_DB_FILE } from "../../stand/ports.js";
import { type Api, builtForum, devLogin, type Json, ownerOrg, uniqueEmail } from "../m1/helpers.js";

const WEB = `http://localhost:${M2.web}`;
const SHOP = `http://localhost:${M2.shop}`;

test.describe.configure({ mode: "serial" });

let ctx: BrowserContext;
let a: Api;
let orgId: string;
let system: Json;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  ctx = await browser.newContext({ baseURL: WEB, locale: "ru-RU" });
  a = await devLogin(ctx, uniqueEmail("owner-billing"), WEB);
  orgId = await ownerOrg(a);
  system = await builtForum(a, orgId);
});

test.afterAll(async () => {
  await ctx?.close();
});

/** The stand's own database (stand.ts writes its URL at start). */
async function withStandDb<T>(fn: (h: ReturnType<typeof createDb>, url: string) => Promise<T>): Promise<T> {
  const url = readFileSync(M2_DB_FILE, "utf8").trim();
  const h = createDb(url, 1);
  try {
    return await fn(h, url);
  } finally {
    await h.close();
  }
}

/**
 * Prod values of the forum's integration secrets (G2-SECRET-02 at publish), as the owner enters them in the build chat
 * (needs_input kind=secret): the scripted builder of the stand does not ask. Stored by the platform's SecretStore in
 * the stand's secrets file (config.secretsFile = <artifactsDir>/.secrets.enc).
 */
async function setIntegrationSecrets(systemId: string): Promise<void> {
  const forumFile = join(import.meta.dirname, "../../../../specs/appspec/examples/forum.json");
  const forum = JSON.parse(readFileSync(forumFile, "utf8")) as { integrations: { secretRefs?: string[] }[] };
  const names = forum.integrations
    .flatMap((i) => i.secretRefs ?? [])
    .map((r) => r.replace(/^secret:\/\//, ""));
  await withStandDb(async (h, url) => {
    const artifacts = join(dirname(M2_DB_FILE), `artifacts-${new URL(url).pathname.slice(1)}`);
    const store = new SecretStore(join(artifacts, ".secrets.enc"), process.env.WIZARD_SECRETS_KEY ?? "");
    await h.db.transaction().execute(async (trx) => {
      for (const name of names)
        await store.put(trx, { orgId, systemId, env: "prod", name, value: `e2e-${name}` });
    });
  });
}

async function available(page: Page): Promise<number> {
  const el = page.getByTestId("billing-available");
  await expect(el).toBeVisible();
  return Number(await el.getAttribute("data-value"));
}

test("S6: блокеры оператора ПДн и карты ведут в S10 «Персональные данные» и на S-billing", async () => {
  const page = await ctx.newPage();
  await page.goto(`/s/${system.id}`);
  const blockers = page.getByTestId("publish-blocker");
  await expect(blockers.filter({ hasText: "Укажите оператора ПДн" }).first()).toBeVisible();
  await expect(blockers.filter({ hasText: "Привяжите карту РФ" })).toHaveCount(1);
  await expect(page.getByTestId("publish-submit")).toBeDisabled();
  await expect(page.getByTestId("publish-card-status")).toHaveAttribute("data-bound", "false");

  await page.getByTestId("publish-to-settings").click();
  await expect(page).toHaveURL(new RegExp(`/s/${system.id}/settings#pd$`));
  const pd = page.locator("#pd");
  await expect(pd.getByTestId("settings-pd-operator")).toBeVisible();
  // The deletion journal of «Персональные данные» is the owner's (L4-09).
  await expect(pd.getByTestId("settings-deletion-empty")).toBeVisible();
  await pd.getByTestId("settings-pd-name").fill("ООО «Северный ритейл»");
  await pd.getByTestId("settings-pd-contact").fill("privacy@north-retail.example");
  await pd.getByTestId("settings-pd-address").fill("г. Москва, ул. Тверская, д. 1");
  await pd.getByTestId("settings-pd-save").click();
  await expect(page.getByTestId("settings-notice")).toHaveText("Сохранено");

  await page.goto(`/s/${system.id}`);
  await expect(blockers).toHaveCount(1);
  await expect(blockers).toHaveText("Привяжите карту РФ");
  await expect(page.getByTestId("publish-to-settings")).toHaveCount(0);
  await page.getByTestId("publish-to-billing").click();
  await expect(page).toHaveURL(/\/billing$/);
  await expect(page.getByTestId("billing-card-status")).toHaveAttribute("data-status", "none");
  await page.close();
});

test("S-billing: зарубежная карта в тестовом магазине → «Нужна карта российского банка»", async () => {
  const page = await ctx.newPage();
  await page.goto("/billing");
  await page.getByTestId("billing-card-bind").click();
  await expect(page).toHaveURL(new RegExp(`^${SHOP}/checkout/payments/`));
  await expect(page.getByTestId("shop-amount")).toHaveText("1.00 ₽");
  await page.getByTestId("shop-pay-foreign").click();
  await expect(page).toHaveURL(/\/billing/);
  await expect(page.getByTestId("billing-card-error")).toHaveText("Нужна карта российского банка");
  await expect(page.getByTestId("billing-card-status")).toHaveAttribute("data-status", "none");
  expect((await a.req("GET", `/systems/${system.id}`)).body.publishBlockers).toContain(
    "CARD_BINDING_REQUIRED",
  );
  await page.close();
});

test("«Докупить» 990 ₽ через тестовый магазин → +60 кредитов в балансе и строка в журнале", async () => {
  const page = await ctx.newPage();
  await page.goto("/billing");
  const before = await available(page);
  await expect(page.getByTestId("billing-topup")).toHaveText("Докупить 60 кредитов за 990 ₽");
  await page.getByTestId("billing-topup").click();
  await expect(page).toHaveURL(new RegExp(`^${SHOP}/checkout/payments/`));
  await expect(page.getByTestId("shop-amount")).toHaveText("990.00 ₽");
  await page.getByTestId("shop-pay").click();
  await expect(page).toHaveURL(/\/billing/);
  await expect.poll(() => available(page)).toBeCloseTo(before + 60, 3);
  await expect(page.getByTestId("billing-bucket").filter({ hasText: "докупленные: 60" })).toHaveCount(1);
  const grant = page.getByTestId("billing-ledger-row").filter({ hasText: "+60" });
  await expect(grant.first()).toHaveAttribute("data-kind", "grant");
  const credits = await a.req("GET", `/orgs/${orgId}/credits`);
  expect(credits.body.available).toBeCloseTo(before + 60, 3);
  await page.close();
});

test("«Привязать карту РФ» → идентификация пройдена → публикация в prod разблокирована", async () => {
  const page = await ctx.newPage();
  await page.goto("/billing");
  await page.getByTestId("billing-card-bind").click();
  await expect(page).toHaveURL(new RegExp(`^${SHOP}/checkout/payments/`));
  const last4 = ((await page.getByTestId("shop-card").textContent()) ?? "").replace(/\D/g, "");
  expect(last4).toMatch(/^\d{4}$/);
  await page.getByTestId("shop-pay").click();
  await expect(page).toHaveURL(/\/billing/);
  const status = page.getByTestId("billing-card-status");
  await expect(status).toHaveAttribute("data-status", "bound");
  await expect(status).toContainText("✓ Карта РФ привязана — идентификация пройдена");
  await expect(status).toContainText(`•• ${last4}`);
  await expect(page.getByTestId("billing-card-error")).toHaveCount(0);
  await expect(page).toHaveURL(/\/billing$/);

  await page.goto(`/s/${system.id}`);
  await expect(page.getByTestId("publish-card-status")).toHaveText(
    "✓ Карта РФ привязана — идентификация пройдена",
  );
  await expect(page.getByTestId("publish-blocker")).toHaveCount(0);
  await expect(page.getByTestId("publish-submit")).toBeEnabled();
  await page.close();
});

test("публикация M2: G1 (ретенция AC6) и G2 → ревью модератора → одобрение → prod", async () => {
  test.setTimeout(240_000);
  await setIntegrationSecrets(system.id);
  const page = await ctx.newPage();
  await page.goto(`/s/${system.id}`);
  await expect(page.getByTestId("publish-submit")).toBeEnabled();
  await page.getByTestId("publish-submit").click();
  // G2 passes with the G2-AF-09 warning («Заявка спикера»): the revision waits for the founder review.
  await expect(page.getByRole("alert").filter({ hasText: "посмотрит модератор" })).toBeVisible({
    timeout: 120_000,
  });
  const sys = (await a.req("GET", `/systems/${system.id}`)).body;
  expect(sys.publishBlockers).toContain("FOUNDER_REVIEW_PENDING");
  expect(sys.system.prodRevision).toBeNull();
  const revision = sys.system.draftRevision as number;
  await page.reload();
  await expect(page.getByTestId("publish-blocker")).toHaveText(["Ждёт проверки"]);
  await expect(page.getByTestId("publish-submit")).toBeDisabled();

  // Staff approves (the moderation CLI: decideFounderReview); publish again runs G0 and G2, G1 already passed.
  expect(
    await withStandDb((h) =>
      decideFounderReview(h.db, { systemId: system.id, revision, decision: "approve", note: "e2e" }),
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.getByTestId("publish-blocker")).toHaveCount(0);
  await page.getByTestId("publish-submit").click();
  await expect(page.getByTestId("publish-prod-revision")).toBeVisible({ timeout: 120_000 });

  // gate_G1_prod ran on the compliance revision (it had no G1): AC6 retention passed; then G2 passed.
  const latest = (await a.req("GET", `/systems/${system.id}/gates/latest`)).body as {
    reports: {
      level: string;
      passed: boolean;
      specVersion: number;
      checks: { id: string; status: string }[];
    }[];
  };
  const byLevel = new Map(latest.reports.map((r) => [r.level, r]));
  for (const level of ["G1", "G2"])
    expect(byLevel.get(level), level).toMatchObject({ passed: true, specVersion: revision });
  expect(byLevel.get("G1")?.checks.find((c) => c.id === "SC-AC6")?.status).toBe("pass");
  expect((await a.req("GET", `/systems/${system.id}`)).body.system.prodRevision).toBe(revision);
  await page.close();
});

test("докупка с привязанной картой списывается сразу, без страницы оплаты", async () => {
  const page = await ctx.newPage();
  await page.goto("/billing");
  const before = await available(page);
  await page.getByTestId("billing-topup").click();
  await expect(page.getByTestId("billing-notice")).toHaveText("Начислено 60 кредитов");
  await expect(page).toHaveURL(/\/billing$/);
  await expect.poll(() => available(page)).toBeCloseTo(before + 60, 3);
  await page.close();
});

test("смена тарифа на «Старт» по привязанной карте и отмена подписки", async () => {
  const page = await ctx.newPage();
  await page.goto("/billing");
  await expect(page.getByTestId("billing-plan")).toHaveAttribute("data-plan", "free");
  await page.getByTestId("billing-change-plan").click();
  await page.getByTestId("billing-plan-start-submit").click();
  await expect(page.getByTestId("billing-notice")).toHaveText("Тариф «Старт» оформлен");
  await expect(page.getByTestId("billing-plan")).toHaveAttribute("data-plan", "start");
  await expect(page.getByTestId("billing-plan-status")).toContainText("подписка активна");
  await expect(page.getByTestId("billing-bucket").filter({ hasText: "по тарифу: 50" })).toHaveCount(1);

  await page.getByTestId("billing-cancel").click();
  await page.getByTestId("billing-cancel-yes").click();
  await expect(page.getByTestId("billing-notice")).toHaveText("Подписка отменена: автоплатёж выключен");
  await expect(page.getByTestId("billing-plan-status")).toContainText("автопродление выключено");
  await expect(page.getByTestId("billing-cancel")).toHaveCount(0);
  const billing = await a.req("GET", `/orgs/${orgId}/billing`);
  expect(billing.body).toMatchObject({ plan: "start", status: "active", cancelAtPeriodEnd: true });
  await page.close();
});

test("S10 «Выгрузить данные»: ПДн только после подтверждения; ZIP из M2-10 скачивается один раз", async () => {
  test.setTimeout(90_000);
  const page = await ctx.newPage();
  await page.goto(`/s/${system.id}/settings`);
  // Personal data in the archive only after an explicit confirmation; «Отмена» starts nothing.
  await page.getByTestId("settings-export-pii").check();
  await page.getByTestId("settings-export").click();
  await expect(page.getByTestId("settings-export-pii-confirm")).toContainText(
    "вместе с персональными данными",
  );
  await page.getByTestId("settings-export-pii-no").click();
  await expect(page.getByTestId("settings-export-status")).toHaveCount(0);
  expect((await a.req("GET", `/systems/${system.id}/exports`)).body.items).toHaveLength(0);
  await page.getByTestId("settings-export-pii").uncheck();

  await page.getByTestId("settings-export").click();
  const link = page.getByTestId("settings-export-download");
  await expect(link).toBeVisible({ timeout: 60_000 });
  const href = (await link.getAttribute("href")) ?? "";
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toMatch(/^wizard-export-prod-.*\.zip$/);
  const zip = readFileSync((await download.path()) as string);
  expect(zip.subarray(0, 2).toString()).toBe("PK");
  expect(zip.includes(Buffer.from("spec.json"))).toBe(true);
  // Single use: the same link again → 410 EXPORT_LINK_USED; the page offers a new link instead.
  const again = await ctx.request.get(href);
  expect(again.status()).toBe(410);
  await expect(page.getByTestId("settings-export-relink")).toBeVisible();
  const items = (await a.req("GET", `/systems/${system.id}/exports`)).body.items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ env: "prod", status: "ready", downloads: 1, includePii: false });
  await page.close();
});
