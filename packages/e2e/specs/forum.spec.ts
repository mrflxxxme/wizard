// M0-17: the «форум» demo end to end on the golden fixture demo/forum (fixture LLM, no network to models).
// Answers follow tools/fixtures/golden/forum.yaml#answers: q1, q2 explicitly, the rest by recommendation.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Frame, type FrameLocator, type Page, test } from "@playwright/test";
import jsqrModule from "jsqr";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SHOTS = join(import.meta.dirname, "..", "test-results", "forum");
// WIZARD_E2E_DOCS=1 also refreshes the committed screenshots for the founder (docs/prototype/m0).
const DOCS = process.env.WIZARD_E2E_DOCS === "1" ? join(ROOT, "docs", "prototype", "m0") : null;
const RUNTIME = "http://127.0.0.1:4100";

// jsqr is CommonJS: the function sits at the default import or at its `.default`, depending on the loader.
type DecodeRgba = (data: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
const decodeRgba = ((jsqrModule as unknown as { default?: DecodeRgba }).default ??
  jsqrModule) as unknown as DecodeRgba;

const ACCENT_BEFORE = "rgb(194, 65, 12)"; // forum.json theme.accent #C2410C
const ACCENT_AFTER = { id: "0a7d3e", rgb: "rgb(10, 125, 62)" }; // preset #0A7D3E

function goldenBrief(): string {
  const y = readFileSync(join(ROOT, "tools/fixtures/golden/forum.yaml"), "utf8");
  const m = y.match(/^brief: >-\n((?: {2}.*\n)+)/m);
  if (!m?.[1]) throw new Error("brief not found in golden/forum.yaml");
  return m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
}

async function shot(page: Page, name: string, docs = false): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  if (docs && DOCS) await page.screenshot({ path: join(DOCS, `${name}.png`) });
}

async function previewFrame(page: Page): Promise<Frame> {
  const handle = await page.getByTestId("preview-frame").elementHandle();
  const f = await handle?.contentFrame();
  if (!f) throw new Error("preview iframe has no frame");
  return f;
}

/** Role switch in the platform toolbar; the draft preview cookie must log the iframe in (M0-16). */
async function switchRole(page: Page, preview: FrameLocator, role: string, label: string): Promise<void> {
  await page.getByTestId(`role-switch-${role}`).click();
  await expect(page.getByTestId(`role-switch-${role}`)).toHaveAttribute("aria-pressed", "true");
  await expect(preview.getByTestId("wz-appshell-user")).toContainText(label, { timeout: 15_000 });
}

/** Rasterizes the QrTicket SVG in the page and decodes it like a scanner would. */
async function decodeQr(frame: Frame): Promise<string> {
  const img = await frame.getByTestId("wz-qrticket-code").evaluate(async (svg) => {
    const size = 400;
    const url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }),
    );
    const el = new Image();
    el.src = url;
    await el.decode();
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(el, 0, 0, size, size);
    URL.revokeObjectURL(url);
    return { size, data: Array.from(ctx.getImageData(0, 0, size, size).data) };
  });
  const code = decodeRgba(Uint8ClampedArray.from(img.data), img.size, img.size);
  if (!code?.data) throw new Error("QR not decoded");
  return code.data;
}

test.beforeAll(async ({ request }) => {
  mkdirSync(SHOTS, { recursive: true });
  if (DOCS) mkdirSync(DOCS, { recursive: true });
  await expect
    .poll(async () => (await request.get(`${RUNTIME}/_wizard/health`).catch(() => null))?.status(), {
      timeout: 60_000,
    })
    .toBe(200);
});

