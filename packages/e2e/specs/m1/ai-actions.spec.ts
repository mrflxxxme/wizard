// M3-02 (runtime.yaml#ai_actions, L4-07, ui-kit.yaml#components.RecordCard) on the M1 stand: a speaker files an
// application in the draft; the owner asks in chat for an AI summary → the change card carries the backfill flag
// (card.aiBackfill) → the build adds the AI action and fills the summary of the existing application (backfill, T0
// mock provider through the platform gateway); the moderator sees it marked «заполнено ИИ»; after the field is cleared
// the «Резюме ИИ» button fills it again with the mark; the generated markup stays text; no AI request reached T1.
import { readFileSync } from "node:fs";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { M1_LLM_LOG } from "../../stand/ports.js";
import { api, builtForum, devLogin, type Json, ownerOrg, uniqueEmail, waitRun } from "./helpers.js";

test.describe.configure({ mode: "serial" });

const TOPIC = `Цифровая касса за 30 дней ${Date.now().toString(36)}`;
const SUMMARY = "Спикер расскажет о внедрении: цифры до и после, ошибки и выводы.";

let owner: Awaited<ReturnType<BrowserContext["storageState"]>>;
let system: Json;
let draft = "";

/**
 * Same-origin API call of the draft runtime from inside the page (session cookie, CSRF header): *.localhost hosts
 * resolve in the browser only, not in Node's request context.
 */
async function runtimeApi(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: {
          "X-Wizard-Request": "1",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    { method, path, body },
  ) as Promise<{ status: number; body: Json }>;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const a = await devLogin(ctx, uniqueEmail("owner-ai"));
  const orgId = await ownerOrg(a);
  system = await builtForum(a, orgId);
  const preview = await a.req("GET", `/systems/${system.id}/preview-url?role=speaker`);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  draft = new URL(preview.body.url).origin;
  owner = await ctx.storageState();
  await ctx.close();
});

test("backfill по флагу change-карточки → «заполнено ИИ»; кнопка «Резюме ИИ» заполняет поле снова", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // 1. A speaker files an application before the AI action exists (an "old" record).
  const speakerCtx = await browser.newContext();
  const speaker = await speakerCtx.newPage();
  await speaker.goto(`${draft}/_wizard/dev-login?role=speaker&next=/`);
  const spec = await runtimeApi(speaker, "GET", "/_wizard/spec");
  const consent = {
    policyVersion: spec.body.compliance.policyVersion,
    textHash: spec.body.compliance.consentTextHash,
  };
  const created = await runtimeApi(speaker, "POST", "/api/data/speaker_application", {
    full_name: "Анна Докладчикова",
    email: uniqueEmail("speaker"),
    topic: TOPIC,
    abstract: "Как мы перевели кассы магазинов на облако за месяц: цифры, ошибки и выводы.",
    _consent: consent,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const appId = String(created.body.item.id);
  await speakerCtx.close();

  // 2. The owner asks for an AI summary: the change card carries the backfill flag; the build adds the action.
  const ctx = await browser.newContext({ storageState: owner });
  const a = api(ctx);
  const msg = await a.req("POST", `/systems/${system.id}/messages`, {
    text: "добавь ИИ-резюме заявок спикеров",
  });
  expect(msg.status, JSON.stringify(msg.body)).toBe(202);
  await waitRun(a, msg.body.run.id);
  const s = (await a.req("GET", `/systems/${system.id}`)).body;
  expect(s.card.aiBackfill).toEqual(["summarize_application"]);
  const ap = await a.req("POST", `/systems/${system.id}/card/approve`, { cardVersion: s.card.cardVersion });
  expect(ap.status, JSON.stringify(ap.body)).toBe(202);
  const built = await waitRun(a, ap.body.run.id, 180_000);
  expect(built.status, JSON.stringify(built.failure)).toBe("succeeded");
  await ctx.close();

  // 3. The moderator opens the application: the summary was filled by the backfill and is marked.
  const modCtx = await browser.newContext();
  const page = await modCtx.newPage();
  await page.goto(`${draft}/_wizard/dev-login?role=moderator&next=/moderation`);
  const openCard = async () => {
    await page.getByTestId("wz-datatable-row").filter({ hasText: TOPIC }).first().click();
    await expect(page.getByTestId("wz-recordcard")).toBeVisible();
  };
  await openCard();
  const field = page.getByTestId("wz-recordcard-field-ai_summary");
  await expect(field).toContainText(SUMMARY);
  await expect(page.getByTestId("wz-recordcard-ai-ai_summary")).toHaveText("заполнено ИИ");
  // Generated markup is text: the literal tag is shown, no element is created, nothing ran.
  await expect(field).toContainText("<img");
  await expect(field.locator("img")).toHaveCount(0);

  // 4. The field is cleared (a user write removes the mark) → the button fills it again, with the mark.
  const cleared = await runtimeApi(page, "PATCH", `/api/data/speaker_application/${appId}`, {
    ai_summary: null,
  });
  expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
  await page.reload();
  await openCard();
  await expect(page.getByTestId("wz-recordcard-ai-ai_summary")).toHaveCount(0);
  await expect(field).not.toContainText(SUMMARY);
  await page.getByTestId("wz-recordcard-action-ai_summary").click();
  await expect(page.getByTestId("wz-recordcard").getByRole("status")).toHaveText("Готово: поля заполнены ИИ");
  await expect(field).toContainText(SUMMARY);
  await expect(page.getByTestId("wz-recordcard-ai-ai_summary")).toHaveText("заполнено ИИ");
  await expect(field.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __wzXss?: unknown }).__wzXss)).toBeUndefined();
  await modCtx.close();

  // 5. Every AI request of the stand went to a T0 provider (cloudru); none reached T1 (zai).
  const ai = readFileSync(M1_LLM_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { provider: string; body: string })
    .filter((r) => r.body.includes("Wizard AI action"));
  expect(ai.length).toBeGreaterThanOrEqual(2);
  expect(new Set(ai.map((r) => r.provider))).toEqual(new Set(["cloudru"]));
});
