// M3-01 «Укажи и измени» end to end on the forum demo (fixture LLM: demo/forum for the build, demo/forum.point_edit
// for the edit run, tools/fixtures/golden/forum.yaml#point_edit). Pick the heading in the preview → «сделай заголовок
// крупнее» → a point_edit build changes only the file of the picked component (revision diff = {ui/Landing.tsx}).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const RUNTIME = "http://127.0.0.1:4100";
const API = "http://127.0.0.1:4000/api/v1";
const FILE = "ui/Landing.tsx";

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

// biome-ignore lint/suspicious/noExplicitAny: API bodies are checked field by field
async function get(request: APIRequestContext, path: string): Promise<any> {
  const r = await request.get(`${API}${path}`);
  expect(r.status(), path).toBe(200);
  return r.json();
}

test.beforeAll(async ({ request }) => {
  await expect
    .poll(async () => (await request.get(`${RUNTIME}/_wizard/health`).catch(() => null))?.status(), {
      timeout: 60_000,
    })
    .toBe(200);
});

test("укажи и измени: заголовок в превью → «сделай заголовок крупнее» → меняется только файл элемента", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const preview = page.frameLocator('[data-testid="preview-frame"]');
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  let systemId = "";
  await test.step("форум собран как в демо (S1 → S4)", async () => {
    await page.goto("/");
    await page.getByTestId("start-prompt").fill(goldenBrief());
    await page.getByTestId("start-submit").click();
    await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/);
    systemId = page.url().split("/s/")[1] ?? "";
    await expect(page.getByTestId("question-card")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("question-option-email_or_telegram").click();
    await page.getByTestId("question-next").click();
    await page.getByTestId("question-option-qr_offline_scanner").click();
    await page.getByTestId("question-next").click();
    await page.getByTestId("question-accept-rest").click();
    await expect(page.getByTestId("card")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("card-build").click();
    await expect(page.getByTestId("gate-row-G1")).toHaveAttribute("data-status", "passed", {
      timeout: 120_000,
    });
    await expect(preview.getByTestId("wz-appshell")).toContainText("Форум «Северный ритейл»", {
      timeout: 20_000,
    });
  });

  const before = (await get(request, `/systems/${systemId}`)).system.draftRevision as number;

  await test.step("«Указать на экране»: наведение обводит компонент, клик выбирает его", async () => {
    await expect(page.getByTestId("select-toggle")).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId("select-toggle").click();
    await expect(page.getByTestId("select-banner")).toContainText("Режим «Укажи и измени»");
    const heading = preview.getByTestId("wz-appshell").locator("header a").first();
    await heading.hover();
    const hover = preview.locator('[data-wz-overlay="hover"]');
    await expect(hover).toBeVisible();
    await expect(hover).toContainText("AppShell");
    await heading.click();
    await expect(page.getByTestId("select-banner")).toHaveCount(0);
    // The click was swallowed by the bridge: the system did not navigate.
    await expect(preview.getByTestId("wz-catalog")).toBeVisible();
    await expect(preview.locator('[data-wz-overlay="selected"]').first()).toBeVisible();
    const chip = page.getByTestId("chat-target");
    await expect(chip).toContainText("Изменить: AppShell");
    await expect(page.getByTestId("chat-target-file")).toHaveText(/^ui\/Landing\.tsx:\d+$/);
    await expect(page.getByTestId("chat-target-excerpt")).toContainText("<AppShell>");
  });

  await test.step("«сделай заголовок крупнее» → прогон point_edit, G0/G1 как обычно", async () => {
    await page.getByTestId("chat-input").fill("сделай заголовок крупнее");
    await page.getByTestId("chat-send").click();
    await expect(page.getByTestId("chat-target")).toHaveCount(0);
    await expect(page.getByTestId("chat-message-target").last()).toHaveText(`AppShell · ${FILE}`);
    await expect
      .poll(
        async () => {
          const v = await get(request, `/systems/${systemId}`);
          return v.activeRunId == null && v.system.stage === "ready" && v.system.draftRevision > before;
        },
        { timeout: 150_000, intervals: [1000] },
      )
      .toBe(true);
    const msgs = (await get(request, `/systems/${systemId}/messages?limit=50`)).items;
    const req = [...msgs].reverse().find((m: { payload?: { target?: unknown } }) => m.payload?.target);
    expect(req.payload.target).toMatchObject({ componentName: "AppShell", file: FILE });
    const run = await get(request, `/runs/${req.runId}`);
    expect(run).toMatchObject({ kind: "build", mode: "point_edit", status: "succeeded" });
    const gates = (await get(request, `/systems/${systemId}/gates/latest`)).reports;
    expect(
      gates.filter((g: { level: string }) => g.level !== "G2").map((g: { passed: boolean }) => g.passed),
    ).toEqual([true, true]);
  });

  await test.step("diff ревизии = только файл выбранного компонента; превью показывает правку", async () => {
    const after = (await get(request, `/systems/${systemId}`)).system.draftRevision as number;
    const diff = await get(request, `/systems/${systemId}/revisions/${after}/diff?from=${before}`);
    expect(diff.changes).toEqual([{ kind: "file", text_ru: `Изменён файл ${FILE}` }]);
    const source = await (await request.get(`${API}/systems/${systemId}/files/${FILE}`)).text();
    expect(source).toContain('fontSize: "var(--w-font-size-xl)"');
    const h1 = preview.locator("h1", { hasText: "Форум «Северный ритейл»" });
    await expect(h1).toBeVisible({ timeout: 30_000 });
    const size = await h1.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    const brand = await preview
      .getByTestId("wz-appshell")
      .locator("header a")
      .first()
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThan(brand);
  });

  expect(pageErrors).toEqual([]);
});
