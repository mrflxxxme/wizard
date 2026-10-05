// M1-08 (platform-screens.yaml S7, S-code) on the M1 stand: a chat edit of a published «форум» → the change card →
// build → «Что изменится» lists human changes («+ … Тема трека», additive migration) → publish N+1; the «Код» tab
// opens ui/…tsx read-only (no textarea, no contenteditable).
import { type BrowserContext, expect, test } from "@playwright/test";
import {
  builtForum,
  devLogin,
  type Json,
  ownerOrg,
  publishApi,
  setOperator,
  uniqueEmail,
} from "./helpers.js";

test.describe.configure({ mode: "serial" });

let system: Json;
let owner: Awaited<ReturnType<BrowserContext["storageState"]>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const a = await devLogin(ctx, uniqueEmail("owner-diff"));
  const orgId = await ownerOrg(a);
  system = await builtForum(a, orgId);
  const rev = await setOperator(a, system);
  await publishApi(a, system.id, rev);
  owner = await ctx.storageState();
  await ctx.close();
});

test("S7: «добавь поле тема в заявки» → diff-line «+ … тема», данные «сохранятся» → publish N+1", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({ storageState: owner });
  const page = await ctx.newPage();
  await page.goto(`/s/${system.id}`);
  const prodPill = page.getByTestId("chat-prod-revision");
  await expect(prodPill).toBeVisible();
  const prodBefore = Number((await prodPill.textContent())?.match(/\d+/)?.[0]);

  await page.getByTestId("chat-input").fill("добавь поле тема в заявки");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("card")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("card")).toContainText("Тема трека");
  await page.getByTestId("card-build").click();

  const diff = page.getByTestId("diff-card");
  await expect(diff).toBeVisible({ timeout: 90_000 });
  const line = diff.getByTestId("diff-line").filter({ hasText: /тема/i });
  await expect(line.first()).toHaveAttribute("data-sign", "add");
  await expect(line.first()).toContainText("+");
  await expect(diff.getByTestId("diff-migration")).toHaveText("сохранятся");
  await expect(diff.getByTestId("diff-gates")).toContainText("пройдено");
  await expect(page.getByTestId("preview-env")).toContainText("версия");

  await page.getByTestId("env-segment-changes").click();
  await expect(page.getByTestId("diff-groups")).toContainText("Поля данных");
  await expect(
    page.getByTestId("diff-groups").getByTestId("diff-line").filter({ hasText: /тема/i }),
  ).toHaveCount(1);
  await page.getByTestId("env-segment-draft").click();

  await diff.getByTestId("diff-publish").click();
  await expect(page.getByTestId("run-result")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("run-prod-url")).toHaveAttribute("href", /localhost:4110/);
  await expect(prodPill).not.toHaveText(`Опубликована версия ${prodBefore}`);
  await expect(page.getByTestId("diff-card")).toHaveCount(0);
  await ctx.close();
});

test("S-code: «Код» → ui/…tsx read-only, no textarea or contenteditable", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: owner });
  const page = await ctx.newPage();
  await page.goto(`/s/${system.id}`);
  await page.getByTestId("preview-tab-code").click();
  await expect(page).toHaveURL(new RegExp(`/s/${system.id}/code`));
  const tree = page.getByTestId("code-tree");
  await expect(tree).toBeVisible();
  const tsx = tree.locator('[data-testid="code-file"][data-path^="ui/"][data-path$=".tsx"]').first();
  const path = await tsx.getAttribute("data-path");
  await tsx.click();
  await expect(page).toHaveURL(new RegExp(`path=${encodeURIComponent(path ?? "")}`));
  const viewer = page.getByTestId("code-viewer");
  await expect(viewer).toContainText(path ?? "");
  await expect(viewer.locator("ol")).toContainText("export");
  await expect(page.locator("textarea, [contenteditable]")).toHaveCount(0);
  await page.getByRole("button", { name: "Изменения версии" }).click();
  await expect(page).toHaveURL(/view=changes/);
  await expect(page.locator("textarea, [contenteditable]")).toHaveCount(0);
  await ctx.close();
});
