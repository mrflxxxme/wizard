// D78: the owner's v3 path through the platform UI on the v3 stand (stand/v3.ts: WIZARD_BUILD_PIPELINE=v3, recorded
// model answers of stand/v3-models.ts, no network, 0 ₽). Sign in by an e-mail code → a new system from a description →
// the grill interview in the chat (the recommended button, «Решите за меня», an own answer) → the short brief and the
// brief panel → three directions, pick one → «Собрать» → the live build on the canvas (stages, the scenario checklist)
// → the preview of the site opens → «Система готова», the toast and the letter → an edit by words goes into the brief
// and offers «Собрать» again.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { PROMPTS } from "../../../agents/test/interview-v3/helpers.js";
import { V3_OUTBOX } from "../../stand/ports.js";
import { V3_WISH, V3_WISH_AUDIENCE } from "../../stand/v3-models.js";

/** Letters of the v3 stand's OutboxMailer to `to`, oldest first. */
function letters(to: string): { kind: string; to: string; subject: string; text: string }[] {
  let names: string[] = [];
  try {
    names = readdirSync(V3_OUTBOX).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .sort()
    .map((n) => JSON.parse(readFileSync(join(V3_OUTBOX, n), "utf8")))
    .filter((l) => l.to === to);
}

/** A new owner signs in with the code from the letter and both consents → the start screen. */
async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByTestId("auth-email").fill(email);
  await page.getByTestId("auth-request-code").click();
  let code = "";
  await expect
    .poll(() => {
      code = /\b\d{6}\b/.exec(letters(email).findLast((l) => l.kind === "otp")?.text ?? "")?.[0] ?? "";
      return code;
    })
    .toMatch(/^\d{6}$/);
  await page.getByTestId("auth-code").fill(code);
  await page.getByTestId("auth-submit").click();
  await page.getByTestId("auth-offer").check();
  await page.getByTestId("auth-pd-consent").check();
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("start-prompt")).toBeVisible();
}

/** Sends a chat message from the canvas composer. */
async function say(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("p-composer-input");
  await expect(input).toBeEnabled();
  await input.fill(text);
  await page.getByTestId("p-composer-send").click();
}

