// M2-05 on the M1 stand: S10 «Персональные данные» shows the deletion journal (GET /systems/:id/deletion-log — date,
// entity, mode, counters, never values) and «Удалить систему» asks for a confirmation, soft-deletes the system (it
// disappears from S1 and the API; the journal stays readable to the owner as the proof of the later purge).
import { readFileSync } from "node:fs";
import { type BrowserContext, expect, test } from "@playwright/test";
import postgres from "postgres";
import { M1_DB_FILE } from "../../stand/ports.js";
import { type Api, builtForum, devLogin, type Json, ownerOrg, uniqueEmail } from "./helpers.js";

test.describe.configure({ mode: "serial" });

let ctx: BrowserContext;
let a: Api;
let system: Json;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  ctx = await browser.newContext();
  a = await devLogin(ctx, uniqueEmail("owner-privacy"));
  system = await builtForum(a, await ownerOrg(a));
  // The runtime's retention and a consent withdrawal, as retention_cron moves them into platform.deletion_log.
  const sql = postgres(readFileSync(M1_DB_FILE, "utf8").trim(), { max: 1, onnotice: () => {} });
  try {
    await sql`insert into platform.deletion_log (system_id, env, entity, mode, cutoff, rows_affected, created_at) values
      (${system.id}, 'prod', 'ticket', 'anonymize', '2026-08-01T00:00:00Z', 3, now() - interval '1 hour'),
      (${system.id}, 'prod', 'users', 'consent_revoked', null, 1, now())`;
  } finally {
    await sql.end();
  }
});

test.afterAll(async () => {
  await ctx?.close();
});

test("S10: журнал удалений — сущность, режим и число записей, без значений", async () => {
  const page = await ctx.newPage();
  await page.goto(`/s/${system.id}/settings`);
  const rows = page.getByTestId("settings-deletion-row");
  await expect(rows).toHaveCount(2);
  // Newest first.
  await expect(rows.nth(0)).toHaveAttribute("data-mode", "consent_revoked");
  await expect(rows.nth(0)).toContainText("отзыв согласия");
  await expect(rows.nth(0)).toContainText("1 запись");
  await expect(rows.nth(1)).toContainText("Билет");
  await expect(rows.nth(1)).toContainText("обезличивание по сроку");
  await expect(rows.nth(1)).toContainText("3 записи");
  await expect(rows.nth(1)).toContainText("данные до 1 августа 2026");
  await expect(page.getByTestId("settings-deletion-log")).not.toContainText("@");
  await page.close();
});

test("S10: «Удалить систему» → подтверждение → система пропадает из S1, журнал остаётся у владельца", async () => {
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByTestId("start-system-card").filter({ hasText: system.name })).toHaveCount(1);
  await page.goto(`/s/${system.id}/settings`);
  await page.getByTestId("settings-delete-system").click();
  const dialog = page.getByTestId("settings-delete-confirm");
  await expect(dialog).toContainText(`Удалить систему «${system.name}»?`);
  await expect(dialog).toContainText("через 30 дней");
  await page.getByTestId("settings-delete-no").click();
  await expect(dialog).toHaveCount(0);
  expect((await a.req("GET", `/systems/${system.id}`)).status).toBe(200);

  await page.getByTestId("settings-delete-system").click();
  await page.getByTestId("settings-delete-yes").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("start-prompt")).toBeVisible();
  await expect(page.getByTestId("start-system-card").filter({ hasText: system.name })).toHaveCount(0);
  expect((await a.req("GET", `/systems/${system.id}`)).status).toBe(404);
  const log = await a.req("GET", `/systems/${system.id}/deletion-log`);
  expect(log.status).toBe(200);
  expect(log.body.items).toHaveLength(2);
  await page.close();
});
