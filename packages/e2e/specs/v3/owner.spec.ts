// D78: the owner's v3 path through the platform UI on the v3 stand (stand/v3.ts: WIZARD_BUILD_PIPELINE=v3; the build's
// model calls answer from the records of real models, stand/v3-models.ts, V4-03 — no network, 0 ₽, a call without a
// record fails the spec). Sign in by an e-mail code → a new system from a description →
// the grill interview in the chat (the recommended button, «Решите за меня», an own answer) → the short brief and the
// brief panel → three directions, pick one → «Собрать» → the live build on the canvas (stages, the scenario checklist)
// → the preview of the site opens → «Система готова», the toast and the letter → an edit by words goes into the brief
// and offers «Собрать» again → (V3-19) the operator's data in the chat → «Опубликовать» → the site and the cabinet.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { PROMPTS } from "../../../agents/test/interview-v3/helpers.js";
import { V3, V3_OUTBOX, V3_RECORDS_LOG } from "../../stand/ports.js";
import { V3_WISH, V3_WISH_AUDIENCE, type V3RecordUse } from "../../stand/v3-models.js";

/** V4-03: a recording run (WIZARD_V3_RECORDS=record or record-stale) waits for live models — the long waits grow tenfold. */
const SLOW = process.env.WIZARD_V3_RECORDS?.startsWith("record") ? 10 : 1;

/** What the model calls of the stand took (stand/v3-models.ts): records, misses, new recordings. */
function recordUses(): V3RecordUse[] {
  try {
    return readFileSync(V3_RECORDS_LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as V3RecordUse);
  } catch {
    return [];
  }
}

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

