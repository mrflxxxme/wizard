// M2-08 on the M1 stand (security/abuse.yaml#takedown.test): a published «форум» shows «Пожаловаться» → the public
// form on the platform takes a complaint without login → staff signs in, enrols TOTP (RFC 6238, the code is computed
// from the key shown on screen) → the ticket in the queue → triage (staff access by ticket) → takedown → the prod URL
// answers 451 with the neutral page and the owner gets the letter; restore → 200.
import { readFileSync } from "node:fs";
import { type BrowserContext, expect, test } from "@playwright/test";
import { createDb, setStaff, totpCode } from "@wizard/platform-api";
import { M1_DB_FILE } from "../../stand/ports.js";
import {
  type Api,
  builtForum,
  devLogin,
  type Json,
  letters,
  ownerOrg,
  publishApi,
  setOperator,
  uniqueEmail,
  WEB,
} from "./helpers.js";

test.describe.configure({ mode: "serial" });

let owner: BrowserContext;
let staffCtx: BrowserContext;
let a: Api;
let ownerEmail = "";
let system: Json;
let prodUrl = "";

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  owner = await browser.newContext();
  ownerEmail = uniqueEmail("owner-abuse");
  a = await devLogin(owner, ownerEmail);
  system = await builtForum(a, await ownerOrg(a));
  const rev = await setOperator(a, system);
  await publishApi(a, system.id, rev);
  prodUrl = (await a.req("GET", `/systems/${system.id}`)).body.system.prodUrl;
  expect(prodUrl).toMatch(/^http:\/\/[a-z0-9-]+\.localhost:\d+\/$/);
});

test.afterAll(async () => {
  await owner?.close();
  await staffCtx?.close();
});

test("жалоба → staff с MFA → снятие → prod отдаёт страницу «временно недоступна», владелец получил письмо", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // A visitor of the published system (no platform session).
  const visitor = await browser.newContext({ locale: "ru-RU" });
  const page = await visitor.newPage();
  const first = await page.goto(prodUrl);
  expect(first?.status()).toBe(200);
  const link = page.getByTestId("wz-abuse-link");
  await expect(link).toHaveText("Пожаловаться");
  await link.click();
  await expect(page).toHaveURL(new RegExp(`^${WEB}/abuse\\?url=`));
  await expect(page.getByTestId("abuse-url")).toHaveValue(new RegExp(`^${prodUrl}`));
  await page.getByTestId("abuse-category").selectOption("phishing");
  await page.getByTestId("abuse-text").fill("Форма просит код из СМС от банка");
  await page.getByTestId("abuse-submit").click();
  await expect(page.getByTestId("abuse-done")).toHaveText(
    "Жалоба отправлена. Мы рассмотрим её в течение 24 часов.",
  );

  // Staff: the founder's account (granted by the CLI function), TOTP enrolment on the first /admin visit.
  staffCtx = await browser.newContext({ locale: "ru-RU", baseURL: WEB });
  const staffEmail = uniqueEmail("founder-staff");
  await devLogin(staffCtx, staffEmail);
  const notYet = await staffCtx.newPage();
  await notYet.goto("/admin");
  await expect(notYet.getByTestId("admin-not-found")).toBeVisible();
  await notYet.close();
  const h = createDb(readFileSync(M1_DB_FILE, "utf8").trim(), 1);
  try {
    await setStaff(h.db, staffEmail, true);
  } finally {
    await h.close();
  }
  const admin = await staffCtx.newPage();
  await admin.goto("/admin");
  await admin.getByTestId("admin-mfa-start").click();
  const secret = (await admin.getByTestId("admin-mfa-secret").getAttribute("data-secret")) ?? "";
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await admin.getByTestId("admin-mfa-code").fill(totpCode(secret));
  await admin.getByTestId("admin-mfa-confirm").click();
  await expect(admin.getByTestId("admin-recovery-codes").locator("li")).toHaveCount(10);
  await admin.getByTestId("admin-recovery-done").click();

  // The queue → the ticket of this system.
  const row = admin.getByTestId("admin-report-row").filter({ hasText: system.name }).first();
  await expect(row).toBeVisible();
  await expect(row.getByTestId("admin-report-sla")).toContainText(/осталось 2[34] ч/);
  await row.click();
  await expect(admin.getByTestId("admin-ticket")).toHaveAttribute("data-status", "new");
  await admin.getByTestId("admin-note").fill("Проверяю форму входа");
  await admin.getByTestId("admin-act-triage").click();
  await expect(admin.getByTestId("admin-ticket")).toHaveAttribute("data-status", "triaged");
  await expect(admin.getByTestId("admin-data")).toBeVisible();
  await admin.getByTestId("admin-note").fill("Подтверждён фишинг: сбор кодов банка");
  await admin.getByTestId("admin-act-takedown").click();
  await expect(admin.getByTestId("admin-takedown-confirm-text")).toBeVisible();
  await admin.getByTestId("admin-act-takedown").click();
  await expect(admin.getByTestId("admin-ticket")).toHaveAttribute("data-status", "takedown");
  await expect(admin.getByTestId("admin-ticket-suspended")).toBeVisible();

  // The visitor reloads: 451 with the neutral Russian page, no complaint details.
  const after = await page.goto(prodUrl);
  expect(after?.status()).toBe(451);
  await expect(page.locator("h1")).toHaveText("Система временно недоступна по жалобе");
  await expect(page.locator("body")).toContainText("Владелец системы уведомлён.");
  await expect(page.locator("body")).not.toContainText("фишинг");

  await expect
    .poll(
      () => letters(ownerEmail).find((l) => l.subject.includes("временно недоступна по жалобе"))?.text ?? "",
    )
    .toContain("Причина: фишинг");

  // Restore → the system answers again.
  await admin.getByTestId("admin-note").fill("Владелец убрал форму");
  await admin.getByTestId("admin-act-restore").click();
  await expect(admin.getByTestId("admin-ticket")).toHaveAttribute("data-status", "restored");
  expect((await page.goto(prodUrl))?.status()).toBe(200);
  await visitor.close();
});
