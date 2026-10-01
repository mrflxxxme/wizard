// M1-11 on the M1 stand (M1 exit: «S10 (команда, «только РФ», ревизии и откат) и карточка «Публикация» в S6
// работают в e2e»): S1 → S3 → S4 in the UI, S6 blockers → operator of personal data in S10 → the owner publishes and
// the prod URL opens; the editor sees «Опубликовать» disabled and a direct POST gets 403 NOT_OWNER; the viewer sees
// invitations and rollback disabled; the owner rolls prod back from S10; «только РФ» changes the S1 policy; CSP.
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { M1 } from "../../stand/ports.js";
import {
  type Api,
  api,
  devLogin,
  type Json,
  lastLetter,
  ownerOrg,
  publishApi,
  uniqueEmail,
  WEB,
  waitRun,
} from "./helpers.js";

test.describe.configure({ mode: "serial" });

let ownerState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let orgId = "";
let systemId = "";
let firstRev = 0;

async function asOwner(browser: Browser): Promise<{ ctx: BrowserContext; page: Page; a: Api }> {
  const ctx = await browser.newContext({ storageState: ownerState });
  return { ctx, page: await ctx.newPage(), a: api(ctx) };
}

/** A member through an invite: sign in (dev-login) and accept the invite link from the letter. */
async function member(browser: Browser, email: string): Promise<{ ctx: BrowserContext; page: Page; a: Api }> {
  const link = (await lastLetter(email, "invite")).match(/\/invite\/[A-Za-z0-9_-]+/)?.[0] ?? "";
  const ctx = await browser.newContext();
  const a = await devLogin(ctx, email);
  const page = await ctx.newPage();
  await page.goto(link);
  await page.getByTestId("invite-accept").click();
  await expect(page).toHaveURL(`${WEB}/`);
  return { ctx, page, a };
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await devLogin(ctx, uniqueEmail("owner-team"));
  orgId = await ownerOrg(a);
  ownerState = await ctx.storageState();
  await ctx.close();
});

test("CSP платформы: default-src 'self', frame-src только домен систем", async ({ page }) => {
  const res = await page.goto("/login");
  const csp = res?.headers()["content-security-policy"] ?? "";
  const directives = csp.split(";").map((d) => d.trim());
  expect(directives).toContain("default-src 'self'");
  expect(directives).toContain("script-src 'self'");
  expect(directives).toContain(`frame-src http://*.localhost:${M1.runtime}`);
  expect(directives).toContain("object-src 'none'");
});

test("S1 → S3 → S4 → S6: блокер оператора ПДн → S10 → публикация владельцем, prod открывается", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { ctx, page } = await asOwner(browser);
  await page.goto("/");
  await expect(page.getByTestId("start-policy")).toContainText("ПДн удаляются до отправки");
  await page
    .getByTestId("start-prompt")
    .fill("Регистрация на форум «Северный ритейл» с билетами и заявками спикеров");
  await page.getByTestId("start-submit").click();
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/);
  systemId = page.url().split("/s/")[1] ?? "";

  await expect(page.getByTestId("card")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("card-estimate")).toBeVisible();
  await expect(page.getByTestId("card-cap")).toBeVisible();
  await page.getByTestId("card-build").click();
  await expect(page.getByTestId("gate-row-G0")).toHaveAttribute("data-status", "passed", { timeout: 90_000 });
  await expect(page.getByTestId("publish-card")).toBeVisible({ timeout: 30_000 });

  await expect(page.getByTestId("publish-blocker").first()).toContainText("Укажите оператора ПДн");
  await expect(page.getByTestId("publish-submit")).toBeDisabled();
  await page.getByRole("link", { name: "Указать в настройках" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${systemId}/settings`));
  await page.getByTestId("settings-pd-name").fill("ООО «Северный ритейл»");
  await page.getByTestId("settings-pd-contact").fill("privacy@north-retail.example");
  await page.getByTestId("settings-pd-address").fill("г. Москва, ул. Тверская, д. 1");
  await page.getByTestId("settings-pd-save").click();
  await expect(page.getByTestId("settings-notice")).toHaveText("Сохранено");

  await page.getByRole("button", { name: "К системе" }).click();
  await expect(page.getByTestId("publish-card")).toBeVisible();
  await expect(page.getByTestId("publish-blocker")).toHaveCount(0);
  const submit = page.getByTestId("publish-submit");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByTestId("run-result")).toBeVisible({ timeout: 90_000 });
  const prodUrl = (await page.getByTestId("run-prod-url").getAttribute("href")) ?? "";
  expect(prodUrl).toMatch(new RegExp(`^http://[a-z0-9-]+\\.localhost:${M1.runtime}/$`));
  await expect(page.getByTestId("publish-prod-revision")).toContainText("prod · ревизия");
  await expect(page.getByTestId("publish-prod-url")).toHaveAttribute("href", prodUrl);
  firstRev = Number((await page.getByTestId("publish-prod-revision").textContent())?.match(/\d+/)?.[0]);

  const prod = await ctx.newPage();
  const res = await prod.goto(prodUrl);
  expect(res?.status()).toBe(200);
  await ctx.close();
});

