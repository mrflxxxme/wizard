// Goal scenario of the module «Секции лендинга» (packages/modules/src/landing): the public page «/» of ui-kit blocks.
import type { GoalProgram } from "../types.js";
import { component } from "./shared.js";

/** Forms a hero action may lead to: the lead form, a booking form, any form of the page. */
const FORMS = `${component("LeadForm")}, ${component("BookingForm")}, form`;

/** GS-landing-1: the hero heading is visible without scrolling; the main action leads to the form on this page. */
const heroAction: GoalProgram = async (t) => {
  t.step("Посетитель открывает главную страницу");
  await t.as("visitor");
  await t.open("/");

  t.step("Заголовок первого экрана виден без прокрутки");
  const h1 = t.page.locator("h1").first();
  if ((await h1.count()) === 0) t.fail("на главной нет заголовка первого экрана");
  const box = await h1.boundingBox();
  const title = ((await h1.innerText().catch(() => "")) || "").trim();
  if (!title) t.fail("заголовок первого экрана пустой");
  if (!box || !(await h1.isVisible()) || box.y < 0 || box.y + box.height > t.viewport.height)
    t.fail(
      "заголовок первого экрана не виден без прокрутки",
      box ? `верх ${Math.round(box.y)} px, низ ${Math.round(box.y + box.height)} px` : undefined,
    );

  t.step("Посетитель нажимает главную кнопку первого экрана");
  const hasForm = (await t.page.locator(FORMS).count()) > 0;
  const action = t.page.locator(`${component("Hero")} [data-testid="wz-hero-primary"]`).first();
  if ((await action.count()) === 0) {
    if (hasForm) t.fail("на первом экране нет кнопки, которая ведёт к форме");
    return;
  }
  const href = (await action.getAttribute("href")) ?? "";
  if (!href.startsWith("#")) {
    if (hasForm)
      t.fail("кнопка первого экрана ведёт не к форме на этой странице", `ссылка ${href || "пустая"}`);
    return;
  }
  await action.click();
  await t.page.waitForTimeout(300);

  t.step("Кнопка ведёт к форме заявки или записи на этой же странице");
  const target = t.page.locator(`[id="${href.slice(1).replace(/"/g, "")}"]`).first();
  if ((await target.count()) === 0)
    t.fail("кнопка первого экрана ведёт к блоку, которого нет на странице", href);
  if (hasForm && (await target.locator(FORMS).count()) === 0)
    t.fail("кнопка первого экрана ведёт не к форме", href);
  const tb = await target.boundingBox();
  if (!tb || tb.y >= t.viewport.height || tb.y + tb.height <= 0)
    t.fail(
      "после нажатия кнопки форма не появилась на экране",
      tb ? `верх блока ${Math.round(tb.y)} px` : undefined,
    );
};

export const LANDING_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-landing-1": heroAction,
};