test("v3: интервью → бриф → три направления → «Собрать» → живая сборка → превью → «Система готова» → правка словами → данные оператора → публикация → сайт и кабинет", async ({
  page,
}) => {
  test.setTimeout(420_000 * SLOW);
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
  // V4-08 «Сначала показать»: the three first screens fill the canvas while the questions go on in the chat.
  await expect(page.getByTestId("first-screens")).toHaveAttribute("data-state", "ready", {
    timeout: 90_000 * SLOW,
  });
  await expect(page.getByTestId("first-screens-count")).toHaveText("Вариант 1 из 3");
  await expect(page.getByTestId("p-question-delegate")).toBeVisible();
  await page.getByTestId("p-question-option-o1").click();

  await expect(question).toContainText("Какие данные пациента нужны", { timeout: 30_000 });
  await page.getByTestId("p-question-delegate").click();

  await expect(question).toContainText("Кто ещё работает с записями", { timeout: 30_000 });
  await say(page, "Администратор и два врача, врачи видят только свои записи");

  // V4-24: a clinic is a place — where to find it, asked by code; the owner writes it himself.
  await expect(question).toContainText("Где вас найти", { timeout: 30_000 });
  await say(page, "Казань, ул. Баумана, 12; пн–пт 9:00–20:00");
  // Its prices «от», by code too: the owner adds them later (the button keeps the site without prices).
  await expect(question).toContainText("Цены «от»", { timeout: 30_000 });
  await page.getByTestId("p-question-option-later").click();

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

  // Three directions of the site: the first screens already proposed (V4-08) in the style drawer; the owner picks the
  // second.
  await page.getByTestId("canvas-v3-style-open").click();
  const drawer = page.getByTestId("canvas-v3-style-drawer");
  await expect(drawer).toBeVisible();
  for (const n of [1, 2, 3]) {
    await expect(drawer.getByTestId(`direction-${n}`)).toBeVisible({ timeout: 60_000 * SLOW });
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

  // «Собрать»: the live build over the canvas (V4-11: under the ring of the island) — what is going on, the stages
  // and the scenario checklist of the brief.
  await page.getByTestId("canvas-v3-approve").click();
  await page.getByTestId("canvas-tile-build").click({ timeout: 30_000 });
  const live = page.getByTestId("canvas-v3-live");
  await expect(live).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("canvas-v3-live-title")).toBeVisible();
  const scenarios = page.getByTestId("canvas-v3-live-scenario");
  await expect(scenarios.first()).toBeVisible({ timeout: 60_000 * SLOW });
  expect(await scenarios.count()).toBeGreaterThanOrEqual(2);
  await page.getByTestId("canvas-v3-live-more").locator("summary").click();
  await expect(page.getByTestId("canvas-v3-live-stages").locator("li").first()).toBeVisible();

  // The site fills the canvas once the skeleton passes G0.
  const frame = page.getByTestId("canvas-frame-site");
  await expect(frame).toBeVisible({ timeout: 120_000 * SLOW });
  await expect(page.frameLocator('[data-testid="canvas-frame-site"]').locator("h1").first()).toBeVisible({
    timeout: 30_000,
  });

  // The end: «Система собрана», every scenario checked, «Система готова» in the chat, the toast and the letter.
  await expect(live).toHaveAttribute("data-phase", "done", { timeout: 150_000 * SLOW });
  await expect(page.getByTestId("canvas-v3-live-title")).toHaveText("Система собрана");
  const statuses = await scenarios.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
  expect(
    statuses.every((s) => s === "passed"),
    statuses.join(","),
  ).toBe(true);
  await page.getByTestId("p-composer-input").click();
  await expect(page.getByTestId("canvas-v3-live-ready")).toContainText("Система готова");
  await expect(page.getByTestId("canvas-v3-live-ready")).toContainText(
    `Готово ${statuses.length} из ${statuses.length}`,
  );
  await expect(page.getByTestId("canvas-v3-live-toast")).toBeVisible();
  await expect.poll(() => letters(email).filter((l) => l.kind === "notice").length).toBe(1);
  expect(letters(email).find((l) => l.kind === "notice")?.subject).toMatch(/собрана/);
  await page.getByTestId("canvas-v3-live-look").click();
  await expect(frame).toBeVisible();
  await expect(page.getByTestId("canvas-sheet")).toHaveCount(0);

  // V4-12 over V4-15: the heading picked on the real draft (bridge edit-mode) is edited without a model; the frame shows
  // the new revision with it.
  await page.getByTestId("canvas-tile-edit").click();
  await page.getByTestId("edit-text-pick").click();
  const draft = page.frameLocator('[data-testid="canvas-frame-site"]');
  await draft.locator("h1").first().click();
  const field = page.getByTestId("edit-text-field").first();
  await expect(field).toBeVisible({ timeout: 15_000 });
  await field.fill("Стоматология рядом с домом");
  await page.getByTestId("edit-text-save").click();
  await expect(page.getByTestId("edit-note")).toContainText("Готово за", { timeout: 15_000 });
  await expect(draft.locator("h1").first()).toHaveText("Стоматология рядом с домом", { timeout: 30_000 });
  await page.getByTestId("canvas-panel-close").click();

  // An edit by words after the build: the wish goes into the brief, «Собрать» is offered again.
  await page.getByTestId("p-composer-input").click();
  await say(page, V3_WISH);
  await expect(page.getByTestId("canvas-v3-build")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("canvas-v3-style")).toContainText("выбран вами");
  await page.getByTestId("canvas-brief-toggle").click();
  await expect(page.getByTestId("canvas-brief-panel")).toContainText(V3_WISH_AUDIENCE);
  await page.getByTestId("p-brief-close").click();

  // …and «Собрать» rebuilds by the new brief version: the scenarios the edit did not touch come from the checkpoints
  // of the first build (not paid twice), the second ready notice, the preview stays. V4-24: the heading edited above
  // would be replaced — the owner is asked first and chooses «Пересобрать».
  await page.getByTestId("canvas-v3-approve").click();
  await expect(page.getByTestId("canvas-v3-replace")).toContainText(
    "Пересборка заменит ваши правки (1). Пересобрать или выбрать блок и поправить его?",
  );
  await expect(page.getByTestId("canvas-v3-pick-block")).toBeVisible();
  await page.getByTestId("canvas-v3-rebuild").click();
  await expect
    .poll(() => letters(email).filter((l) => l.kind === "notice").length, { timeout: 150_000 * SLOW })
    .toBe(2);
  await page.getByTestId("canvas-tile-build").click();
  await expect(page.getByTestId("canvas-v3-live-checkpoints")).toContainText("Взято из прошлой сборки", {
    timeout: 30_000,
  });
  await expect(live).toHaveAttribute("data-phase", "done");
  await expect(scenarios).toHaveCount(statuses.length);
  await expect(page.getByTestId("canvas-v3-live-scenario-status").first()).toHaveText(
    "готово в прошлой сборке",
  );
  await page.getByTestId("p-composer-input").click();
  await expect(page.getByTestId("canvas-v3-live-ready")).toContainText("Система готова");
  await expect(frame).toBeVisible();

  // V3-19: publication from the canvas. The system keeps patients' data, so the server asks the operator's data
  // (OPERATOR_*): the owner gives it in the chat card, «Опубликовать» turns on, the publish run ends with the version in
  // prod, the site and the owner's cabinet open.
  await page.getByTestId("p-composer-input").click();
  await expect(page.getByTestId("canvas-settings")).toHaveAttribute("href", /\/s\/[0-9a-f-]{36}\/settings$/);
  await page.getByTestId("canvas-island-publish").click();
  const publish = page.getByTestId("canvas-v3-publish");
  await expect(publish).toBeVisible({ timeout: 30_000 });
  const submit = page.getByTestId("canvas-v3-publish-submit");
  const operator = page.getByTestId("canvas-v3-operator");
  await expect(operator).toBeVisible();
  await expect(submit).toBeDisabled();
  await expect(page.getByTestId("canvas-v3-operator-settings")).toHaveAttribute("href", /\/settings#pd$/);
  await page.getByTestId("canvas-v3-operator-name").fill("ИП Иванова Анна Андреевна");
  await page.getByTestId("canvas-v3-operator-contact").fill("privacy@dental.example");
  await page.getByTestId("canvas-v3-operator-address").fill("г. Москва, ул. Зубная, д. 1");
  await page.getByTestId("canvas-v3-operator-save").click();
  await expect(operator).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("canvas-v3-publish-blocker")).toHaveCount(0);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByTestId("canvas-v3-publish-prod")).toContainText("Опубликована версия", {
    timeout: 150_000 * SLOW,
  });
  await expect(page.getByTestId("canvas-v3-publish-result")).toContainText("Система опубликована");
  const site = (await page.getByTestId("canvas-v3-publish-site").getAttribute("href")) ?? "";
  expect(site).toMatch(new RegExp(`^http://[a-z0-9-]+\\.localhost:${V3.runtime}/$`));
  const cabinet = (await page.getByTestId("canvas-v3-publish-cabinet").getAttribute("href")) ?? "";
  expect(cabinet).toBe(`${site}login?next=%2Fcabinet`);
  await expect(page.getByTestId("canvas-v3-publish-uptodate")).toBeVisible();
  await expect(submit).toHaveCount(0);

  const prod = await page.context().newPage();
  expect((await prod.goto(site))?.status()).toBe(200);
  await expect(prod.locator("h1").first()).toBeVisible({ timeout: 30_000 });
  expect((await prod.goto(cabinet))?.status()).toBe(200);
  await prod.close();

  // V4-03: the build's stages answered from the records of real models — no call missed its record (a miss would have
  // sent its stage to the deterministic fallback silently), and the art director, the pages, the critic and the techreview took
  // real answers.
  const uses = recordUses();
  expect(uses.filter((u) => u.outcome === "miss").map((u) => u.message)).toEqual([]);
  const answered = new Set(
    uses.filter((u) => u.outcome === "hit" || u.outcome === "recorded").map((u) => u.callType),
  );
  for (const callType of ["art_direction", "page_compose", "critic_visual", "techreview"])
    expect([...answered]).toContain(callType);
});
