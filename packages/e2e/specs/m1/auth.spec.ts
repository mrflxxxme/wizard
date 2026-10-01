// M1-11 S-auth and S-invite on the M1 stand (session mode, OTP letters in the stand outbox):
// a new email needs both consents (separate, unchecked) → S1; an invited user signs in from the invite link, accepts
// and sees the organization's systems with the invited role; a used link → «Приглашение устарело».
import { expect, type Page, test } from "@playwright/test";
import { devLogin, lastLetter, ownerOrg, uniqueEmail, WEB, waitRun } from "./helpers.js";

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByTestId("auth-email").fill(email);
  await page.getByTestId("auth-request-code").click();
  await expect(page.getByRole("status")).toContainText("Если адрес верный, код отправлен");
  const code = (await lastLetter(email, "otp")).match(/\b\d{6}\b/)?.[0] ?? "";
  expect(code).toMatch(/^\d{6}$/);
  await page.getByTestId("auth-code").fill(code);
  await page.getByTestId("auth-submit").click();
  // New user: two separate unchecked consents, both required.
  await expect(page.getByTestId("auth-offer")).not.toBeChecked();
  await expect(page.getByTestId("auth-pd-consent")).not.toBeChecked();
  await expect(page.getByTestId("auth-offer-error")).toBeVisible();
  await expect(page.getByTestId("auth-pd-consent-error")).toBeVisible();
  await page.getByTestId("auth-offer").check();
  await page.getByTestId("auth-pd-consent").check();
  await page.getByTestId("auth-submit").click();
}

test("S-auth: новый email → оба согласия обязательны (и на сервере) → вход → S1", async ({ page }) => {
  const email = uniqueEmail("new");
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?next=%2F$/);
  await page.getByTestId("auth-email").fill(email);
  await page.getByTestId("auth-request-code").click();
  await expect(page.getByRole("status")).toContainText("Если адрес верный, код отправлен");
  const code = (await lastLetter(email, "otp")).match(/\b\d{6}\b/)?.[0] ?? "";
  await page.getByTestId("auth-code").fill(code);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("auth-offer")).toBeVisible();
  await expect(page.getByTestId("auth-pd-consent")).toBeVisible();
  await expect(page.getByTestId("auth-offer")).not.toBeChecked();
  await expect(page.getByTestId("auth-pd-consent")).not.toBeChecked();

  // Only the offer: the page refuses, and the server does too (the code stays valid).
  await page.getByTestId("auth-offer").check();
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("auth-pd-consent-error")).toBeVisible();
  const direct = await page.request.post(`${WEB}/api/v1/auth/otp/verify`, {
    headers: { Origin: WEB, "content-type": "application/json" },
    data: JSON.stringify({ email, code, acceptOffer: true }),
  });
  expect(direct.status()).toBe(422);
  expect(await direct.json()).toMatchObject({
    code: "CONSENT_REQUIRED",
    details: { missing: ["pdConsent"] },
  });

  await page.getByTestId("auth-pd-consent").check();
  await page.getByTestId("auth-submit").click();
  await expect(page).toHaveURL(`${WEB}/`);
  await expect(page.getByTestId("start-prompt")).toBeVisible();
  await expect(page.getByTestId("start-org")).toContainText("владелец");
  const me = await (await page.request.get(`${WEB}/api/v1/me`)).json();
  expect(me.user.email).toBe(email);
});

test("S-invite: приглашённый входит по ссылке, принимает и видит системы организации с ролью из приглашения", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const ownerCtx = await browser.newContext();
  const owner = await devLogin(ownerCtx, uniqueEmail("owner-inv"));
  const orgId = await ownerOrg(owner);
  const created = await owner.req("POST", "/systems", { prompt: "Заявки на участие в хакатоне", orgId });
  expect(created.status).toBe(201);
  await waitRun(owner, created.body.run.id);
  const invitee = uniqueEmail("invitee");
  const inv = await owner.req("POST", `/orgs/${orgId}/invites`, { email: invitee, role: "editor" });
  expect(inv.status, JSON.stringify(inv.body)).toBe(201);
  const link =
    (await lastLetter(invitee, "invite")).match(/https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/)?.[0] ?? "";
  const path = new URL(link).pathname;

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(path);
  await expect(page.getByTestId("invite-card")).toBeVisible();
  await page.getByTestId("invite-login").click();
  await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path)}`));
  await signIn(page, invitee);
  await expect(page).toHaveURL(`${WEB}${path}`);
  await page.getByTestId("invite-accept").click();

  await expect(page).toHaveURL(`${WEB}/`);
  const org = page.getByTestId("start-org");
  await expect(org).toHaveValue(orgId);
  await expect(org.locator("option:checked")).toContainText("редактор");
  await expect(page.getByTestId("start-system-card")).toHaveCount(1);
  await expect(page.getByTestId("start-system-card")).toHaveAttribute("href", `/s/${created.body.system.id}`);
  const me = await (await page.request.get(`${WEB}/api/v1/me`)).json();
  expect(me.memberships).toContainEqual(expect.objectContaining({ orgId, role: "editor" }));

  // The link is single-use.
  await page.goto(path);
  await page.getByTestId("invite-accept").click();
  await expect(page.getByTestId("invite-error")).toHaveText("Приглашение устарело, попросите новое");
  await ctx.close();
  await ownerCtx.close();
});