test("editor: «Опубликовать» disabled («Публикует владелец»), прямой POST publish → 403 NOT_OWNER", async ({
  browser,
}) => {
  const owner = await asOwner(browser);
  const editorEmail = uniqueEmail("editor");
  await owner.page.goto(`/s/${systemId}/settings`);
  await expect(owner.page.getByTestId("settings-member")).toHaveCount(1);
  await owner.page.getByTestId("settings-invite-email").fill(editorEmail);
  await owner.page.getByTestId("settings-invite-role").selectOption("editor");
  await owner.page.getByTestId("settings-invite").click();
  await expect(owner.page.getByTestId("settings-notice")).toContainText(editorEmail);
  await expect(owner.page.getByTestId("settings-invite-row")).toContainText(editorEmail);

  const editor = await member(browser, editorEmail);
  await editor.page.goto(`/s/${systemId}`);
  await expect(editor.page.getByTestId("publish-card")).toBeVisible();
  await expect(editor.page.getByTestId("publish-submit")).toBeDisabled();
  await expect(editor.page.getByTestId("publish-blocker")).toContainText("Публикует владелец");
  const sys = (await editor.a.req("GET", `/systems/${systemId}`)).body.system;
  const direct = await editor.a.req("POST", `/systems/${systemId}/publish`, {
    revision: sys.draftRevision,
    confirmDiff: true,
  });
  expect(direct.status).toBe(403);
  expect(direct.body.code).toBe("NOT_OWNER");
  await editor.ctx.close();
  await owner.ctx.close();
});

test("viewer: settings-invite и revision-rollback disabled (после второй публикации)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = await asOwner(browser);
  // A second publication: a change build through the API (scripted builder), then publish.
  const msg = await owner.a.req("POST", `/systems/${systemId}/messages`, {
    text: "добавь поле тема в заявки",
  });
  expect(msg.status, JSON.stringify(msg.body)).toBe(202);
  await waitRun(owner.a, msg.body.run.id);
  const s = (await owner.a.req("GET", `/systems/${systemId}`)).body;
  const ap = await owner.a.req("POST", `/systems/${systemId}/card/approve`, {
    cardVersion: s.card.cardVersion,
  });
  const built: Json = await waitRun(owner.a, ap.body.run.id);
  expect(built.status).toBe("succeeded");
  const sys = (await owner.a.req("GET", `/systems/${systemId}`)).body.system;
  await publishApi(owner.a, systemId, sys.draftRevision);

  const viewerEmail = uniqueEmail("viewer");
  const inv = await owner.a.req("POST", `/orgs/${orgId}/invites`, { email: viewerEmail, role: "viewer" });
  expect(inv.status, JSON.stringify(inv.body)).toBe(201);
  const viewer = await member(browser, viewerEmail);
  await viewer.page.goto(`/s/${systemId}/settings`);
  await expect(viewer.page.getByTestId("revision-rollback").first()).toBeVisible();
  await expect(viewer.page.getByTestId("settings-invite")).toBeDisabled();
  await expect(viewer.page.getByTestId("revision-rollback").first()).toBeDisabled();
  await expect(viewer.page.getByTestId("settings-ru-only")).toBeDisabled();
  await expect(viewer.page.getByTestId("settings-member")).toHaveCount(3);
  // The server is the protection: a viewer's direct rollback is refused.
  const direct = await viewer.a.req("POST", `/systems/${systemId}/rollback`, {
    env: "prod",
    toRevision: firstRev,
  });
  expect(direct.status).toBe(403);
  await viewer.page.goto(`/s/${systemId}`);
  await expect(viewer.page.getByTestId("chat-input")).toBeDisabled();
  await viewer.ctx.close();
  await owner.ctx.close();
});

test("S10: откат prod к ранее опубликованной ревизии → пилюля «prod · ревизия N»", async ({ browser }) => {
  test.setTimeout(90_000);
  const { ctx, page } = await asOwner(browser);
  await page.goto(`/s/${systemId}/settings`);
  const row = page.getByTestId("revision-row").filter({ has: page.getByTestId("revision-rollback") });
  await expect(row.first()).toHaveAttribute("data-version", String(firstRev));
  await row.first().getByTestId("revision-rollback").click();
  await expect(page.getByTestId("rollback-confirm")).toContainText(
    `Вернуть prod к ревизии ${firstRev}? Данные сохранятся`,
  );
  await page.getByTestId("rollback-yes").click();
  await expect(page.getByTestId("run-result")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("settings-prod-revision")).toHaveText(`prod · ревизия ${firstRev}`);
  await expect(
    page.getByTestId("revision-row").filter({ has: page.getByTestId("revision-prod") }),
  ).toHaveAttribute("data-version", String(firstRev));
  await ctx.close();
});

test("«Только российский контур» → GET settings ruOnly=true и текст политики на S1 меняется", async ({
  browser,
}) => {
  const { ctx, page, a } = await asOwner(browser);
  await page.goto("/");
  const policy = page.getByTestId("start-policy");
  await expect(policy).toContainText("ПДн удаляются до отправки");
  await page.goto(`/s/${systemId}/settings`);
  const sw = page.getByTestId("settings-ru-only");
  await expect(sw).toBeEnabled();
  await expect(sw).not.toBeChecked();
  await sw.check();
  await expect(sw).toBeChecked();
  expect((await a.req("GET", `/orgs/${orgId}/settings`)).body).toMatchObject({ ruOnly: true });
  await page.getByRole("link", { name: "На главную" }).click();
  await expect(policy).toContainText("Сборка: модели в РФ");
  await expect(policy).not.toContainText("ПДн удаляются");
  await expect(page.getByTestId("start-ru-only")).toBeChecked();
  await ctx.close();
});