test("форум: промпт → вопросы → карточка → сборка G0/G1 → превью → билет с QR → проверка на входе", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const preview = page.frameLocator('[data-testid="preview-frame"]');
  // Uncaught errors of the platform and of the system code in the preview iframe.
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await test.step("S1: бриф форума → /s/<id>", async () => {
    await page.goto("/");
    await page.getByTestId("start-prompt").fill(goldenBrief());
    await shot(page, "01-start");
    await page.getByTestId("start-submit").click();
    await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("chat-message").first()).toContainText("Северный ритейл");
  });

  await test.step("S2: вопросы-кнопки как в золотом прогоне", async () => {
    await expect(page.getByTestId("question-card")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("question-progress")).toHaveText(/1\D+5/);
    await expect(page.getByTestId("question-recommended")).toHaveCount(1);
    await expect(page.getByText("Есть 5 вопросов, чтобы собрать карточку системы.")).toBeVisible();
    await page.getByTestId("question-card").scrollIntoViewIfNeeded();
    await shot(page, "02-questions", true);
    // FU-4: forks read as human titles, never raw taxonomy ids.
    await expect(page.getByTestId("forks-list")).not.toContainText(/F-[A-Z]/);
    await page.getByTestId("question-option-email_or_telegram").click();
    await page.getByTestId("question-next").click();
    await page.getByTestId("question-option-qr_offline_scanner").click();
    await page.getByTestId("question-next").click();
    await expect(page.getByTestId("question-progress")).toHaveText(/3\D+5/);
    await page.getByTestId("question-accept-rest").click();
  });

  await test.step("S3: карточка системы → «Строить»", async () => {
    await expect(page.getByTestId("card")).toBeVisible({ timeout: 30_000 });
    // FU-4: the answers message reads «вопрос? — ответ», never «?:».
    const answers = page.getByTestId("chat-message").filter({ hasText: "Как проверять билеты на входе?" });
    await expect(answers.first()).toContainText("на входе? — ");
    await expect(answers.first()).not.toContainText("?:");
    await expect(page.getByTestId("card-version")).toContainText("1");
    await expect(page.getByTestId("card-estimate")).toBeVisible();
    await expect(page.getByTestId("card-cap")).toBeVisible();
    expect(await page.getByTestId("card-acceptance-item").count()).toBeGreaterThanOrEqual(6);
    await shot(page, "03-card", true);
    await page.getByTestId("card-build").click();
  });

  await test.step("S4: журнал сборки до успеха, G0 и G1 passed", async () => {
    await expect(page.getByTestId("gate-row-G0")).toHaveAttribute("data-status", "passed", {
      timeout: 90_000,
    });
    await expect(page.getByTestId("gate-row-G1")).toHaveAttribute("data-status", "passed", {
      timeout: 90_000,
    });
    const steps = page.getByTestId("build-step");
    expect(await steps.count()).toBeGreaterThanOrEqual(6);
    await expect(steps.filter({ hasText: "в очереди" })).toHaveCount(0);
    await expect(page.getByTestId("run-error")).toHaveCount(0);
  });

  await test.step("превью: система форума для посетителя", async () => {
    await expect(page.getByTestId("preview-frame")).toBeVisible();
    await expect(preview.getByTestId("wz-appshell")).toContainText("Форум «Северный ритейл»", {
      timeout: 20_000,
    });
    await expect(preview.getByTestId("wz-catalog")).toBeVisible();
    await expect(preview.getByTestId("wz-appshell-user")).not.toContainText("Участник");
    await shot(page, "04-preview", true);
  });

  await test.step("«Стиль»: смена акцента меняет кнопки превью без перезагрузки", async () => {
    const cta = preview.getByTestId("wz-itemcard-cta").first();
    await expect(cta).toHaveCSS("background-color", ACCENT_BEFORE);
    const frameBefore = await previewFrame(page);
    await page.getByTestId("style-toggle").click();
    await expect(page.getByTestId("style-panel")).toBeVisible();
    await page.getByTestId(`style-accent-${ACCENT_AFTER.id}`).click();
    await expect(cta).toHaveCSS("background-color", ACCENT_AFTER.rgb, { timeout: 2_000 });
    expect(await previewFrame(page)).toBe(frameBefore);
    await expect(page.getByTestId("style-status")).toContainText("Сохранено", { timeout: 10_000 });
    await shot(page, "05-style");
    await page.getByTestId("style-toggle").click();
  });

  await test.step("организатор видит сканер в меню", async () => {
    await switchRole(page, preview, "organizer", "Организатор");
    await expect(preview.getByTestId("wz-appshell-nav")).toContainText("Сканер билетов");
  });

  let payload = "";
  await test.step("участник: регистрация с согласием, оплата-заглушка, QR-билет", async () => {
    await switchRole(page, preview, "participant", "Участник");
    await expect(preview.getByTestId("wz-appshell-nav")).not.toContainText("Сканер билетов");
    // FU-4: the draft seed is a realistic, not sold-out catalog — the participant buys the seeded «Стандарт».
    const card = preview
      .getByTestId("wz-itemcard")
      .filter({ has: preview.getByText("Стандарт", { exact: true }) });
    await expect(card).toHaveCount(1);
    await expect(preview.getByTestId("wz-catalog")).not.toContainText("Мест нет");
    await card.getByTestId("wz-itemcard-cta").click();
    await preview.getByRole("radio").first().check();
    await preview.locator('input[name="holderName"]').fill("Анна Тестова");
    await preview.locator('input[name="holderEmail"]').fill("guest@example.test");
    const submit = preview.getByRole("button", { name: "Оформить" });
    await expect(submit).toBeDisabled();
    await preview.getByRole("checkbox", { name: /Текст согласия предоставит юрист/ }).check();
    await shot(page, "06-register", true);
    await submit.click();
    await expect(preview.getByTestId("wz-pay-amount")).toContainText("4 900", { timeout: 15_000 });
    await preview.getByTestId("wz-pay-confirm").click();
    await expect(preview.getByTestId("wz-qrticket-code")).toBeVisible({ timeout: 15_000 });
    await shot(page, "07-ticket", true);
    payload = await decodeQr(await previewFrame(page));
    expect(payload.length).toBeGreaterThan(10);
  });

  await test.step("волонтёр: QR-проверка на входе — ok, повтор — duplicate", async () => {
    await switchRole(page, preview, "volunteer", "Волонтёр на входе");
    // FU-4: the route of the participant's ticket stays; the volunteer sees «нет доступа», not the login form,
    // and goes on to their start page.
    expect((await previewFrame(page)).url()).toContain("/ticket/");
    await expect(preview.getByTestId("wz-appshell-forbidden")).toBeVisible();
    await expect(preview.getByTestId("wz-login")).toHaveCount(0);
    await preview.getByTestId("wz-appshell-start").click();
    await expect(preview.getByTestId("wz-qrscanner-manual")).toBeVisible();
    const check = async () => {
      await preview.getByLabel("Код билета").fill(payload);
      await preview.getByTestId("wz-qrscanner-manual").getByRole("button", { name: "Проверить" }).click();
    };
    const result = preview.getByTestId("wz-qrscanner-result");
    await check();
    await expect(result).toHaveAttribute("data-status", "ok");
    await expect(result).toContainText("Проходите");
    await expect(result).toContainText(/Стандарт · \S/);
    await expect(result).not.toContainText("[object");
    await shot(page, "08-scan-ok", true);
    await check();
    await expect(result).toHaveAttribute("data-status", "duplicate");
    await expect(result).toContainText("Уже прошёл");
    await shot(page, "09-scan-duplicate");
  });

  expect(pageErrors).toEqual([]);
});