test("v3: интервью → бриф → три направления → «Собрать» → живая сборка → превью → «Система готова» → правка словами", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const email = `owner-v3-${randomBytes(4).toString("hex")}@example.test`;
  await signIn(page, email);

  // A new system from the owner's own words.
  await page.getByTestId("start-prompt").fill(PROMPTS.dental);
  await page.getByTestId("start-submit").click();
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}/);
  await expect(page.getByTestId("canvas")).toBeVisible();

  // The grill interview: one question per turn, the recommended answer marked, «Решите за меня» of its own.
  const question = page.getByTestId("canvas-question");
  await expect(question).toContainText("Что пациент должен сделать сам", { timeout: 30_000 });
  await expect(question).toContainText("Вопрос 1");
  await expect(page.getByTestId("p-question-delegate")).toBeVisible();
  await page.getByTestId("p-question-option-o1").click();

  await expect(question).toContainText("Какие данные пациента нужны", { timeout: 30_000 });
  await page.getByTestId("p-question-delegate").click();

  await expect(question).toContainText("Кто ещё работает с записями", { timeout: 30_000 });
  await say(page, "Администратор и два врача, врачи видят только свои записи");

  // The brief is ready: the short brief in the chat and «Собрать» with its cap; no question left.
  const build = page.getByTestId("canvas-v3-build");
  await expect(build).toBeVisible({ timeout: 30_000 });
  await expect(question).toHaveCount(0);
  await expect(page.getByTestId("canvas-brief-summary")).toBeVisible();
  await expect(page.getByTestId("canvas-v3-approve")).toContainText("Собрать");
  await expect(page.getByTestId("canvas-v3-style")).toContainText("ещё не выбран");

  // The brief panel: what the interview wrote down (goal, roles from the own answer).
  await page.getByTestId("canvas-brief-toggle").click();
  const panel = page.getByTestId("canvas-brief-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Пациенты сами записываются к врачу онлайн");
  await expect(panel).toContainText("Администратор");
  await page.getByTestId("p-brief-close").click();
  await expect(panel).toHaveCount(0);

  // Three directions of the site: three real first screens, the owner picks the second.
  await page.getByTestId("canvas-v3-style-open").click();
  const drawer = page.getByTestId("canvas-v3-style-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByTestId("directions-propose").click();
  for (const n of [1, 2, 3]) {
    await expect(drawer.getByTestId(`direction-${n}`)).toBeVisible({ timeout: 60_000 });
    await expect(drawer.getByTestId(`direction-preview-${n}`)).toHaveAttribute("srcdoc", /<html/i);
  }
  const archetypes = new Set(
    await drawer.getByTestId(/^direction-[123]$/).evaluateAll((els) => els.map((e) => e.textContent ?? "")),
  );
  expect(archetypes.size).toBe(3);
  await drawer.getByTestId("direction-pick-2").click();
  await expect(drawer).toHaveCount(0);
  const style = page.getByTestId("canvas-v3-style");
  await expect(style).toContainText("выбран вами");
  await expect(style).toHaveAttribute("data-archetype", /.+/);

  // «Собрать»: the live build on the canvas — what is going on, the stages and the scenario checklist of the brief.
  await page.getByTestId("canvas-v3-approve").click();
  const live = page.getByTestId("canvas-v3-live");
  await expect(live).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("canvas-v3-live-title")).toBeVisible();
  const scenarios = page.getByTestId("canvas-v3-live-scenario");
  await expect(scenarios.first()).toBeVisible({ timeout: 60_000 });
  expect(await scenarios.count()).toBeGreaterThanOrEqual(2);
  await page.getByTestId("canvas-v3-live-more").locator("summary").click();
  await expect(page.getByTestId("canvas-v3-live-stages").locator("li").first()).toBeVisible();

  // The preview of the site opens in the canvas once the skeleton passes G0.
  const frame = page.getByTestId("canvas-v3-live-frame");
  await expect(frame).toBeVisible({ timeout: 120_000 });
  await expect(page.frameLocator('[data-testid="canvas-v3-live-frame"]').locator("h1").first()).toBeVisible({
    timeout: 30_000,
  });

  // The end: «Система собрана», every scenario checked, «Система готова» in the chat, the toast and the letter.
  await expect(live).toHaveAttribute("data-phase", "done", { timeout: 150_000 });
  await expect(page.getByTestId("canvas-v3-live-title")).toHaveText("Система собрана");
  const statuses = await scenarios.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
  expect(
    statuses.every((s) => s === "passed"),
    statuses.join(","),
  ).toBe(true);
  await expect(page.getByTestId("canvas-v3-live-ready")).toContainText("Система готова");
  await expect(page.getByTestId("canvas-v3-live-ready")).toContainText(
    `Готово ${statuses.length} из ${statuses.length}`,
  );
  await expect(page.getByTestId("canvas-v3-live-toast")).toBeVisible();
  await expect.poll(() => letters(email).filter((l) => l.kind === "notice").length).toBe(1);
  expect(letters(email).find((l) => l.kind === "notice")?.subject).toMatch(/собрана/);
  await page.getByTestId("canvas-v3-live-look").click();
  await expect(frame).toBeVisible();

  // An edit by words after the build: the wish goes into the brief, «Собрать» is offered again.
  await say(page, V3_WISH);
  await expect(page.getByTestId("canvas-v3-build")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("canvas-v3-style")).toContainText("выбран вами");
  await page.getByTestId("canvas-brief-toggle").click();
  await expect(page.getByTestId("canvas-brief-panel")).toContainText(V3_WISH_AUDIENCE);
  await page.getByTestId("p-brief-close").click();

  // …and «Собрать» rebuilds by the new brief version: the scenarios the edit did not touch come from the checkpoints
  // of the first build (not paid twice), the second ready notice, the preview stays.
  await page.getByTestId("canvas-v3-approve").click();
  await expect
    .poll(() => letters(email).filter((l) => l.kind === "notice").length, { timeout: 150_000 })
    .toBe(2);
  await expect(page.getByTestId("canvas-v3-live-checkpoints")).toContainText("Взято из прошлой сборки", {
    timeout: 30_000,
  });
  await expect(live).toHaveAttribute("data-phase", "done");
  await expect(scenarios).toHaveCount(statuses.length);
  await expect(page.getByTestId("canvas-v3-live-scenario-status").first()).toHaveText(
    "готово в прошлой сборке",
  );
  await expect(page.getByTestId("canvas-v3-live-ready")).toContainText("Система готова");
  await expect(frame).toBeVisible();
});
